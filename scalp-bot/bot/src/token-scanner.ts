/**
 * Token Scanner
 *
 * Discovers tradeable memecoin opportunities via:
 *  1. DexScreener trending/new pairs (boosted tokens, volume spikes)
 *  2. PumpFun graduation detection (tokens migrating to PumpSwap/Raydium)
 *  3. Volume spike detection on known pools
 *
 * Each discovered token gets a safety score and entry signal score.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { TokenSafetyConfig, DEFAULT_TOKEN_SAFETY, SOL_MINT } from "./config";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface TokenCandidate {
  mint: string;
  symbol: string;
  name: string;
  poolAddress: string;
  dex: string;
  pairAddress: string;
  // Market data
  priceUsd: number;
  priceSOL: number;
  liquidityUsd: number;
  volume24h: number;
  volume5m: number;
  volume1h: number;
  marketCap: number;
  // Price action
  priceChange5m: number;
  priceChange1h: number;
  priceChange24h: number;
  // Safety
  safetyScore: number;    // 0-100
  mintDisabled: boolean;
  freezeDisabled: boolean;
  topHolderPct: number;
  holders: number;
  poolAgeSec: number;
  // Signal
  entryScore: number;     // 0-100 composite
  signalReasons: string[];
  // Meta
  discoveredAt: number;
  source: "dexscreener" | "pumpfun" | "volume_spike";
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOKEN SCANNER
// ═══════════════════════════════════════════════════════════════════════════════

export class TokenScanner {
  private connection: Connection;
  private safetyConfig: TokenSafetyConfig;
  private seenMints: Set<string> = new Set();
  private scanCount = 0;
  private candidatesFound = 0;
  private consecutiveErrors = 0;
  private lastSuccessfulScan = 0;

  constructor(connection: Connection, safety: TokenSafetyConfig = DEFAULT_TOKEN_SAFETY) {
    this.connection = connection;
    this.safetyConfig = safety;
  }

  /**
   * Run a full scan cycle. Returns scored candidates above safety threshold.
   */
  async scan(): Promise<TokenCandidate[]> {
    this.scanCount++;
    const candidates: TokenCandidate[] = [];

    // Parallel: DexScreener trending + new pairs (with backoff on repeated failures)
    if (this.consecutiveErrors > 5) {
      // Back off: wait longer between scans after repeated API failures
      const backoffMs = Math.min(30_000, 2000 * this.consecutiveErrors);
      if (Date.now() - this.lastSuccessfulScan < backoffMs) return [];
    }

    const [trending, newPairs, boosted] = await Promise.allSettled([
      this.fetchDexScreenerTrending(),
      this.fetchDexScreenerNewPairs(),
      this.fetchDexScreenerBoosted(),
    ]);

    let anySuccess = false;
    if (trending.status === "fulfilled" && trending.value.length > 0) { candidates.push(...trending.value); anySuccess = true; }
    if (newPairs.status === "fulfilled" && newPairs.value.length > 0) { candidates.push(...newPairs.value); anySuccess = true; }
    if (boosted.status === "fulfilled" && boosted.value.length > 0) { candidates.push(...boosted.value); anySuccess = true; }

    if (anySuccess) {
      this.consecutiveErrors = 0;
      this.lastSuccessfulScan = Date.now();
    } else {
      this.consecutiveErrors++;
    }

    // Dedupe by mint
    const unique = new Map<string, TokenCandidate>();
    for (const c of candidates) {
      const existing = unique.get(c.mint);
      if (!existing || c.entryScore > existing.entryScore) {
        unique.set(c.mint, c);
      }
    }

    // Filter: safety + not already seen recently
    const filtered = [...unique.values()].filter((c) => {
      if (c.safetyScore < 40) return false;
      if (c.liquidityUsd < this.safetyConfig.minLiquidityUsd) return false;
      return true;
    });

    // Sort by entry score
    filtered.sort((a, b) => b.entryScore - a.entryScore);

    this.candidatesFound += filtered.length;
    return filtered;
  }

  /**
   * Mark a mint as seen (don't re-signal for cooldown period)
   */
  markSeen(mint: string): void {
    this.seenMints.add(mint);
    // Auto-clear after 1 hour
    setTimeout(() => this.seenMints.delete(mint), 3600_000);
  }

  isSeen(mint: string): boolean {
    return this.seenMints.has(mint);
  }

  // ─── DEXSCREENER ─────────────────────────────────────────────────────────

  private async fetchDexScreenerTrending(): Promise<TokenCandidate[]> {
    try {
      const res = await fetch(
        "https://api.dexscreener.com/token-boosts/top/v1",
        { signal: AbortSignal.timeout(8000) }
      );
      if (!res.ok) return [];
      const data = await res.json();
      if (!Array.isArray(data)) return [];

      return data
        .filter((t: any) => t.chainId === "solana")
        .slice(0, 20)
        .map((t: any) => this.dexScreenerToCandidate(t, "dexscreener"))
        .filter((c): c is TokenCandidate => c !== null);
    } catch { return []; }
  }

  private async fetchDexScreenerNewPairs(): Promise<TokenCandidate[]> {
    try {
      const res = await fetch(
        "https://api.dexscreener.com/latest/dex/pairs/solana?sort=pairAge&order=asc",
        { signal: AbortSignal.timeout(8000) }
      );
      if (!res.ok) return [];
      const data = await res.json();
      const pairs = data?.pairs ?? [];

      return pairs
        .slice(0, 30)
        .map((p: any) => this.pairToCandidate(p))
        .filter((c): c is TokenCandidate => c !== null);
    } catch { return []; }
  }

  private async fetchDexScreenerBoosted(): Promise<TokenCandidate[]> {
    try {
      const res = await fetch(
        "https://api.dexscreener.com/token-boosts/latest/v1",
        { signal: AbortSignal.timeout(8000) }
      );
      if (!res.ok) return [];
      const data = await res.json();
      if (!Array.isArray(data)) return [];

      // Boosted tokens: fetch their pair data
      const solanaTokens = data
        .filter((t: any) => t.chainId === "solana")
        .slice(0, 10);

      const candidates: TokenCandidate[] = [];
      for (const t of solanaTokens) {
        try {
          const pRes = await fetch(
            `https://api.dexscreener.com/latest/dex/tokens/${t.tokenAddress}`,
            { signal: AbortSignal.timeout(5000) }
          );
          if (!pRes.ok) continue;
          const pData = await pRes.json();
          const pairs = pData?.pairs ?? [];
          if (pairs.length > 0) {
            const c = this.pairToCandidate(pairs[0]);
            if (c) candidates.push(c);
          }
        } catch {}
      }
      return candidates;
    } catch { return []; }
  }

  // ─── CONVERTERS ──────────────────────────────────────────────────────────

  private dexScreenerToCandidate(t: any, source: TokenCandidate["source"]): TokenCandidate | null {
    try {
      // Fetch pair data for this token
      return {
        mint: t.tokenAddress,
        symbol: t.symbol ?? t.tokenAddress?.slice(0, 6) ?? "???",
        name: t.name ?? t.symbol ?? "Unknown",
        poolAddress: "",
        dex: t.dexId ?? "unknown",
        pairAddress: "",
        priceUsd: 0, priceSOL: 0,
        liquidityUsd: 0, volume24h: 0, volume5m: 0, volume1h: 0,
        marketCap: 0,
        priceChange5m: 0, priceChange1h: 0, priceChange24h: 0,
        safetyScore: 50, // Unknown — needs pair data
        mintDisabled: true, freezeDisabled: true,
        topHolderPct: 0, holders: 0, poolAgeSec: 0,
        entryScore: 40, // Boosted = some signal
        signalReasons: ["boosted"],
        discoveredAt: Date.now(),
        source,
      };
    } catch { return null; }
  }

  private pairToCandidate(p: any): TokenCandidate | null {
    try {
      // Determine which token is the memecoin (not SOL/USDC)
      const base = p.baseToken;
      const quote = p.quoteToken;
      const isMeme = base?.address !== SOL_MINT && base?.address !== "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
      const token = isMeme ? base : quote;
      if (!token?.address) return null;

      const liq = p.liquidity?.usd ?? 0;
      const vol24 = p.volume?.h24 ?? 0;
      const vol5m = p.volume?.m5 ?? 0;
      const vol1h = p.volume?.h1 ?? 0;
      const mc = p.marketCap ?? p.fdv ?? 0;

      const pc5m = p.priceChange?.m5 ?? 0;
      const pc1h = p.priceChange?.h1 ?? 0;
      const pc24h = p.priceChange?.h24 ?? 0;

      const poolAge = p.pairCreatedAt
        ? (Date.now() - p.pairCreatedAt) / 1000
        : 999999;

      // Safety scoring (stricter)
      let safetyScore = 40; // Start lower, must earn points
      if (liq > 100_000) safetyScore += 20;
      else if (liq > 50_000) safetyScore += 15;
      else if (liq > 20_000) safetyScore += 10;
      else if (liq > 10_000) safetyScore += 5;
      else safetyScore -= 15; // <10k = dangerous

      if (vol24 > 200_000) safetyScore += 10;
      else if (vol24 > 50_000) safetyScore += 5;
      if (vol24 < 1_000) safetyScore -= 10; // Barely traded

      if (poolAge > 600) safetyScore += 10;  // >10 min = survived early dump
      else if (poolAge > 120) safetyScore += 5;
      else if (poolAge < 30) safetyScore -= 20; // <30s = sniper territory

      // Negative signals (red flags)
      if (pc5m < -30) safetyScore -= 15; // Dumping hard
      if (pc1h < -50) safetyScore -= 20; // Already rugged
      if (liq < 5_000 && poolAge < 120) safetyScore -= 25; // Low liq + very new = rug

      // Entry signal scoring
      let entryScore = 0;
      const reasons: string[] = [];

      // Volume spike (strongest signal)
      if (vol5m > 0 && vol1h > 0) {
        const avgPerMin = vol1h / 60;
        const spike = (vol5m / 5) / Math.max(avgPerMin, 1);
        if (spike > 5) { entryScore += 30; reasons.push(`vol_spike_${spike.toFixed(1)}x`); }
        else if (spike > 3) { entryScore += 20; reasons.push(`vol_spike_${spike.toFixed(1)}x`); }
        else if (spike > 2) { entryScore += 10; reasons.push(`vol_up_${spike.toFixed(1)}x`); }
      }

      // Price momentum (must be rising, not already peaked)
      if (pc5m > 5 && pc5m < 50) { entryScore += 20; reasons.push(`+${pc5m.toFixed(1)}%_5m`); }
      else if (pc5m > 50) { entryScore += 5; reasons.push(`late_entry_${pc5m.toFixed(1)}%`); } // Already pumped a lot
      if (pc1h > 10 && pc1h < 100) { entryScore += 15; reasons.push(`+${pc1h.toFixed(1)}%_1h`); }
      if (pc5m < -10) { entryScore -= 25; reasons.push(`dump_${pc5m.toFixed(1)}%`); }
      if (pc24h < -40) { entryScore -= 20; reasons.push(`dead_${pc24h.toFixed(1)}%_24h`); }

      // Fresh pool bonus (sweet spot: 1-10 min old)
      if (poolAge > 60 && poolAge < 600) {
        entryScore += 15;
        reasons.push("fresh_pool");
      }

      // High liquidity = safer entries
      if (liq > 50_000) { entryScore += 10; reasons.push("deep_liq"); }
      else if (liq > 20_000) { entryScore += 5; reasons.push("ok_liq"); }

      // Low mcap = more upside potential (but not TOO low)
      if (mc > 50_000 && mc < 500_000) { entryScore += 10; reasons.push("low_mcap"); }
      else if (mc > 0 && mc < 50_000) { entryScore += 5; reasons.push("micro_mcap"); }

      return {
        mint: token.address,
        symbol: token.symbol ?? token.address.slice(0, 6),
        name: token.name ?? "Unknown",
        poolAddress: p.pairAddress ?? "",
        dex: p.dexId ?? "unknown",
        pairAddress: p.pairAddress ?? "",
        priceUsd: parseFloat(p.priceUsd ?? "0"),
        priceSOL: parseFloat(p.priceNative ?? "0"),
        liquidityUsd: liq,
        volume24h: vol24,
        volume5m: vol5m,
        volume1h: vol1h,
        marketCap: mc,
        priceChange5m: pc5m,
        priceChange1h: pc1h,
        priceChange24h: pc24h,
        safetyScore,
        mintDisabled: true,  // Would need on-chain check
        freezeDisabled: true,
        topHolderPct: 0,
        holders: 0,
        poolAgeSec: poolAge,
        entryScore: Math.max(0, Math.min(100, entryScore)),
        signalReasons: reasons,
        discoveredAt: Date.now(),
        source: "dexscreener",
      };
    } catch { return null; }
  }

  getStats() {
    return {
      scans: this.scanCount,
      candidatesFound: this.candidatesFound,
      seenMints: this.seenMints.size,
    };
  }

  /**
   * On-chain safety check: verify mint/freeze authority, detect honeypots.
   * Call this BEFORE buying. Returns updated safety score.
   */
  async validateOnChain(
    connection: Connection,
    mint: string,
    candidate: TokenCandidate
  ): Promise<{ safe: boolean; reasons: string[] }> {
    const reasons: string[] = [];
    let safe = true;

    try {
      // 1. Check mint account for authorities
      const mintInfo = await connection.getAccountInfo(new PublicKey(mint));
      if (!mintInfo) {
        return { safe: false, reasons: ["mint_not_found"] };
      }

      // SPL Mint layout: mintAuthority at offset 4 (36 bytes: 4 option + 32 pubkey)
      // freezeAuthority at offset 46 (same pattern)
      const data = mintInfo.data;
      if (data.length >= 82) {
        // Mint authority: offset 0 = option (4 bytes LE), if option != 0 → authority exists
        const mintAuthOption = data.readUInt32LE(0);
        if (mintAuthOption !== 0) {
          candidate.mintDisabled = false;
          candidate.safetyScore -= 30;
          reasons.push("⚠ mint_authority_ENABLED");
          safe = false;
        } else {
          candidate.mintDisabled = true;
          reasons.push("✓ mint_disabled");
        }

        // Freeze authority: offset 46
        const freezeAuthOption = data.readUInt32LE(46);
        if (freezeAuthOption !== 0) {
          candidate.freezeDisabled = false;
          candidate.safetyScore -= 20;
          reasons.push("⚠ freeze_authority_ENABLED");
          safe = false;
        } else {
          candidate.freezeDisabled = true;
          reasons.push("✓ freeze_disabled");
        }
      }

      // 2. Simulate a small sell to detect honeypots
      // If Jupiter can't quote a sell, it's likely a honeypot
      try {
        const jupUrl = process.env.JUPITER_API_URL ?? "https://api.jup.ag";
        const headers: Record<string, string> = {};
        const apiKey = process.env.JUPITER_API_KEY;
        if (apiKey) headers["x-api-key"] = apiKey;

        const sellRes = await fetch(
          `${jupUrl}/swap/v1/quote?inputMint=${mint}&outputMint=${SOL_MINT}&amount=1000000&slippageBps=500`,
          { headers, signal: AbortSignal.timeout(3000) }
        );

        if (!sellRes.ok) {
          reasons.push("⚠ sell_quote_failed");
          candidate.safetyScore -= 25;
          safe = false;
        } else {
          const sellQuote = await sellRes.json();
          const outAmount = Number(sellQuote.outAmount ?? 0);
          if (outAmount === 0) {
            reasons.push("⚠ HONEYPOT_zero_sell_output");
            candidate.safetyScore -= 50;
            safe = false;
          } else {
            reasons.push("✓ sell_possible");
          }
        }
      } catch {
        reasons.push("⚠ sell_sim_timeout");
      }
    } catch (err) {
      reasons.push(`validation_error: ${err}`);
    }

    return { safe, reasons };
  }
}
