/**
 * PumpFun Graduation Listener
 *
 * Monitors the Pump.fun migration account via Solana WebSocket (onLogs)
 * to detect token graduations to PumpSwap / Raydium in real-time.
 *
 * When a token graduates:
 *   1. Parses the transaction for the token mint + new pool address
 *   2. Emits a graduation event with mint, pool, and destination DEX
 *   3. The engine picks it up as a high-priority candidate
 *
 * This is MUCH faster than polling DexScreener — we see graduations
 * within ~1-2 slots (400-800ms) of the on-chain event.
 */

import { Connection, PublicKey, ParsedTransactionWithMeta } from "@solana/web3.js";
import {
  PUMPFUN_MIGRATION,
  PUMPFUN_PROGRAM,
  PUMPSWAP_PROGRAM,
  RAYDIUM_AMM_V4,
  RAYDIUM_CPMM,
  SOL_MINT,
} from "./config";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface GraduationEvent {
  mint: string;
  poolAddress: string;
  dex: "pumpswap" | "raydium";
  signature: string;
  timestamp: number;
}

export type GraduationCallback = (event: GraduationEvent) => void;

// ═══════════════════════════════════════════════════════════════════════════════
// LISTENER
// ═══════════════════════════════════════════════════════════════════════════════

export class PumpFunListener {
  private connection: Connection;
  private subscriptionId: number | null = null;
  private callback: GraduationCallback;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 20;
  private isRunning = false;
  private processedSigs: Set<string> = new Set();
  private graduationCount = 0;

  // Known program IDs for classification
  private static PUMP_MIGRATION = new PublicKey(PUMPFUN_MIGRATION);
  private static PUMPSWAP = new PublicKey(PUMPSWAP_PROGRAM);
  private static RAYDIUM_V4 = new PublicKey(RAYDIUM_AMM_V4);
  private static RAYDIUM_CPMM = new PublicKey(RAYDIUM_CPMM);
  private static PUMPFUN = new PublicKey(PUMPFUN_PROGRAM);

  constructor(connection: Connection, callback: GraduationCallback) {
    this.connection = connection;
    this.callback = callback;
  }

  /**
   * Start listening for graduation events.
   * Uses onLogs to subscribe to the Pump.fun migration account.
   */
  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.reconnectAttempts = 0;
    console.log(`[pumpfun] 👂 Listening for graduations on ${PUMPFUN_MIGRATION.slice(0, 12)}...`);
    this.subscribe();
  }

  stop(): void {
    this.isRunning = false;
    if (this.subscriptionId !== null) {
      this.connection.removeOnLogsListener(this.subscriptionId).catch(() => {});
      this.subscriptionId = null;
    }
    console.log(`[pumpfun] Stopped. Total graduations detected: ${this.graduationCount}`);
  }

  getStats() {
    return {
      running: this.isRunning,
      graduations: this.graduationCount,
      reconnects: this.reconnectAttempts,
      processedTxs: this.processedSigs.size,
    };
  }

  // ─── SUBSCRIPTION ─────────────────────────────────────────────────────────

  private subscribe(): void {
    try {
      this.subscriptionId = this.connection.onLogs(
        PumpFunListener.PUMP_MIGRATION,
        async (logInfo) => {
          try {
            await this.handleLog(logInfo);
          } catch (err) {
            console.error("[pumpfun] Error handling log:", err);
          }
        },
        "confirmed"
      );
      console.log(`[pumpfun] ✓ Subscribed (id: ${this.subscriptionId})`);
    } catch (err) {
      console.error("[pumpfun] Subscribe failed:", err);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.isRunning) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("[pumpfun] Max reconnect attempts reached. Giving up.");
      return;
    }
    this.reconnectAttempts++;
    const delay = Math.min(2000 * Math.pow(1.5, this.reconnectAttempts), 60_000);
    console.log(`[pumpfun] Reconnecting in ${(delay / 1000).toFixed(0)}s (attempt ${this.reconnectAttempts})`);

    setTimeout(() => {
      if (this.isRunning) {
        // Clean up old subscription
        if (this.subscriptionId !== null) {
          this.connection.removeOnLogsListener(this.subscriptionId).catch(() => {});
          this.subscriptionId = null;
        }
        this.subscribe();
      }
    }, delay);
  }

  // ─── LOG PROCESSING ───────────────────────────────────────────────────────

  private async handleLog(logInfo: { signature: string; err: any; logs: string[] }): Promise<void> {
    // Skip errors and already-processed
    if (logInfo.err) return;
    if (this.processedSigs.has(logInfo.signature)) return;
    this.processedSigs.add(logInfo.signature);

    // Prevent memory leak — keep last 1000 sigs
    if (this.processedSigs.size > 1000) {
      const entries = [...this.processedSigs];
      for (let i = 0; i < entries.length - 500; i++) {
        this.processedSigs.delete(entries[i]);
      }
    }

    // Quick-filter via log messages: look for migration-related program invocations
    const logsStr = logInfo.logs.join(" ");
    const isPumpSwap = logsStr.includes(PUMPSWAP_PROGRAM);
    const isRaydium =
      logsStr.includes(RAYDIUM_AMM_V4) || logsStr.includes(RAYDIUM_CPMM);

    if (!isPumpSwap && !isRaydium) {
      // Not a graduation tx — could be other migration account activity
      return;
    }

    // Fetch full parsed transaction to extract mint + pool
    const event = await this.parseGraduationTx(logInfo.signature, isPumpSwap ? "pumpswap" : "raydium");
    if (event) {
      this.graduationCount++;
      console.log(
        `[pumpfun] 🎓 GRADUATION #${this.graduationCount}: ` +
        `${event.mint.slice(0, 12)}... → ${event.dex} ` +
        `pool: ${event.poolAddress.slice(0, 12)}...`
      );
      this.callback(event);
    }
  }

  /**
   * Parse a graduation transaction to extract the token mint and pool address.
   *
   * PumpSwap migrations: Pump.fun program calls `migrate` instruction →
   *   creates a PumpSwap AMM pool. The token mint is in the instruction accounts,
   *   and the pool is the new account created.
   *
   * Raydium migrations (legacy): Migration account calls Raydium `initialize2` →
   *   the token mint is paired against SOL in the new AMM pool.
   */
  private async parseGraduationTx(
    signature: string,
    dex: "pumpswap" | "raydium"
  ): Promise<GraduationEvent | null> {
    try {
      const tx = await this.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      if (!tx?.meta || tx.meta.err) return null;

      let mint: string | null = null;
      let poolAddress: string | null = null;

      if (dex === "pumpswap") {
        // PumpSwap: look for the token mint in inner instructions or account keys
        // The migration creates a new pool — find the non-SOL mint
        const result = this.extractPumpSwapMigration(tx);
        mint = result.mint;
        poolAddress = result.pool;
      } else {
        // Raydium: look for initialize2 instruction
        const result = this.extractRaydiumMigration(tx);
        mint = result.mint;
        poolAddress = result.pool;
      }

      if (!mint) return null;

      return {
        mint,
        poolAddress: poolAddress ?? "",
        dex,
        signature,
        timestamp: Date.now(),
      };
    } catch (err) {
      console.error(`[pumpfun] Failed to parse tx ${signature.slice(0, 16)}:`, err);
      return null;
    }
  }

  /**
   * Extract mint + pool from a PumpSwap migration transaction.
   *
   * Strategy: Look at the token balances in postTokenBalances.
   * The non-SOL token that changed is the graduated token.
   * The pool is typically a newly created account (one of the writable accounts).
   */
  private extractPumpSwapMigration(tx: ParsedTransactionWithMeta): { mint: string | null; pool: string | null } {
    let mint: string | null = null;
    let pool: string | null = null;

    // Strategy 1: Look at postTokenBalances for non-SOL, non-USDC mints
    const tokenBalances = tx.meta?.postTokenBalances ?? [];
    const mints = new Set<string>();
    for (const tb of tokenBalances) {
      if (tb.mint && tb.mint !== SOL_MINT && tb.mint !== "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v") {
        mints.add(tb.mint);
      }
    }

    // Usually there's exactly one non-SOL mint — that's our token
    if (mints.size === 1) {
      mint = [...mints][0];
    } else if (mints.size > 1) {
      // Multiple mints: pick the one that's NOT Wrapped SOL
      for (const m of mints) {
        if (m !== "So11111111111111111111111111111111111111112") {
          mint = m;
          break;
        }
      }
    }

    // Strategy 2: Find pool address from account keys
    // The pool is typically the account owned by PumpSwap program
    const accountKeys = tx.transaction.message.accountKeys;
    for (const key of accountKeys) {
      const owner = (key as any).owner;
      if (typeof owner === "string" && owner === PUMPSWAP_PROGRAM) {
        pool = typeof key === "string" ? key : key.pubkey.toBase58();
        break;
      }
    }

    // Fallback: look at inner instructions for PumpSwap program
    if (!pool) {
      const innerInstructions = tx.meta?.innerInstructions ?? [];
      for (const inner of innerInstructions) {
        for (const ix of inner.instructions) {
          const programId = "programId" in ix
            ? (typeof ix.programId === "string" ? ix.programId : ix.programId.toBase58())
            : null;
          if (programId === PUMPSWAP_PROGRAM) {
            // The first writable account after the program is often the pool
            if ("accounts" in ix && Array.isArray(ix.accounts) && ix.accounts.length > 0) {
              pool = typeof ix.accounts[0] === "string"
                ? ix.accounts[0]
                : ix.accounts[0].toBase58();
            }
            break;
          }
        }
        if (pool) break;
      }
    }

    return { mint, pool };
  }

  /**
   * Extract mint + pool from a Raydium migration transaction (legacy path).
   *
   * Raydium initialize2 creates an AMM pool:
   *   - Account[4] is typically the AMM pool
   *   - The token mint is one of the two mints (not SOL)
   */
  private extractRaydiumMigration(tx: ParsedTransactionWithMeta): { mint: string | null; pool: string | null } {
    let mint: string | null = null;
    let pool: string | null = null;

    // Same strategy: postTokenBalances for the non-SOL mint
    const tokenBalances = tx.meta?.postTokenBalances ?? [];
    for (const tb of tokenBalances) {
      if (tb.mint && tb.mint !== SOL_MINT && tb.mint !== "So11111111111111111111111111111111111111112") {
        mint = tb.mint;
        break;
      }
    }

    // Pool: look for Raydium program invocation
    const instructions = tx.transaction.message.instructions;
    for (const ix of instructions) {
      const programId = "programId" in ix
        ? (typeof ix.programId === "string" ? ix.programId : ix.programId.toBase58())
        : null;
      if (programId === RAYDIUM_AMM_V4 || programId === RAYDIUM_CPMM) {
        // For Raydium V4 initialize2, the AMM account is typically index 4
        if ("accounts" in ix && Array.isArray(ix.accounts) && ix.accounts.length > 4) {
          pool = typeof ix.accounts[4] === "string"
            ? ix.accounts[4]
            : ix.accounts[4].toBase58();
        }
        break;
      }
    }

    return { mint, pool };
  }
}
