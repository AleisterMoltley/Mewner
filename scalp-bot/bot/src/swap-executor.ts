/**
 * Swap Executor
 *
 * Builds and submits Jupiter swaps via Jito bundles.
 * Used for both BUY (SOL → Token) and SELL (Token → SOL).
 *
 * Features:
 *  - Jupiter V1 API (new endpoint)
 *  - Jito bundle with dynamic tip
 *  - Pre-sim validation
 *  - API key support
 *  - forJitoBundle=true for compatible routing
 */

import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  SystemProgram,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { MultiEndpointSubmitter } from "./multi-endpoint";
import { SOL_MINT } from "./config";

// Jito tip accounts
const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4bVqkfRtQ7NmXwkiSgMYbas",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSLGCzQ8Bs52pZuF6Hz",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

export interface SwapResult {
  success: boolean;
  signature: string | null;
  amountIn: number;
  amountOut: number;
  error: string | null;
}

export class SwapExecutor {
  private connection: Connection;
  private wallet: Keypair;
  private jupiterUrl: string;
  private submitter: MultiEndpointSubmitter;

  constructor(
    connection: Connection,
    wallet: Keypair,
    jupiterUrl: string,
    submitter: MultiEndpointSubmitter
  ) {
    this.connection = connection;
    this.wallet = wallet;
    this.jupiterUrl = jupiterUrl;
    this.submitter = submitter;
  }

  /**
   * Buy a token: SOL → Token
   * Slippage is dynamic based on liquidity.
   */
  async buy(
    tokenMint: string,
    amountSOL: number,
    slippageBps: number = 100,
    dryRun: boolean = true,
    liquidityUsd: number = 0
  ): Promise<SwapResult> {
    // Dynamic slippage: tighter for deep pools, wider for thin
    const dynSlippage = this.dynamicSlippage(amountSOL * 150, liquidityUsd, slippageBps);
    const amountLamports = Math.floor(amountSOL * 1e9);
    return this.swap(SOL_MINT, tokenMint, amountLamports, dynSlippage, dryRun, "BUY");
  }

  /**
   * Sell a token (or fraction): Token → SOL
   * Higher slippage to ensure exit.
   */
  async sell(
    tokenMint: string,
    amountTokens: number,
    decimals: number = 9,
    slippageBps: number = 200,
    dryRun: boolean = true
  ): Promise<SwapResult> {
    const amountRaw = Math.floor(amountTokens * (10 ** decimals));
    return this.swap(tokenMint, SOL_MINT, amountRaw, slippageBps, dryRun, "SELL");
  }

  /**
   * Dynamic slippage: scale based on trade size vs pool liquidity.
   * Small trade in deep pool = tight slippage.
   * Large trade in thin pool = wider slippage.
   */
  private dynamicSlippage(tradeSizeUsd: number, liquidityUsd: number, fallback: number): number {
    if (liquidityUsd <= 0) return fallback;
    const impactPct = (tradeSizeUsd / liquidityUsd) * 100;
    if (impactPct < 0.1) return 50;   // <0.1% of pool → 0.5% slippage
    if (impactPct < 0.5) return 100;  // <0.5% → 1%
    if (impactPct < 1.0) return 150;  // <1% → 1.5%
    if (impactPct < 2.0) return 250;  // <2% → 2.5%
    return 400;                        // >2% → 4% (risky)
  }

  /**
   * Core swap logic: get quote → build TX → simulate → submit via Jito
   */
  private async swap(
    inputMint: string,
    outputMint: string,
    amount: number,
    slippageBps: number,
    dryRun: boolean,
    label: string
  ): Promise<SwapResult> {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const apiKey = process.env.JUPITER_API_KEY;
      if (apiKey) headers["x-api-key"] = apiKey;

      // 1. Get quote
      const qRes = await fetch(
        `${this.jupiterUrl}/swap/v1/quote?` +
        `inputMint=${inputMint}&outputMint=${outputMint}` +
        `&amount=${amount}&slippageBps=${slippageBps}` +
        `&restrictIntermediateTokens=true&forJitoBundle=true`,
        { headers, signal: AbortSignal.timeout(5000) }
      );
      if (!qRes.ok) {
        return { success: false, signature: null, amountIn: 0, amountOut: 0, error: `Quote failed: ${qRes.status}` };
      }
      const quote = await qRes.json();

      const outAmount = Number(quote.outAmount ?? 0);
      const inAmount = Number(quote.inAmount ?? amount);

      if (dryRun) {
        console.log(
          `[swap] DRY RUN ${label}: ${inputMint.slice(0, 6)} → ${outputMint.slice(0, 6)} ` +
          `in=${inAmount} out=${outAmount}`
        );
        return { success: true, signature: "DRY_RUN", amountIn: inAmount, amountOut: outAmount, error: null };
      }

      // 2. Build swap TX
      const sRes = await fetch(`${this.jupiterUrl}/swap/v1/swap`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: this.wallet.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: "auto",
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!sRes.ok) {
        return { success: false, signature: null, amountIn: inAmount, amountOut: outAmount, error: `Swap build failed: ${sRes.status}` };
      }
      const swapData = await sRes.json();
      if (!swapData.swapTransaction) {
        return { success: false, signature: null, amountIn: inAmount, amountOut: outAmount, error: "No swapTransaction in response" };
      }

      // 3. Deserialize and sign
      const txBuf = Buffer.from(swapData.swapTransaction, "base64");
      const tx = VersionedTransaction.deserialize(txBuf);
      tx.sign([this.wallet]);

      // 4. Simulate
      const sim = await this.connection.simulateTransaction(tx, {
        sigVerify: false,
        replaceRecentBlockhash: true,
      });
      if (sim.value.err) {
        const logs = sim.value.logs?.slice(-3).join(" | ") ?? "";
        return { success: false, signature: null, amountIn: inAmount, amountOut: outAmount, error: `Sim failed: ${JSON.stringify(sim.value.err)} ${logs}` };
      }

      // 5. Build tip TX
      const tipLamports = Math.max(1000, Math.floor(outAmount * 0.001)); // 0.1% tip
      const tipTx = await this.buildTipTx(tipLamports);

      // 6. Submit bundle
      const swapSerialized = tx.serialize();
      const result = await this.submitter.submitBundle(
        [swapSerialized, tipTx],
        outAmount
      );

      if (result.landed) {
        console.log(`[swap] ✅ ${label} LANDED via ${result.endpoint} — tip: ${result.tipLamports} lam`);
        return { success: true, signature: result.bundleId, amountIn: inAmount, amountOut: outAmount, error: null };
      } else {
        return { success: false, signature: result.bundleId, amountIn: inAmount, amountOut: outAmount, error: "Bundle not landed" };
      }
    } catch (err: any) {
      return { success: false, signature: null, amountIn: 0, amountOut: 0, error: err.message ?? "Unknown error" };
    }
  }

  private async buildTipTx(tipLamports: number): Promise<Uint8Array> {
    const tipAccount = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
    const { blockhash } = await this.connection.getLatestBlockhash("confirmed");

    const ix = SystemProgram.transfer({
      fromPubkey: this.wallet.publicKey,
      toPubkey: new PublicKey(tipAccount),
      lamports: tipLamports,
    });

    const msg = new TransactionMessage({
      payerKey: this.wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
        ix,
      ],
    }).compileToV0Message();

    const tx = new VersionedTransaction(msg);
    tx.sign([this.wallet]);
    return tx.serialize();
  }
}
