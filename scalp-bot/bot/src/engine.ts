/**
 * Scalp Bot Engine
 *
 * Main loop:
 *   1. Scan for new token candidates (DexScreener, PumpFun)
 *   2. Filter by safety score + entry signal
 *   3. Buy via Jupiter + Jito bundle
 *   4. Monitor open positions (price updates every cycle)
 *   5. Sell on stop-loss / take-profit / trailing-stop / max-hold
 *
 * Reuses from arb-bot: Jito submission, tip engine, circuit breaker
 */

import {
  Connection,
  Keypair,
} from "@solana/web3.js";
import bs58 from "bs58";
import { loadConfig, ScalpBotConfig, SOL_MINT, JITO_ENDPOINTS } from "./config";
import { TokenScanner, TokenCandidate } from "./token-scanner";
import { PositionManager, SellAction } from "./position-manager";
import { SwapExecutor } from "./swap-executor";
import { PumpFunListener, GraduationEvent } from "./pumpfun-listener";
import { analyzeHolders, analyzeLiquidity, applyHolderScoring } from "./holder-analysis";
import { DynamicTipEngine } from "./tip-engine";
import { MultiEndpointSubmitter } from "./multi-endpoint";
import { CircuitBreaker, DEFAULT_CIRCUIT_BREAKER } from "./safety";

// ═══════════════════════════════════════════════════════════════════════════════
// DASHBOARD (embedded minimal HTTP)
// ═══════════════════════════════════════════════════════════════════════════════

const logs: string[] = [];
function addLog(msg: string): void {
  logs.unshift(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
  if (logs.length > 100) logs.pop();
}

let dashboardData: any = {};

function startDashboard(): void {
  const http = require("http");
  const port = parseInt(process.env.PORT ?? "8080");

  const server = http.createServer((req: any, res: any) => {
    if (req.url === "/api/stats") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ...dashboardData, logs }));
      return;
    }
    if (req.url === "/health") {
      res.writeHead(200);
      res.end("OK");
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(DASHBOARD_HTML);
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`[dashboard] http://0.0.0.0:${port}`);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

class ScalpBot {
  private config: ScalpBotConfig;
  private connection: Connection;
  private wallet: Keypair;
  private scanner: TokenScanner;
  private positions: PositionManager;
  private executor: SwapExecutor;
  private circuitBreaker: CircuitBreaker;
  private pumpListener: PumpFunListener;
  private graduationQueue: GraduationEvent[] = [];
  private running = false;
  private lastBalanceRefresh = 0;

  constructor() {
    this.config = loadConfig();
    this.connection = new Connection(this.config.rpcUrl, "confirmed");
    this.wallet = this.loadWallet();

    this.scanner = new TokenScanner(this.connection, this.config.tokenSafety);
    this.positions = new PositionManager(this.config.position);

    const tipEngine = new DynamicTipEngine(this.config.tip);
    const submitter = new MultiEndpointSubmitter(tipEngine);
    this.executor = new SwapExecutor(this.connection, this.wallet, this.config.jupiterUrl, submitter);

    this.circuitBreaker = new CircuitBreaker(DEFAULT_CIRCUIT_BREAKER);

    // PumpFun graduation listener — pushes events into queue for main loop
    this.pumpListener = new PumpFunListener(this.connection, (event) => {
      this.graduationQueue.push(event);
      addLog(`🎓 Graduation: ${event.mint.slice(0, 12)}... → ${event.dex}`);
    });
  }

  private loadWallet(): Keypair {
    const key = this.config.walletPrivateKey;
    if (!key) {
      console.error("WALLET_PRIVATE_KEY not set");
      process.exit(1);
    }
    try {
      if (key.startsWith("[")) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(key)));
      return Keypair.fromSecretKey(bs58.decode(key));
    } catch {
      console.error("Invalid WALLET_PRIVATE_KEY");
      process.exit(1);
    }
  }

  async start(): Promise<void> {
    console.log("═══════════════════════════════════════════════════════════");
    console.log("  Solana Memecoin Scalp Bot — Starting");
    console.log("═══════════════════════════════════════════════════════════");
    console.log(`  Wallet:        ${this.wallet.publicKey.toBase58()}`);
    console.log(`  RPC:           ${this.config.rpcUrl.slice(0, 40)}...`);
    console.log(`  Dry Run:       ${this.config.dryRun}`);
    console.log(`  Max Position:  ${this.config.position.maxPositionSol} SOL`);
    console.log(`  Max Open:      ${this.config.position.maxOpenPositions}`);
    console.log(`  Stop-Loss:     ${this.config.position.stopLossPct}%`);
    console.log(`  Min Score:     ${this.config.signal.minEntryScore}`);
    console.log(`  Scan Interval: ${this.config.signal.scanIntervalMs}ms`);
    console.log("═══════════════════════════════════════════════════════════\n");

    // Check balance
    const balance = await this.connection.getBalance(this.wallet.publicKey);
    let balanceSOL = balance / 1e9;
    console.log(`[bot] Wallet balance: ${balanceSOL.toFixed(4)} SOL\n`);

    if (balanceSOL < this.config.position.minSolReserve) {
      console.error(`[bot] Insufficient SOL. Need at least ${this.config.position.minSolReserve} SOL`);
      process.exit(1);
    }

    this.running = true;
    startDashboard();

    // Start PumpFun graduation listener (real-time WebSocket)
    if (this.config.signal.snipePumpGraduations) {
      await this.pumpListener.start();
    }

    console.log(`[bot] Entering main loop\n`);

    while (this.running) {
      try {
        const cycleStart = Date.now();

        // Circuit breaker
        const pause = this.circuitBreaker.check();
        if (pause) {
          addLog(`⏸ Paused: ${pause}`);
          await this.sleep(5000);
          continue;
        }

        // 1. MONITOR open positions (always first — exits are time-critical)
        await this.monitorPositions();

        // 2. Refresh balance every 30s
        if (Date.now() - this.lastBalanceRefresh > 30_000) {
          balanceSOL = await this.refreshBalance();
          this.lastBalanceRefresh = Date.now();
        }

        // 3. PROCESS graduation events (highest priority — time-sensitive)
        if (this.positions.canOpenNew() && balanceSOL > this.config.position.minSolReserve + this.config.position.maxPositionSol) {
          await this.processGraduations();
        }

        // 4. SCAN for new candidates via DexScreener (lower priority)
        if (this.positions.canOpenNew() && balanceSOL > this.config.position.minSolReserve + this.config.position.maxPositionSol) {
          await this.scanAndBuy();
        }

        // 5. Update dashboard
        this.updateDashboard(balanceSOL, Date.now() - cycleStart);

        await this.sleep(this.config.signal.scanIntervalMs);
      } catch (err) {
        console.error("[bot] Loop error:", err);
        await this.sleep(5000);
      }
    }
  }

  // ─── GRADUATION PROCESSING (real-time PumpFun events) ────────────────────

  private async processGraduations(): Promise<void> {
    // Drain the queue (process all pending graduations this cycle)
    while (this.graduationQueue.length > 0) {
      const event = this.graduationQueue.shift()!;

      // Skip if already tracking or seen
      if (this.positions.getByMint(event.mint)) continue;
      if (this.scanner.isSeen(event.mint)) continue;
      this.scanner.markSeen(event.mint);

      console.log(
        `[bot] 🎓 GRADUATION SNIPE: ${event.mint.slice(0, 12)}... → ${event.dex} ` +
        `pool: ${event.poolAddress.slice(0, 12)}...`
      );

      // Build a candidate from the graduation event
      // We don't have DexScreener data yet — use minimal info
      const candidate: TokenCandidate = {
        mint: event.mint,
        symbol: event.mint.slice(0, 6),
        name: "PumpFun Graduate",
        poolAddress: event.poolAddress,
        dex: event.dex,
        pairAddress: event.poolAddress,
        priceUsd: 0, priceSOL: 0,
        liquidityUsd: 12_000, // PumpFun graduates with ~$12k liquidity
        volume24h: 0, volume5m: 0, volume1h: 0,
        marketCap: 69_000, // Graduation threshold
        priceChange5m: 0, priceChange1h: 0, priceChange24h: 0,
        safetyScore: 60, // Start moderate — graduation is a positive signal
        mintDisabled: true, freezeDisabled: true,
        topHolderPct: 0, holders: 0,
        poolAgeSec: 0,
        entryScore: 80, // High priority — freshest possible entry
        signalReasons: ["graduation_snipe", event.dex],
        discoveredAt: Date.now(),
        source: "pumpfun",
      };

      // ON-CHAIN VALIDATION (mint/freeze + honeypot check)
      const validation = await this.scanner.validateOnChain(this.connection, event.mint, candidate);
      if (!validation.safe) {
        console.log(`[bot] ⛔ GRAD REJECTED ${candidate.symbol}: ${validation.reasons.join(", ")}`);
        addLog(`⛔ Grad ${event.mint.slice(0, 8)} rejected: ${validation.reasons.join(", ")}`);
        continue;
      }

      // HOLDER + LP ANALYSIS
      const holderResult = await this.runHolderChecks(event.mint, event.poolAddress, event.dex, candidate);
      if (!holderResult) continue;

      console.log(`[bot] ✓ Grad validated: ${validation.reasons.join(", ")}`);
      addLog(`🎓 Snipe ${candidate.symbol} — graduation + validated`);

      // Execute buy — use max position for graduations (highest conviction)
      const sizeSOL = this.config.position.maxPositionSol;
      const result = await this.executor.buy(event.mint, sizeSOL, 150, this.config.dryRun, candidate.liquidityUsd);

      if (result.success) {
        this.positions.open(
          event.mint, candidate.symbol, event.dex,
          candidate.priceSOL, candidate.priceUsd,
          result.amountOut, sizeSOL,
          candidate.signalReasons
        );
        addLog(`✅ GRAD BOUGHT ${candidate.symbol} — ${sizeSOL.toFixed(4)} SOL`);
      } else {
        addLog(`❌ GRAD BUY FAILED: ${result.error}`);
        this.circuitBreaker.recordFailure(`Grad buy failed: ${event.mint.slice(0, 8)}`, 0);
      }

      // Only one graduation buy per cycle
      break;
    }
  }

  // ─── HOLDER + LP CHECK (shared between graduation and scanner paths) ────

  private async runHolderChecks(
    mint: string,
    poolAddress: string,
    dex: string,
    candidate: TokenCandidate
  ): Promise<boolean> {
    try {
      const [holders, lp] = await Promise.all([
        analyzeHolders(this.connection, mint),
        analyzeLiquidity(this.connection, poolAddress, dex),
      ]);

      // Apply scoring
      const { scoreAdj, reasons } = applyHolderScoring(holders, lp);
      candidate.safetyScore += scoreAdj;
      candidate.topHolderPct = holders.topHolderPct;
      candidate.holders = holders.holderCountEstimate;

      console.log(`[bot] 📊 Holders: ${reasons.join(", ")} (adj: ${scoreAdj >= 0 ? "+" : ""}${scoreAdj})`);

      // Hard reject on extreme concentration
      if (holders.topHolderPct > this.config.tokenSafety.maxTopHolderPct) {
        console.log(`[bot] ⛔ REJECTED: top holder ${holders.topHolderPct.toFixed(1)}% > ${this.config.tokenSafety.maxTopHolderPct}%`);
        addLog(`⛔ ${candidate.symbol} whale_${holders.topHolderPct.toFixed(0)}%`);
        return false;
      }

      // Hard reject on too few holders (configurable)
      if (holders.holderCountEstimate < this.config.tokenSafety.minHolders && holders.holderCountEstimate > 0) {
        // For graduations, be more lenient — fresh tokens have few holders
        if (candidate.source !== "pumpfun" || holders.holderCountEstimate < 10) {
          console.log(`[bot] ⛔ REJECTED: only ~${holders.holderCountEstimate} holders`);
          addLog(`⛔ ${candidate.symbol} too_few_holders_${holders.holderCountEstimate}`);
          return false;
        }
      }

      return true;
    } catch (err) {
      console.error(`[bot] Holder check error for ${mint.slice(0, 12)}:`, err);
      // Don't block on holder check failures — the other safety checks still apply
      return true;
    }
  }

  // ─── SCAN & BUY ──────────────────────────────────────────────────────────

  private async scanAndBuy(): Promise<void> {
    const candidates = await this.scanner.scan();

    for (const c of candidates) {
      // Skip if already in a position for this mint
      if (this.positions.getByMint(c.mint)) continue;
      // Skip if already seen recently
      if (this.scanner.isSeen(c.mint)) continue;
      // Skip if score too low
      if (c.entryScore < this.config.signal.minEntryScore) continue;

      // Entry decision
      this.scanner.markSeen(c.mint);

      const sizeSOL = Math.min(
        this.config.position.maxPositionSol,
        c.liquidityUsd > 0 ? (c.liquidityUsd * 0.01) / (c.priceUsd > 0 ? c.priceUsd : 150) : this.config.position.maxPositionSol
      );

      console.log(
        `[bot] 🎯 SIGNAL: ${c.symbol} — score ${c.entryScore} — $${c.priceUsd.toFixed(6)} — ` +
        `liq $${c.liquidityUsd.toFixed(0)} — ${c.signalReasons.join(", ")}`
      );

      // ON-CHAIN VALIDATION before buying
      const validation = await this.scanner.validateOnChain(this.connection, c.mint, c);
      if (!validation.safe) {
        console.log(`[bot] ⛔ REJECTED ${c.symbol}: ${validation.reasons.join(", ")}`);
        addLog(`⛔ ${c.symbol} rejected: ${validation.reasons.join(", ")}`);
        continue;
      }

      // HOLDER + LP ANALYSIS
      const holderOk = await this.runHolderChecks(c.mint, c.poolAddress, c.dex, c);
      if (!holderOk) continue;

      console.log(`[bot] ✓ Validated: ${validation.reasons.join(", ")}`);
      addLog(`🎯 ${c.symbol} score:${c.entryScore} — ${c.signalReasons.join(", ")}`);

      // Execute buy
      const result = await this.executor.buy(c.mint, sizeSOL, 150, this.config.dryRun, c.liquidityUsd);

      if (result.success) {
        const tokensReceived = result.amountOut;
        this.positions.open(
          c.mint, c.symbol, c.dex,
          c.priceSOL, c.priceUsd,
          tokensReceived, sizeSOL,
          c.signalReasons
        );
        addLog(`✅ BOUGHT ${c.symbol} — ${sizeSOL.toFixed(4)} SOL`);
      } else {
        addLog(`❌ BUY FAILED ${c.symbol}: ${result.error}`);
        this.circuitBreaker.recordFailure(`Buy failed: ${c.symbol}`, 0);
      }

      // Only one buy per cycle
      break;
    }
  }

  // ─── MONITOR & SELL ──────────────────────────────────────────────────────

  private async monitorPositions(): Promise<void> {
    const open = this.positions.getOpen();
    if (open.length === 0) return;

    for (const pos of open) {
      // Fetch current price via Jupiter quote
      const price = await this.getCurrentPrice(pos.mint);
      if (!price) continue;

      // Update position and check triggers
      const actions = this.positions.update(pos.id, price.priceSOL, price.priceUsd);

      for (const action of actions) {
        const sellAmount = pos.amountTokens * pos.remainingFraction * action.fraction;

        console.log(`[bot] 📉 ${action.type.toUpperCase()}: ${pos.symbol} — ${action.reason}`);
        addLog(`📉 ${action.type}: ${pos.symbol} — ${action.reason}`);

        const result = await this.executor.sell(
          pos.mint, sellAmount, 9, 200, this.config.dryRun
        );

        if (result.success) {
          const receivedSOL = result.amountOut / 1e9;
          this.positions.recordSell(pos.id, action.fraction, action.reason, receivedSOL);

          if (pos.pnlSOL >= 0) {
            this.circuitBreaker.recordSuccess(pos.pnlUsd);
          } else {
            this.circuitBreaker.recordFailure(`Loss on ${pos.symbol}`, Math.abs(pos.pnlUsd));
          }
        } else {
          // Retry once with higher slippage
          addLog(`⚠ SELL RETRY ${pos.symbol} (higher slippage)...`);
          const retry = await this.executor.sell(
            pos.mint, sellAmount, 9, 500, this.config.dryRun
          );
          if (retry.success) {
            const receivedSOL = retry.amountOut / 1e9;
            this.positions.recordSell(pos.id, action.fraction, `${action.reason} (retry)`, receivedSOL);
          } else {
            addLog(`❌ SELL FAILED ${pos.symbol}: ${retry.error ?? result.error}`);
          }
        }
      }
    }
  }

  // ─── PRICE FEED ───────────────────────────────────────────────────────────

  private cachedSolUsd = 150;
  private solUsdTimestamp = 0;

  private async getCurrentPrice(mint: string): Promise<{ priceSOL: number; priceUsd: number } | null> {
    try {
      const headers: Record<string, string> = {};
      const apiKey = process.env.JUPITER_API_KEY;
      if (apiKey) headers["x-api-key"] = apiKey;

      // Quote 0.1 SOL worth of the token to get price
      const res = await fetch(
        `${this.config.jupiterUrl}/swap/v1/quote?inputMint=${SOL_MINT}&outputMint=${mint}&amount=100000000&slippageBps=100`,
        { headers, signal: AbortSignal.timeout(4000) }
      );
      if (!res.ok) return null;
      const q = await res.json();

      const tokensPerTenthSol = Number(q.outAmount ?? 0);
      if (tokensPerTenthSol === 0) return null;

      // Price of 1 token in SOL = 0.1 SOL / tokens_received
      const priceSOL = 0.1 / (tokensPerTenthSol / 1e9);

      // Cache SOL/USD for 30s to reduce API calls
      const solUsd = await this.getSolUsd(headers);

      return { priceSOL, priceUsd: priceSOL * solUsd };
    } catch { return null; }
  }

  private async getSolUsd(headers: Record<string, string>): Promise<number> {
    if (Date.now() - this.solUsdTimestamp < 30_000 && this.cachedSolUsd > 0) {
      return this.cachedSolUsd;
    }
    try {
      const res = await fetch(
        `${this.config.jupiterUrl}/swap/v1/quote?inputMint=${SOL_MINT}&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000000&slippageBps=50`,
        { headers, signal: AbortSignal.timeout(3000) }
      );
      if (res.ok) {
        const q = await res.json();
        const price = Number(q.outAmount ?? 0) / 1e6;
        if (price > 0) {
          this.cachedSolUsd = price;
          this.solUsdTimestamp = Date.now();
        }
      }
    } catch {}
    return this.cachedSolUsd;
  }

  // ─── BALANCE ─────────────────────────────────────────────────────────────

  private async refreshBalance(): Promise<number> {
    try {
      const bal = await this.connection.getBalance(this.wallet.publicKey);
      return bal / 1e9;
    } catch { return 0; }
  }

  // ─── DASHBOARD ───────────────────────────────────────────────────────────

  private updateDashboard(balanceSOL: number, cycleMs: number): void {
    const posStats = this.positions.getStats();
    const scanStats = this.scanner.getStats();
    const cbStats = this.circuitBreaker.getStats();
    const pumpStats = this.pumpListener.getStats();

    dashboardData = {
      bot: {
        running: this.running,
        dryRun: this.config.dryRun,
        balanceSOL: balanceSOL.toFixed(4),
        cycleMs,
      },
      positions: posStats,
      scanner: scanStats,
      circuitBreaker: cbStats,
      pumpfun: pumpStats,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DASHBOARD HTML
// ═══════════════════════════════════════════════════════════════════════════════

const DASHBOARD_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Scalp Bot</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0e17;color:#c8d6e5;font-family:'Courier New',monospace;padding:16px}
.header{color:#00ff88;font-size:20px;font-weight:bold;margin-bottom:16px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:20px}
.card{background:#141b2d;border:1px solid #1e2a45;border-radius:8px;padding:14px}
.label{color:#8899a6;font-size:11px;text-transform:uppercase;margin-bottom:4px}
.value{font-size:22px;font-weight:bold}
.sub{color:#8899a6;font-size:11px;margin-top:4px}
.green{color:#00ff88}.red{color:#ff4757}.yellow{color:#ffa502}
.section{margin-bottom:20px}.section-title{color:#8899a6;font-size:12px;margin-bottom:8px;text-transform:uppercase;letter-spacing:2px}
.log{background:#141b2d;border:1px solid #1e2a45;border-radius:8px;padding:12px;max-height:300px;overflow-y:auto;font-size:12px;line-height:1.6}
.pos{background:#1a2340;border:1px solid #2a3a60;border-radius:6px;padding:10px;margin-bottom:8px}
</style></head><body>
<div class="header">🎯 SCALP BOT <span id="status" style="font-size:14px"></span></div>

<div class="section"><div class="section-title">Performance</div>
<div class="grid">
  <div class="card"><div class="label">PnL (SOL)</div><div class="value" id="pnlSol">—</div></div>
  <div class="card"><div class="label">PnL (USD)</div><div class="value" id="pnlUsd">—</div></div>
  <div class="card"><div class="label">Win Rate</div><div class="value" id="winRate">—</div></div>
  <div class="card"><div class="label">Trades</div><div class="value" id="trades">—</div></div>
</div></div>

<div class="section"><div class="section-title">Positions</div>
<div class="grid">
  <div class="card"><div class="label">Open</div><div class="value" id="openPos">—</div></div>
  <div class="card"><div class="label">Balance</div><div class="value" id="balance">—</div><div class="sub">SOL</div></div>
  <div class="card"><div class="label">Scans</div><div class="value" id="scans">—</div></div>
  <div class="card"><div class="label">Candidates</div><div class="value" id="candidates">—</div></div>
  <div class="card"><div class="label">🎓 Graduations</div><div class="value green" id="grads">—</div></div>
</div>
<div id="positionList"></div></div>

<div class="section"><div class="section-title">Live Log</div>
<div class="log" id="log">waiting for data...</div></div>

<script>
function $(id){return document.getElementById(id)}
async function refresh(){
  try{
    const r=await fetch('/api/stats');
    const d=await r.json();
    const p=d.positions||{};
    const b=d.bot||{};
    const s=d.scanner||{};

    $('status').textContent=b.dryRun?'DRY RUN':'LIVE';
    $('status').className=b.dryRun?'yellow':'green';

    const pnl=p.totalPnlSOL||0;
    $('pnlSol').textContent=(pnl>=0?'+':'')+pnl.toFixed(4);
    $('pnlSol').className='value '+(pnl>=0?'green':'red');
    $('pnlUsd').textContent='$'+(p.totalPnlUsd||0).toFixed(2);
    $('pnlUsd').className='value '+((p.totalPnlUsd||0)>=0?'green':'red');
    $('winRate').textContent=(p.winRate||0)+'%';
    $('trades').textContent=(p.totalTrades||0)+' ('+(p.wins||0)+'W)';
    $('openPos').textContent=(p.openPositions||0)+'/'+(p.maxPositions||3);
    $('balance').textContent=b.balanceSOL||'—';
    $('scans').textContent=(s.scans||0).toLocaleString();
    $('candidates').textContent=(s.candidatesFound||0).toLocaleString();
    const pf=d.pumpfun||{};
    $('grads').textContent=(pf.graduations||0);

    // Positions
    const pl=$('positionList');
    const positions=p.positions||[];
    if(positions.length>0){
      pl.innerHTML=positions.map(pp=>{
        const c=pp.pnlPct>=0?'green':'red';
        return '<div class="pos">'+
          '<b>'+pp.symbol+'</b> — '+
          '<span class="'+c+'">'+(pp.pnlPct>=0?'+':'')+pp.pnlPct+'%</span> — '+
          pp.holdSec+'s — '+
          pp.remaining+'% remaining'+
          (pp.trailing?' 📈TRAILING':'')+'</div>';
      }).join('');
    } else {
      pl.innerHTML='<div style="color:#8899a6;font-size:12px">No open positions</div>';
    }

    // Logs
    if(d.logs&&d.logs.length>0){
      $('log').innerHTML=d.logs.map(l=>'<div>'+l+'</div>').join('');
    }
  }catch(e){console.error(e)}
}
setInterval(refresh,2000);refresh();
</script></body></html>`;

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

const bot = new ScalpBot();
bot.start().catch((err) => {
  console.error("[bot] Fatal:", err);
  process.exit(1);
});
