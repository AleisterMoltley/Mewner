/**
 * Holder & LP Analysis
 *
 * On-chain checks that the token-scanner was missing:
 *   1. Top-holder concentration (via getTokenLargestAccounts)
 *   2. Holder count estimate (via getTokenSupply + largest accounts)
 *   3. LP token burn/lock check (is liquidity locked?)
 *
 * These use standard Solana RPC calls — no external APIs needed.
 * Works with any RPC including Helius.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import {
  SOL_MINT,
  PUMPSWAP_PROGRAM,
  RAYDIUM_AMM_V4,
  RAYDIUM_CPMM,
} from "./config";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface HolderAnalysis {
  /** Top holder % of circulating supply */
  topHolderPct: number;
  /** Top-5 combined % */
  top5HolderPct: number;
  /** Top-10 combined % */
  top10HolderPct: number;
  /** Estimated number of holders (from largest accounts response) */
  holderCountEstimate: number;
  /** Whether the top holder is likely a pool/AMM (excluded from concentration) */
  topHolderIsPool: boolean;
  /** Reasons/notes */
  reasons: string[];
}

export interface LPAnalysis {
  /** Whether LP tokens appear burned (sent to dead address / zero-authority) */
  lpBurned: boolean;
  /** Whether LP tokens are locked in a known locker */
  lpLocked: boolean;
  /** Percentage of LP tokens held by top holder */
  lpTopHolderPct: number;
  /** Reasons/notes */
  reasons: string[];
}

// Known "dead" / burn addresses
const BURN_ADDRESSES = new Set([
  "1111111111111111111111111111111111",
  "1nc1nerator11111111111111111111111111111111",
  "deaddeaddeaddeaddeaddeaddeaddeaddeaddeaddead",
  // Common Solana burn address
  "11111111111111111111111111111111",
]);

// Known LP locker programs
const LP_LOCKER_PROGRAMS = new Set([
  // Uncx / Team Finance on Solana
  "2r5VekMNiWPzi1pWwvJczrdPaZnJG59u91unSrTunwJg",
  // Streamflow
  "strmRqUCoQUgGUFGYaLbfP4TfGksLwMEwEk7Pj6fkXg",
  // Raydium lock
  "LockuPRMHhFiXY5Y7eGSR4HM9ggFVpCwyuPQfkFm5Jp",
]);

// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Analyze holder distribution for a token.
 * Uses getTokenLargestAccounts (returns top 20) + getTokenSupply.
 *
 * Excludes known pool/AMM addresses from concentration calculation
 * since pool-held tokens are liquidity, not whale bags.
 */
export async function analyzeHolders(
  connection: Connection,
  mint: string
): Promise<HolderAnalysis> {
  const result: HolderAnalysis = {
    topHolderPct: 0,
    top5HolderPct: 0,
    top10HolderPct: 0,
    holderCountEstimate: 0,
    topHolderIsPool: false,
    reasons: [],
  };

  try {
    // Fetch in parallel
    const [largestRes, supplyRes] = await Promise.all([
      connection.getTokenLargestAccounts(new PublicKey(mint)),
      connection.getTokenSupply(new PublicKey(mint)),
    ]);

    const largest = largestRes.value;
    const totalSupplyRaw = Number(supplyRes.value.amount);

    if (totalSupplyRaw === 0 || largest.length === 0) {
      result.reasons.push("no_supply_data");
      return result;
    }

    // Estimate holder count: if all 20 slots are filled, there are likely more
    result.holderCountEstimate = largest.length >= 20 ? 100 : largest.length; // rough lower bound

    // Identify which accounts are likely pool/AMM addresses
    // We check if the owner is a known AMM program
    const poolAccounts = new Set<string>();
    const accountInfos = await fetchAccountOwners(connection, largest.map(l => l.address));

    for (let i = 0; i < largest.length; i++) {
      const owner = accountInfos[i];
      if (owner && isPoolProgram(owner)) {
        poolAccounts.add(largest[i].address);
      }
    }

    // Calculate concentrations excluding pool accounts
    let nonPoolAccounts = largest.filter(a => !poolAccounts.has(a.address));

    // If ALL accounts are pool accounts, use them anyway (shouldn't happen)
    if (nonPoolAccounts.length === 0) {
      nonPoolAccounts = largest;
    }

    // Sort by amount descending
    nonPoolAccounts.sort((a, b) => Number(b.amount) - Number(a.amount));

    // Calculate percentages
    const topPct = (amt: number) => (amt / totalSupplyRaw) * 100;

    if (nonPoolAccounts.length > 0) {
      result.topHolderPct = topPct(Number(nonPoolAccounts[0].amount));
      result.topHolderIsPool = poolAccounts.has(largest[0]?.address ?? "");
    }

    // Top-5
    const top5Sum = nonPoolAccounts
      .slice(0, 5)
      .reduce((sum, a) => sum + Number(a.amount), 0);
    result.top5HolderPct = topPct(top5Sum);

    // Top-10
    const top10Sum = nonPoolAccounts
      .slice(0, 10)
      .reduce((sum, a) => sum + Number(a.amount), 0);
    result.top10HolderPct = topPct(top10Sum);

    // Generate reasons
    if (result.topHolderPct > 20) {
      result.reasons.push(`⚠ top_holder_${result.topHolderPct.toFixed(1)}%`);
    } else if (result.topHolderPct > 10) {
      result.reasons.push(`⚠ top_holder_${result.topHolderPct.toFixed(1)}%_moderate`);
    } else {
      result.reasons.push(`✓ top_holder_${result.topHolderPct.toFixed(1)}%`);
    }

    if (result.top10HolderPct > 50) {
      result.reasons.push(`⚠ top10_${result.top10HolderPct.toFixed(1)}%_concentrated`);
    }

    if (result.holderCountEstimate < 50) {
      result.reasons.push(`⚠ few_holders_~${result.holderCountEstimate}`);
    } else {
      result.reasons.push(`✓ holders_≥${result.holderCountEstimate}`);
    }

  } catch (err) {
    result.reasons.push(`holder_check_error: ${err}`);
  }

  return result;
}

/**
 * Check if LP tokens are burned or locked.
 *
 * For PumpSwap pools: LP is auto-managed, no separate LP token.
 * For Raydium V4 pools: LP mint exists — check if burned or locked.
 *
 * @param poolAddress The AMM pool / pair address
 * @param dex Which DEX the pool is on
 */
export async function analyzeLiquidity(
  connection: Connection,
  poolAddress: string,
  dex: string
): Promise<LPAnalysis> {
  const result: LPAnalysis = {
    lpBurned: false,
    lpLocked: false,
    lpTopHolderPct: 0,
    reasons: [],
  };

  try {
    // PumpSwap: liquidity is protocol-managed, no separate LP token to burn
    if (dex === "pumpswap" || dex.includes("pump")) {
      result.reasons.push("✓ pumpswap_protocol_managed_lp");
      // PumpSwap pools have protocol-managed liquidity — no LP token to rug
      // This is actually safer from a rug perspective
      return result;
    }

    // Raydium V4: try to find the LP mint from the pool account data
    if (dex === "raydium" || dex.includes("raydium")) {
      const lpMint = await findRaydiumLPMint(connection, poolAddress);
      if (!lpMint) {
        result.reasons.push("⚠ lp_mint_not_found");
        return result;
      }

      // Check LP token largest holders
      const lpLargest = await connection.getTokenLargestAccounts(new PublicKey(lpMint));
      const lpSupply = await connection.getTokenSupply(new PublicKey(lpMint));
      const totalLPRaw = Number(lpSupply.value.amount);

      if (totalLPRaw === 0 || lpLargest.value.length === 0) {
        result.reasons.push("⚠ no_lp_supply");
        return result;
      }

      // Check if top LP holder is a burn address or locker
      const topLP = lpLargest.value[0];
      const topLPPct = (Number(topLP.amount) / totalLPRaw) * 100;
      result.lpTopHolderPct = topLPPct;

      // Check the owner of the top LP token account
      const topLPOwners = await fetchAccountOwners(connection, [topLP.address]);
      const topLPOwner = topLPOwners[0];

      if (topLPOwner && BURN_ADDRESSES.has(topLPOwner)) {
        result.lpBurned = true;
        result.reasons.push(`✓ lp_burned_${topLPPct.toFixed(0)}%`);
      } else if (topLPOwner && LP_LOCKER_PROGRAMS.has(topLPOwner)) {
        result.lpLocked = true;
        result.reasons.push(`✓ lp_locked_${topLPPct.toFixed(0)}%`);
      } else {
        // LP is held by a regular wallet — potential rug vector
        if (topLPPct > 90) {
          result.reasons.push(`⚠ lp_not_locked_${topLPPct.toFixed(0)}%_single_holder`);
        } else {
          result.reasons.push(`⚠ lp_unlocked_top_${topLPPct.toFixed(0)}%`);
        }
      }
    } else {
      // Unknown DEX — can't check LP
      result.reasons.push("lp_check_skipped_unknown_dex");
    }
  } catch (err) {
    result.reasons.push(`lp_check_error: ${err}`);
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch the owner program of multiple token accounts efficiently.
 * Uses getMultipleAccountsInfo for batching.
 */
async function fetchAccountOwners(
  connection: Connection,
  addresses: string[]
): Promise<(string | null)[]> {
  if (addresses.length === 0) return [];

  try {
    const pubkeys = addresses.map(a => new PublicKey(a));
    const infos = await connection.getMultipleAccountsInfo(pubkeys);
    return infos.map(info => info?.owner?.toBase58() ?? null);
  } catch {
    return addresses.map(() => null);
  }
}

/**
 * Check if an owner program is a known AMM/pool program.
 */
function isPoolProgram(owner: string): boolean {
  const POOL_PROGRAMS = new Set([
    PUMPSWAP_PROGRAM,
    RAYDIUM_AMM_V4,
    RAYDIUM_CPMM,
    // Raydium concentrated liquidity
    "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
    // Orca Whirlpool
    "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
    // Meteora
    "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
    // SPL Token program (token accounts owned by SPL)
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  ]);
  return POOL_PROGRAMS.has(owner);
}

/**
 * Try to extract the LP mint from a Raydium V4 AMM pool account.
 *
 * Raydium V4 AMM layout (partial):
 *   offset 368: LP mint (32 bytes)
 *
 * This offset may vary — we try the known offset and fall back gracefully.
 */
async function findRaydiumLPMint(
  connection: Connection,
  poolAddress: string
): Promise<string | null> {
  try {
    const info = await connection.getAccountInfo(new PublicKey(poolAddress));
    if (!info || info.data.length < 400) return null;

    // Raydium V4 AMM: LP mint at offset 368
    const lpMintBytes = info.data.subarray(368, 400);
    const lpMint = new PublicKey(lpMintBytes).toBase58();

    // Sanity check: it should be a valid mint
    if (lpMint === "11111111111111111111111111111111") return null;

    return lpMint;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCORING INTEGRATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Apply holder + LP analysis to a candidate's safety score.
 * Call this from validateOnChain() or the engine after initial scoring.
 *
 * Returns score adjustments and reasons.
 */
export function applyHolderScoring(
  holders: HolderAnalysis,
  lp: LPAnalysis
): { scoreAdj: number; reasons: string[] } {
  let scoreAdj = 0;
  const reasons: string[] = [];

  // ── Holder concentration ──
  if (holders.topHolderPct > 30) {
    scoreAdj -= 30; // Extreme whale risk
    reasons.push(`⚠ WHALE_${holders.topHolderPct.toFixed(0)}%`);
  } else if (holders.topHolderPct > 20) {
    scoreAdj -= 20;
    reasons.push(`⚠ high_concentration_${holders.topHolderPct.toFixed(0)}%`);
  } else if (holders.topHolderPct > 10) {
    scoreAdj -= 10;
    reasons.push(`⚠ moderate_concentration_${holders.topHolderPct.toFixed(0)}%`);
  } else {
    scoreAdj += 10; // Well distributed
    reasons.push(`✓ distributed_top_${holders.topHolderPct.toFixed(0)}%`);
  }

  // Top-10 check
  if (holders.top10HolderPct > 60) {
    scoreAdj -= 15;
    reasons.push(`⚠ top10_hold_${holders.top10HolderPct.toFixed(0)}%`);
  }

  // Holder count
  if (holders.holderCountEstimate < 20) {
    scoreAdj -= 20;
    reasons.push("⚠ very_few_holders");
  } else if (holders.holderCountEstimate < 50) {
    scoreAdj -= 10;
    reasons.push(`⚠ low_holders_~${holders.holderCountEstimate}`);
  } else {
    scoreAdj += 5;
    reasons.push(`✓ decent_holders_≥${holders.holderCountEstimate}`);
  }

  // ── LP status ──
  if (lp.lpBurned) {
    scoreAdj += 15;
    reasons.push("✓ lp_burned");
  } else if (lp.lpLocked) {
    scoreAdj += 10;
    reasons.push("✓ lp_locked");
  } else if (lp.lpTopHolderPct > 90) {
    scoreAdj -= 20;
    reasons.push("⚠ lp_NOT_locked_single_holder");
  } else if (lp.lpTopHolderPct > 0) {
    scoreAdj -= 10;
    reasons.push("⚠ lp_unlocked");
  }
  // PumpSwap protocol-managed LP gets no penalty/bonus (neutral)

  return { scoreAdj, reasons };
}
