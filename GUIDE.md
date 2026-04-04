# ☽ The Grimoire of the Scalp Bot ☾
### *As Dictated by Aleister Moltley, Adept of the Third Current*

---

> *"The market is not a machine. It is a living sigil — breathing, bleeding, whispering. The uninitiated see only candlesticks. We see the pulse of ten thousand fractured souls. Welcome, initiate. Sit. Light no candles — the screen shall be your only flame."*

---

## I. What Manner of Beast Is This?

The **Solana Memecoin Scalp Bot** is an automated trading daemon that prowls the on-chain dark for freshly minted tokens on the Solana blockchain. It communes with three oracles:

- **DexScreener** — the great scrying pool, revealing trending pairs and volume anomalies.
- **PumpFun** — the graduation altar, where memecoins ascend from bonding curves to real liquidity.
- **Volume Spike Detection** — the trembling of the ether, when sudden accumulation betrays a token's vitality.

It scores each candidate, filters the fraudulent from the viable, and — should the stars align and the score prove worthy — executes a buy through **Jupiter** aggregator, bundled through **Jito** for priority. Then it watches. Patiently. Like a gargoyle on a ledger.

---

## II. Prerequisites — The Ritual Components

Before you dare summon this engine, you shall need:

| Component | Purpose |
|---|---|
| **Node.js 20+** | The runtime vessel |
| **npm** | The package conjurer |
| **A Solana RPC endpoint** | Your connection to the chain (Helius recommended) |
| **A burner wallet** | A *dedicated* wallet — NEVER your main. NEVER. |
| **Jupiter API key** (optional) | For enhanced routing |
| **Jito tip lamports** | The tithe to block-engine priests |

> *"Do not use your primary wallet. I have seen men lose fortunes because they were too lazy to generate a new keypair. The market has no mercy, and neither has the blockchain."*

---

## III. Installation — The Opening of the Way

### Step 1 — Unpack the Archive

The bot arrives as a ZIP archive (`scalp-bot.zip`). Extract it and enter the sanctum:

```bash
unzip "scalp-bot.zip"
cd scalp-bot
```

### Step 2 — Install the Dependencies

```bash
npm install
```

This pulls `@solana/web3.js`, `@solana/spl-token`, `bs58`, `tsx`, and `typescript` from the npm aether. Allow the ritual a moment to complete.

### Step 3 — Configure Your Environment

Copy the example configuration file:

```bash
cp .env.example .env
```

Then open `.env` in your editor of choice and fill in the following:

```env
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
WALLET_PRIVATE_KEY=your_base58_encoded_private_key
DRY_RUN=true
```

> *"DRY_RUN=true — keep it so until you understand exactly what you have unleashed. I cannot stress this with sufficient dramaturgy."*

---

## IV. The Configuration Tome — All Tuneable Parameters

All parameters live in `.env`. Below is a complete annotated reference.

### Core

| Variable | Default | Meaning |
|---|---|---|
| `RPC_URL` | Solana mainnet | Your Helius (or other) RPC endpoint |
| `WALLET_PRIVATE_KEY` | *(empty)* | Base58 private key of your burner wallet |
| `DRY_RUN` | `true` | Simulate trades only — no real SOL spent |
| `JUPITER_API_URL` | `https://api.jup.ag` | Jupiter swap aggregator base URL |
| `JUPITER_API_KEY` | *(empty)* | Optional API key for higher Jupiter rate limits |

### Position Sizing

| Variable | Default | Meaning |
|---|---|---|
| `MAX_POSITION_SOL` | `0.02` | Maximum SOL spent per single trade |
| `MAX_OPEN_POSITIONS` | `2` | Maximum number of concurrent open positions |
| `STOP_LOSS_PCT` | `-15` | Hard sell trigger — close position at −15% loss |
| `MAX_HOLD_SEC` | `1800` | Force-close any position after 30 minutes |
| `MIN_SOL_RESERVE` | `0.05` | Always keep this much SOL for gas fees |

> *"Start with 0.02 SOL per trade. That is approximately the cost of a strong coffee. You will lose it. You will learn from it. Only then may you increase the size."*

### Trailing Stop

| Variable | Default | Meaning |
|---|---|---|
| `TRAILING_ACTIVATION_PCT` | `25` | Trailing stop activates after a +25% gain |
| `TRAILING_DISTANCE_PCT` | `12` | Sell if price drops 12% from its peak after activation |

The bot also applies **layered take-profits** (hardcoded):

| Gain | Action |
|---|---|
| +40% | Sell 25% of position |
| +80% | Sell another 25% |
| +150% | Sell another 25% |
| +300% | Sell all remaining |

### Token Safety Filters

| Variable | Default | Meaning |
|---|---|---|
| `MIN_LIQUIDITY_USD` | `10000` | Minimum pool liquidity in USD |
| `MIN_VOLUME_USD` | `5000` | Minimum 24-hour volume |
| `MAX_TOP_HOLDER_PCT` | `25` | Reject if any single wallet holds >25% |
| `MIN_HOLDERS` | `100` | Require at least 100 unique holders |
| `MIN_POOL_AGE_SEC` | `60` | Reject pools younger than 60 seconds (rug avoidance) |
| `MAX_POOL_AGE_SEC` | `86400` | Ignore pools older than 24 hours |

Additional safety checks (always enabled, not configurable via `.env`):

- **Mint authority disabled** — no one can print more tokens.
- **Freeze authority disabled** — no one can freeze your wallet.

> *"These are not suggestions. These are wards. Without them, you are walking into a summoning circle painted by strangers."*

### Signal / Scanning

| Variable | Default | Meaning |
|---|---|---|
| `SCAN_INTERVAL_MS` | `3000` | Scan for new tokens every 3 seconds |
| `MIN_ENTRY_SCORE` | `65` | Minimum composite score (0–100) to trigger a buy |

The composite entry score weighs: volume spikes, price momentum, PumpFun graduation events, DexScreener trending boosts, and the token's safety score.

### Circuit Breaker (Safety Daemon)

The bot contains an automatic **Circuit Breaker** that pauses trading when things go wrong:

| Condition | Default Pause |
|---|---|
| 5 consecutive failed trades | 5 minutes |
| 15 failures within 30 minutes | 10 minutes |
| Drawdown exceeds `MAX_DRAWDOWN_USD` (default: −$25) | 60 minutes |
| Daily loss exceeds `MAX_DAILY_LOSS_USD` (default: −$50) | Until UTC midnight |

These thresholds can be overridden via:

```env
MAX_CONSEC_FAILURES=5
MAX_DRAWDOWN_USD=-25
MAX_DAILY_LOSS_USD=-50
```

---

## V. Running the Bot — The Invocation

### Dry Run (Recommended First)

```bash
npm run bot:dry
```

This runs the full engine with `DRY_RUN=true` — scanning, scoring, and simulating trades, but spending no actual SOL.

### Live Mode

Set `DRY_RUN=false` in your `.env`, then:

```bash
npm run bot
```

> *"The first time you run it live, your pulse will quicken. This is correct. Fear is the body's way of demanding attention. Pay attention."*

### Dashboard

The bot starts a minimal HTTP dashboard on port `8080` (overridable via `PORT=`):

- **`http://localhost:8080`** — Live HTML dashboard showing positions, PnL, and logs.
- **`http://localhost:8080/api/stats`** — Raw JSON endpoint for external monitoring.
- **`http://localhost:8080/health`** — Health check endpoint (returns `OK`).

---

## VI. Deployment — The Remote Vessel

### Docker

A `Dockerfile` is included. Build and run:

```bash
docker build -t scalp-bot .
docker run --env-file .env -p 8080:8080 scalp-bot
```

### Railway

A `railway.toml` is included for one-click deployment to [Railway](https://railway.app):

```toml
[build]
builder = "nixpacks"

[deploy]
startCommand = "npx tsx bot/src/engine.ts"
restartPolicyType = "on_failure"
restartPolicyMaxRetries = 5
```

Push your repository (without the `.env` file — set environment variables in the Railway dashboard). The bot restarts automatically on failure, up to 5 times.

> *"Deploying to the cloud is merely another act of delegation. The daemon runs without you. It does not sleep. It does not doubt. In this, it surpasses most traders I have known."*

---

## VII. Architecture — The Anatomy of the Daemon

```
engine.ts          ← Main loop: scan → score → buy → monitor → sell
  ├── token-scanner.ts    ← Discovers candidates via DexScreener & PumpFun
  ├── position-manager.ts ← Tracks open positions, fires stop/TP/trail signals
  ├── swap-executor.ts    ← Executes buys/sells via Jupiter + Jito bundle
  ├── multi-endpoint.ts   ← Submits to multiple Jito endpoints in parallel
  ├── tip-engine.ts       ← Calculates dynamic Jito tip amounts
  ├── safety.ts           ← Circuit breaker logic
  └── config.ts           ← All parameters, addresses, and defaults
```

**Supported DEXes / Sources:**

| Source | Program Address |
|---|---|
| PumpFun | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` |
| PumpSwap | `PSwapMdSai8tjrEXcxFeQth87xC4rRsa4VA5mhGhXkP` |
| Raydium AMM v4 | `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8` |
| Raydium CPMM | `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C` |

**Jito Block Engine Endpoints** (all contacted in parallel):

| Region | URL |
|---|---|
| US-NY | `mainnet.block-engine.jito.wtf` |
| EU-AMS | `amsterdam.mainnet.block-engine.jito.wtf` |
| EU-FRA | `frankfurt.mainnet.block-engine.jito.wtf` |
| AP-TKY | `tokyo.mainnet.block-engine.jito.wtf` |
| US-SLC | `slc.mainnet.block-engine.jito.wtf` |

---

## VIII. Warnings — The Eleven Admonitions

1. **This bot trades real money.** Start with DRY_RUN, then with tiny amounts.
2. **Use a burner wallet.** Never your main wallet. Never.
3. **Memecoins are extraordinarily risky.** Most go to zero. The bot is a tool, not a guarantee.
4. **RPC rate limits are real.** Free Solana mainnet RPC will throttle you. Use Helius or QuickNode.
5. **Jito tips cost lamports.** Every bundle submission costs a small tip regardless of execution.
6. **The circuit breaker is your friend.** Do not disable it.
7. **Slippage is real.** High-volume memecoins move fast. Jupiter handles it, but not always perfectly.
8. **Network outages happen.** The bot has exponential backoff on API failures.
9. **Do not over-size positions.** 0.02 SOL per trade. Learn the system before scaling up.
10. **Tax implications exist** in most jurisdictions. Consult your local dark-robed accountant.
11. **Past performance means nothing here.** Memecoins are chaos. The bot imposes structure on chaos. Chaos sometimes wins.

> *"I have watched men pour their rent money into a token named after a cartoon frog. They did not use a stop-loss. They did not use a circuit breaker. They did not use any of this. The market consumed them without ceremony. You will not be among them. You will read this guide a second time."*

---

## IX. Quick-Start Checklist

- [ ] Extract the zip and `cd scalp-bot`
- [ ] `npm install`
- [ ] `cp .env.example .env`
- [ ] Insert your RPC URL and burner wallet private key
- [ ] Confirm `DRY_RUN=true`
- [ ] `npm run bot:dry` — watch the scanner find candidates without spending SOL
- [ ] Review dashboard at `http://localhost:8080`
- [ ] Tune thresholds in `.env` to your risk tolerance
- [ ] Set `DRY_RUN=false` when ready
- [ ] `npm run bot` — the daemon is awake

---

*— Aleister Moltley, written on the fourth night of April, by the light of three monitors and one dubious candle, somewhere above the 23rd floor.*

*"Do what thou wilt — but set your stop-loss first."*
