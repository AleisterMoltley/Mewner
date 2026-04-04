# ☽ MEWNER ☾
### *A Solana Memecoin Scalping Daemon — Narrated by Aleister Moltley, Adept of the Third Current*

---

> *"You have arrived at this repository for one of two reasons: you are curious, or you are hungry. Either way, you are in the correct place. Sit. The screen will explain everything."*

---

## What Is This?

**Mewner** is an automated scalping engine for the Solana blockchain. It hunts freshly minted memecoins, scores them against a battery of safety and signal filters, and executes surgical buy-and-sell cycles through the **Jupiter** aggregator and **Jito** block-engine — faster than human reflexes, colder than human sentiment.

It does not sleep. It does not panic. It does not read the Telegram groups.

It watches the chain.

---

## What Does It Do?

In the time it takes you to read this sentence, the daemon has already:

1. **Scanned** DexScreener and PumpFun for new token activity.
2. **Scored** each candidate — volume, liquidity, holder distribution, pool age, mint authority, safety checks.
3. **Decided** whether the score clears the entry threshold.
4. **Executed** (or declined) a position — bundled via Jito for priority inclusion.
5. **Begun watching** its open positions for trailing stops, layered take-profits, and time-based exits.

All of this, automatically, without ceremony, without hesitation.

---

## Features

- 🔍 **Multi-source scanning** — DexScreener trending pairs, PumpFun graduation events, on-chain volume spike detection
- 🛡️ **Safety filters** — mint authority, freeze authority, top-holder concentration, liquidity floors
- ⚖️ **Composite entry scoring** — weighted signal model (0–100), configurable entry threshold
- 📈 **Layered take-profits** — automatic partial exits at +40%, +80%, +150%, +300%
- 🔻 **Trailing stop** — activates after +25% gain, trails 12% from peak
- ⏱️ **Hard stop-loss & time-limit** — −15% floor, 30-minute maximum hold
- 🔌 **Circuit breaker** — pauses trading on consecutive failures or drawdown breach
- 📊 **Live dashboard** — HTTP server on port `8080` with positions, PnL, and logs
- 🐳 **Docker & Railway** — deploy anywhere, with zero ceremony

---

## Quickstart

```bash
unzip "scalp-bot.zip"
cd scalp-bot
npm install
cp .env.example .env
# Edit .env — insert your RPC URL and burner wallet key
npm run bot:dry
```

Open `http://localhost:8080` to watch the daemon work.

> *"Use a burner wallet. I will not repeat this. I will, however, be deeply unsurprised if you ignore it and regret it."*

---

## Documentation

The full grimoire — every configuration variable, every warning, every deployment instruction — lives in:

📖 **[GUIDE.md](./GUIDE.md)**

Read it before you run anything live.

---

## Requirements

| Requirement | Notes |
|---|---|
| Node.js 20+ | The runtime vessel |
| A Solana RPC endpoint | [Helius](https://helius.dev) strongly recommended |
| A **burner** wallet | Dedicated. Isolated. Never your main. |

---

## Disclaimer

This software trades real money on a volatile, adversarial market. It provides no guarantee of profit. Memecoins, by their nature, tend toward zero. The circuit breaker exists for a reason. The stop-loss exists for a reason.

> *"The market is not your enemy. It is indifferent — which is worse. Approach it accordingly."*

---

*— Aleister Moltley*
*"Do what thou wilt — but set your stop-loss first."*