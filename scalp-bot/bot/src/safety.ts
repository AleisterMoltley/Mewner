/**
 * Circuit Breaker — Scalp Bot Safety
 *
 * Pauses trading after:
 *  - Consecutive failures (e.g. 5 failed buys/sells)
 *  - Too many failures in rolling window
 *  - Drawdown exceeds threshold
 *  - Daily loss limit hit (full stop until UTC midnight)
 */

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

export interface CircuitBreakerConfig {
  maxConsecutiveFailures: number;
  consecutivePauseMs: number;
  maxFailuresInWindow: number;
  windowMs: number;
  windowPauseMs: number;
  maxDrawdownUsd: number;
  drawdownPauseMs: number;
  maxDailyLossUsd: number;
}

export const DEFAULT_CIRCUIT_BREAKER: CircuitBreakerConfig = {
  maxConsecutiveFailures: parseInt(process.env.MAX_CONSEC_FAILURES ?? "5"),
  consecutivePauseMs: 5 * 60_000,
  maxFailuresInWindow: 15,
  windowMs: 30 * 60_000,
  windowPauseMs: 10 * 60_000,
  maxDrawdownUsd: parseFloat(process.env.MAX_DRAWDOWN_USD ?? "-25"),
  drawdownPauseMs: 60 * 60_000,
  maxDailyLossUsd: parseFloat(process.env.MAX_DAILY_LOSS_USD ?? "-50"),
};

// ═══════════════════════════════════════════════════════════════════════════════
// CIRCUIT BREAKER
// ═══════════════════════════════════════════════════════════════════════════════

interface FailureRecord {
  timestamp: number;
  reason: string;
}

export class CircuitBreaker {
  private config: CircuitBreakerConfig;
  private consecutiveFailures = 0;
  private failures: FailureRecord[] = [];
  private pausedUntil = 0;
  private pauseReason = "";
  private totalPnlUsd = 0;
  private totalTipsPaidUsd = 0;
  private dailyPnlUsd = 0;
  private dailyResetDate = "";
  private killed = false;

  constructor(config: CircuitBreakerConfig = DEFAULT_CIRCUIT_BREAKER) {
    this.config = config;
    this.dailyResetDate = new Date().toISOString().slice(0, 10);
  }

  check(): string | null {
    // Daily reset at UTC midnight
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.dailyResetDate) {
      this.dailyPnlUsd = 0;
      this.dailyResetDate = today;
      this.killed = false;
      console.log(`[safety] Daily reset — ${today}`);
    }

    if (this.killed) {
      return `DAILY LOSS LIMIT ($${this.dailyPnlUsd.toFixed(2)}) — stopped until tomorrow`;
    }

    if (Date.now() < this.pausedUntil) {
      const remaining = Math.ceil((this.pausedUntil - Date.now()) / 1000);
      return `${this.pauseReason} (${remaining}s remaining)`;
    }
    return null;
  }

  recordSuccess(profitUsd: number): void {
    this.consecutiveFailures = 0;
    this.totalPnlUsd += profitUsd;
    this.dailyPnlUsd += profitUsd;
  }

  recordFailure(reason: string, tipCostUsd: number = 0): void {
    this.consecutiveFailures++;
    this.totalTipsPaidUsd += tipCostUsd;
    this.totalPnlUsd -= tipCostUsd;
    this.dailyPnlUsd -= tipCostUsd;

    this.failures.push({ timestamp: Date.now(), reason });
    const cutoff = Date.now() - this.config.windowMs;
    this.failures = this.failures.filter((f) => f.timestamp > cutoff);

    // Daily kill switch
    if (this.dailyPnlUsd < this.config.maxDailyLossUsd) {
      this.killed = true;
      console.warn(`[safety] ⛔ DAILY LOSS LIMIT: $${this.dailyPnlUsd.toFixed(2)} — stopped until midnight UTC`);
      return;
    }

    // Consecutive failures
    if (this.consecutiveFailures >= this.config.maxConsecutiveFailures) {
      this.pause(`${this.consecutiveFailures} consecutive failures`, this.config.consecutivePauseMs);
      this.consecutiveFailures = 0;
      return;
    }

    // Window failures
    if (this.failures.length >= this.config.maxFailuresInWindow) {
      this.pause(`${this.failures.length} failures in ${this.config.windowMs / 60_000}min`, this.config.windowPauseMs);
      this.failures = [];
      return;
    }

    // Drawdown
    if (this.totalPnlUsd < this.config.maxDrawdownUsd) {
      this.pause(`Drawdown: $${this.totalPnlUsd.toFixed(2)}`, this.config.drawdownPauseMs);
      return;
    }
  }

  private pause(reason: string, durationMs: number): void {
    this.pausedUntil = Date.now() + durationMs;
    this.pauseReason = reason;
    console.warn(`[safety] ⚠ PAUSED — ${reason} — resuming in ${Math.round(durationMs / 1000)}s`);
  }

  getStats() {
    return {
      consecutiveFailures: this.consecutiveFailures,
      recentFailures: this.failures.length,
      totalPnlUsd: Math.round(this.totalPnlUsd * 100) / 100,
      dailyPnlUsd: Math.round(this.dailyPnlUsd * 100) / 100,
      totalTipsPaidUsd: Math.round(this.totalTipsPaidUsd * 100) / 100,
      paused: this.killed || Date.now() < this.pausedUntil,
      killed: this.killed,
      pauseReason: this.killed
        ? `Daily loss limit ($${this.dailyPnlUsd.toFixed(2)})`
        : Date.now() < this.pausedUntil ? this.pauseReason : "",
    };
  }
}
