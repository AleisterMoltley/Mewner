/**
 * Position Manager
 *
 * Tracks open positions with:
 *  - Stop-loss (hard cut at -X%)
 *  - Take-profit levels (sell fractions at +50%, +100%, +200%)
 *  - Trailing stop (activate at +30%, sell if drops 15% from peak)
 *  - Max hold time (force close after N seconds)
 *
 * Each position tracks: entry price, current price, highest price,
 * partial sells completed, and PnL.
 */

import { PositionConfig, DEFAULT_POSITION, SOL_MINT } from "./config";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface Position {
  id: string;
  mint: string;
  symbol: string;
  dex: string;
  // Entry
  entryPriceSOL: number;
  entryPriceUsd: number;
  amountTokens: number;
  costSOL: number;
  entryTime: number;
  // Current state
  currentPriceSOL: number;
  currentPriceUsd: number;
  highestPriceSOL: number;
  // Tracking
  pnlPct: number;
  pnlSOL: number;
  pnlUsd: number;
  holdTimeSec: number;
  // Sell tracking
  partialSellsDone: number;   // How many TP levels triggered
  remainingFraction: number;  // 1.0 = full, 0.4 = sold 60%
  trailingStopActive: boolean;
  // Status
  status: "open" | "closing" | "closed";
  closeReason: string;
  signalReasons: string[];
}

export type SellAction = {
  type: "stop_loss" | "take_profit" | "trailing_stop" | "max_hold" | "manual";
  fraction: number;  // 0-1, fraction of remaining to sell
  reason: string;
};

// ═══════════════════════════════════════════════════════════════════════════════
// POSITION MANAGER
// ═══════════════════════════════════════════════════════════════════════════════

export class PositionManager {
  private positions: Map<string, Position> = new Map();
  private closedPositions: Position[] = [];
  private config: PositionConfig;

  // Stats
  private totalTrades = 0;
  private totalWins = 0;
  private totalPnlSOL = 0;
  private totalPnlUsd = 0;

  constructor(config: PositionConfig = DEFAULT_POSITION) {
    this.config = config;
  }

  /**
   * Open a new position.
   */
  open(
    mint: string,
    symbol: string,
    dex: string,
    priceSOL: number,
    priceUsd: number,
    amountTokens: number,
    costSOL: number,
    signalReasons: string[]
  ): Position {
    const id = `pos_${mint.slice(0, 8)}_${Date.now()}`;

    const pos: Position = {
      id, mint, symbol, dex,
      entryPriceSOL: priceSOL,
      entryPriceUsd: priceUsd,
      amountTokens,
      costSOL,
      entryTime: Date.now(),
      currentPriceSOL: priceSOL,
      currentPriceUsd: priceUsd,
      highestPriceSOL: priceSOL,
      pnlPct: 0,
      pnlSOL: 0,
      pnlUsd: 0,
      holdTimeSec: 0,
      partialSellsDone: 0,
      remainingFraction: 1.0,
      trailingStopActive: false,
      status: "open",
      closeReason: "",
      signalReasons,
    };

    this.positions.set(id, pos);
    console.log(
      `[pos] OPENED ${symbol} — ${costSOL.toFixed(4)} SOL @ $${priceUsd.toFixed(6)} — ${signalReasons.join(", ")}`
    );

    return pos;
  }

  /**
   * Update a position's current price and check for sell triggers.
   * Returns sell actions if any triggers hit.
   */
  update(id: string, currentPriceSOL: number, currentPriceUsd: number): SellAction[] {
    const pos = this.positions.get(id);
    if (!pos || pos.status !== "open") return [];

    // Update price tracking
    pos.currentPriceSOL = currentPriceSOL;
    pos.currentPriceUsd = currentPriceUsd;
    pos.holdTimeSec = (Date.now() - pos.entryTime) / 1000;

    if (currentPriceSOL > pos.highestPriceSOL) {
      pos.highestPriceSOL = currentPriceSOL;
    }

    // Calculate PnL
    pos.pnlPct = ((currentPriceSOL - pos.entryPriceSOL) / pos.entryPriceSOL) * 100;
    pos.pnlSOL = (currentPriceSOL - pos.entryPriceSOL) * pos.amountTokens * pos.remainingFraction;
    pos.pnlUsd = (currentPriceUsd - pos.entryPriceUsd) * pos.amountTokens * pos.remainingFraction;

    const actions: SellAction[] = [];

    // 1. STOP-LOSS
    if (pos.pnlPct <= this.config.stopLossPct) {
      actions.push({
        type: "stop_loss",
        fraction: 1.0, // Sell everything
        reason: `Stop-loss hit: ${pos.pnlPct.toFixed(1)}% (limit: ${this.config.stopLossPct}%)`,
      });
      return actions; // Stop-loss is absolute
    }

    // 2. MAX HOLD TIME
    if (pos.holdTimeSec >= this.config.maxHoldTimeSec) {
      actions.push({
        type: "max_hold",
        fraction: 1.0,
        reason: `Max hold time: ${Math.round(pos.holdTimeSec)}s (limit: ${this.config.maxHoldTimeSec}s)`,
      });
      return actions;
    }

    // 3. TAKE-PROFIT LEVELS
    for (let i = pos.partialSellsDone; i < this.config.takeProfitLevels.length; i++) {
      const [targetPct, sellFraction] = this.config.takeProfitLevels[i];
      if (pos.pnlPct >= targetPct) {
        actions.push({
          type: "take_profit",
          fraction: sellFraction,
          reason: `TP${i + 1}: +${pos.pnlPct.toFixed(1)}% (target: +${targetPct}%, selling ${(sellFraction * 100).toFixed(0)}%)`,
        });
        pos.partialSellsDone = i + 1;
      }
    }

    // 4. TRAILING STOP
    if (pos.pnlPct >= this.config.trailingStopActivationPct) {
      pos.trailingStopActive = true;
    }

    if (pos.trailingStopActive) {
      const dropFromPeak =
        ((pos.highestPriceSOL - currentPriceSOL) / pos.highestPriceSOL) * 100;

      if (dropFromPeak >= this.config.trailingStopDistancePct) {
        actions.push({
          type: "trailing_stop",
          fraction: 1.0, // Sell remaining
          reason: `Trailing stop: dropped ${dropFromPeak.toFixed(1)}% from peak $${pos.highestPriceSOL.toFixed(6)}`,
        });
      }
    }

    return actions;
  }

  /**
   * Record a partial or full sell.
   */
  recordSell(id: string, fraction: number, reason: string, receivedSOL: number): void {
    const pos = this.positions.get(id);
    if (!pos) return;

    pos.remainingFraction -= fraction * pos.remainingFraction;

    if (pos.remainingFraction < 0.01) {
      // Position fully closed
      pos.status = "closed";
      pos.closeReason = reason;

      this.totalTrades++;
      this.totalPnlSOL += pos.pnlSOL;
      this.totalPnlUsd += pos.pnlUsd;
      if (pos.pnlSOL > 0) this.totalWins++;

      this.closedPositions.push({ ...pos });
      this.positions.delete(id);

      // Persist to trade log file
      this.logTrade(pos);

      const emoji = pos.pnlSOL >= 0 ? "✅" : "❌";
      console.log(
        `[pos] ${emoji} CLOSED ${pos.symbol} — ${reason} — ` +
        `PnL: ${pos.pnlPct >= 0 ? "+" : ""}${pos.pnlPct.toFixed(1)}% / ` +
        `${pos.pnlSOL >= 0 ? "+" : ""}${pos.pnlSOL.toFixed(4)} SOL — ` +
        `held ${Math.round(pos.holdTimeSec)}s`
      );
    } else {
      console.log(
        `[pos] 📉 PARTIAL SELL ${pos.symbol} — ${(fraction * 100).toFixed(0)}% — ${reason} — ` +
        `remaining: ${(pos.remainingFraction * 100).toFixed(0)}%`
      );
    }
  }

  /**
   * Get all open positions.
   */
  getOpen(): Position[] {
    return [...this.positions.values()].filter((p) => p.status === "open");
  }

  /**
   * Get position by mint.
   */
  getByMint(mint: string): Position | undefined {
    for (const p of this.positions.values()) {
      if (p.mint === mint) return p;
    }
    return undefined;
  }

  canOpenNew(): boolean {
    return this.getOpen().length < this.config.maxOpenPositions;
  }

  getStats() {
    const open = this.getOpen();
    return {
      openPositions: open.length,
      maxPositions: this.config.maxOpenPositions,
      totalTrades: this.totalTrades,
      wins: this.totalWins,
      winRate: this.totalTrades > 0 ? Math.round((this.totalWins / this.totalTrades) * 100) : 0,
      totalPnlSOL: Math.round(this.totalPnlSOL * 10000) / 10000,
      totalPnlUsd: Math.round(this.totalPnlUsd * 100) / 100,
      openPnlSOL: open.reduce((s, p) => s + p.pnlSOL, 0),
      positions: open.map((p) => ({
        symbol: p.symbol,
        pnlPct: Math.round(p.pnlPct * 10) / 10,
        holdSec: Math.round(p.holdTimeSec),
        trailing: p.trailingStopActive,
        remaining: Math.round(p.remainingFraction * 100),
      })),
    };
  }

  /**
   * Persist closed trade to log file (survives restarts).
   */
  private logTrade(pos: Position): void {
    try {
      const fs = require("fs");
      const logFile = process.env.TRADE_LOG_FILE ?? "/tmp/scalp-trades.jsonl";
      const entry = JSON.stringify({
        id: pos.id,
        mint: pos.mint,
        symbol: pos.symbol,
        dex: pos.dex,
        entryPrice: pos.entryPriceUsd,
        exitPrice: pos.currentPriceUsd,
        costSOL: pos.costSOL,
        pnlPct: Math.round(pos.pnlPct * 10) / 10,
        pnlSOL: Math.round(pos.pnlSOL * 10000) / 10000,
        pnlUsd: Math.round(pos.pnlUsd * 100) / 100,
        holdSec: Math.round(pos.holdTimeSec),
        reason: pos.closeReason,
        signals: pos.signalReasons,
        time: new Date().toISOString(),
      });
      fs.appendFileSync(logFile, entry + "\n");
    } catch {}
  }
}
