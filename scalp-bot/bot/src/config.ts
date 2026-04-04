/**
 * Scalp Bot Config
 *
 * All tuneable parameters for memecoin scalping.
 * Every value can be overridden via ENV.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// WELL-KNOWN ADDRESSES
// ═══════════════════════════════════════════════════════════════════════════════

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export const PUMPFUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMPFUN_MIGRATION = "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg";
export const PUMPSWAP_PROGRAM = "PSwapMdSai8tjrEXcxFeQth87xC4rRsa4VA5mhGhXkP";
export const RAYDIUM_AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
export const RAYDIUM_CPMM = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";

// Jito endpoints
export const JITO_ENDPOINTS = [
  { url: "https://mainnet.block-engine.jito.wtf", region: "US-NY" },
  { url: "https://amsterdam.mainnet.block-engine.jito.wtf", region: "EU-AMS" },
  { url: "https://frankfurt.mainnet.block-engine.jito.wtf", region: "EU-FRA" },
  { url: "https://tokyo.mainnet.block-engine.jito.wtf", region: "AP-TKY" },
  { url: "https://slc.mainnet.block-engine.jito.wtf", region: "US-SLC" },
];

// ═══════════════════════════════════════════════════════════════════════════════
// TOKEN SAFETY FILTERS
// ═══════════════════════════════════════════════════════════════════════════════

export interface TokenSafetyConfig {
  /** Minimum pool liquidity in USD to consider */
  minLiquidityUsd: number;
  /** Minimum 24h volume */
  minVolumeUsd: number;
  /** Require mint authority disabled (can't mint more) */
  requireMintDisabled: boolean;
  /** Require freeze authority disabled (can't freeze accounts) */
  requireFreezeDisabled: boolean;
  /** Max % held by single wallet (whale check) */
  maxTopHolderPct: number;
  /** Min number of holders */
  minHolders: number;
  /** Min age of pool in seconds */
  minPoolAgeSec: number;
  /** Max age of pool in seconds (0 = no max) — for "fresh" sniping */
  maxPoolAgeSec: number;
}

export const DEFAULT_TOKEN_SAFETY: TokenSafetyConfig = {
  minLiquidityUsd: parseFloat(process.env.MIN_LIQUIDITY_USD ?? "10000"),
  minVolumeUsd: parseFloat(process.env.MIN_VOLUME_USD ?? "5000"),
  requireMintDisabled: true,
  requireFreezeDisabled: true,
  maxTopHolderPct: parseInt(process.env.MAX_TOP_HOLDER_PCT ?? "25"),
  minHolders: parseInt(process.env.MIN_HOLDERS ?? "100"),
  minPoolAgeSec: parseInt(process.env.MIN_POOL_AGE_SEC ?? "60"),
  maxPoolAgeSec: parseInt(process.env.MAX_POOL_AGE_SEC ?? "86400"),
};

// ═══════════════════════════════════════════════════════════════════════════════
// POSITION MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

export interface PositionConfig {
  /** Max SOL per trade */
  maxPositionSol: number;
  /** Max concurrent open positions */
  maxOpenPositions: number;
  /** Stop-loss % (negative, e.g. -15 = sell at -15%) */
  stopLossPct: number;
  /** Take-profit levels: [pct, sellFraction] */
  takeProfitLevels: [number, number][];
  /** Trailing stop activation (e.g. 30 = activate at +30%) */
  trailingStopActivationPct: number;
  /** Trailing stop distance (e.g. 15 = sell if drops 15% from peak) */
  trailingStopDistancePct: number;
  /** Max hold time in seconds (force close) */
  maxHoldTimeSec: number;
  /** Min SOL balance to keep for gas */
  minSolReserve: number;
}

export const DEFAULT_POSITION: PositionConfig = {
  maxPositionSol: parseFloat(process.env.MAX_POSITION_SOL ?? "0.02"),
  maxOpenPositions: parseInt(process.env.MAX_OPEN_POSITIONS ?? "2"),
  stopLossPct: parseFloat(process.env.STOP_LOSS_PCT ?? "-15"),
  takeProfitLevels: [
    [40, 0.25],   // At +40%, sell 25%
    [80, 0.25],   // At +80%, sell another 25%
    [150, 0.25],  // At +150%, sell another 25%
    [300, 1.0],   // At +300% (4x), sell remaining
  ],
  trailingStopActivationPct: parseFloat(process.env.TRAILING_ACTIVATION_PCT ?? "25"),
  trailingStopDistancePct: parseFloat(process.env.TRAILING_DISTANCE_PCT ?? "12"),
  maxHoldTimeSec: parseInt(process.env.MAX_HOLD_SEC ?? "1800"), // 30 min default
  minSolReserve: parseFloat(process.env.MIN_SOL_RESERVE ?? "0.05"),
};

// ═══════════════════════════════════════════════════════════════════════════════
// SIGNAL CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

export interface SignalConfig {
  /** Scan interval for new tokens */
  scanIntervalMs: number;
  /** Min score to enter (0-100) */
  minEntryScore: number;
  /** Volume spike multiplier (e.g. 3 = 3x avg volume = signal) */
  volumeSpikeMultiplier: number;
  /** Price momentum: min % gain in last N minutes */
  momentumMinPct: number;
  momentumWindowMin: number;
  /** DexScreener trending boost */
  useDexScreenerTrending: boolean;
  /** PumpFun graduation snipe */
  snipePumpGraduations: boolean;
}

export const DEFAULT_SIGNAL: SignalConfig = {
  scanIntervalMs: parseInt(process.env.SCAN_INTERVAL_MS ?? "3000"),
  minEntryScore: parseInt(process.env.MIN_ENTRY_SCORE ?? "65"),
  volumeSpikeMultiplier: 3,
  momentumMinPct: 5,
  momentumWindowMin: 5,
  useDexScreenerTrending: true,
  snipePumpGraduations: true,
};

// ═══════════════════════════════════════════════════════════════════════════════
// TIP CONFIG (reused from arb bot)
// ═══════════════════════════════════════════════════════════════════════════════

export interface TipConfig {
  basePct: number;
  minTipLamports: number;
  maxTipLamports: number;
  adjustStepPct: number;
}

export const DEFAULT_TIP: TipConfig = {
  basePct: 0.5,
  minTipLamports: 1_000,
  maxTipLamports: 100_000_000,
  adjustStepPct: 0.03,
};

// ═══════════════════════════════════════════════════════════════════════════════
// FULL BOT CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

export interface ScalpBotConfig {
  rpcUrl: string;
  walletPrivateKey: string;
  jupiterUrl: string;
  dryRun: boolean;
  tokenSafety: TokenSafetyConfig;
  position: PositionConfig;
  signal: SignalConfig;
  tip: TipConfig;
}

export function loadConfig(): ScalpBotConfig {
  return {
    rpcUrl: process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com",
    walletPrivateKey: process.env.WALLET_PRIVATE_KEY ?? "",
    jupiterUrl: process.env.JUPITER_API_URL ?? "https://api.jup.ag",
    dryRun: (process.env.DRY_RUN ?? "true") === "true",
    tokenSafety: DEFAULT_TOKEN_SAFETY,
    position: DEFAULT_POSITION,
    signal: DEFAULT_SIGNAL,
    tip: DEFAULT_TIP,
  };
}
