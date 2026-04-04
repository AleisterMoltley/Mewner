/**
 * Dynamic Jito Tip Engine
 *
 * Adjusts tip percentage based on rolling landing rate.
 * - Landing rate < 20% → increase tip
 * - Landing rate > 50% → decrease tip (save profit)
 * - Always clamp between min/max lamports
 */

import { TipConfig, DEFAULT_TIP } from "./config";

interface BundleResult {
  timestamp: number;
  landed: boolean;
  tipLamports: number;
  expectedProfitLamports: number;
}

export class DynamicTipEngine {
  private config: TipConfig;
  private currentTipPct: number;
  private history: BundleResult[] = [];

  constructor(config: TipConfig = DEFAULT_TIP) {
    this.config = config;
    this.currentTipPct = config.basePct;
  }

  calculateTip(expectedProfitLamports: number): number {
    const rawTip = Math.floor(expectedProfitLamports * this.currentTipPct);
    return Math.max(
      this.config.minTipLamports,
      Math.min(this.config.maxTipLamports, rawTip)
    );
  }

  recordResult(result: BundleResult): void {
    this.history.push(result);
    if (this.history.length > 50) {
      this.history = this.history.slice(-50);
    }
    this.adjust();
  }

  private adjust(): void {
    if (this.history.length < 5) return;
    const landingRate = this.getLandingRate();

    if (landingRate < 0.2) {
      // Low landing → increase tip
      this.currentTipPct = Math.min(0.90, this.currentTipPct + this.config.adjustStepPct);
    } else if (landingRate > 0.5) {
      // High landing → decrease tip to save profit
      this.currentTipPct = Math.max(0.15, this.currentTipPct - this.config.adjustStepPct);
    }
  }

  getLandingRate(): number {
    if (this.history.length === 0) return 0;
    return this.history.filter((r) => r.landed).length / this.history.length;
  }

  getCurrentTipPct(): number {
    return this.currentTipPct;
  }

  getStats() {
    const landed = this.history.filter((r) => r.landed).length;
    const totalTips = this.history.reduce((s, r) => s + r.tipLamports, 0);
    return {
      currentTipPct: Math.round(this.currentTipPct * 100) / 100,
      landingRate: this.history.length > 0 ? Math.round((landed / this.history.length) * 100) / 100 : 0,
      totalBundles: this.history.length,
      totalLanded: landed,
      totalTipsPaid: totalTips,
    };
  }
}
