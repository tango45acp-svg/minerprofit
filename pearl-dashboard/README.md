# Pearl Rigs dashboard

A small, dependency-free Node server that checks HeroMiners and Govee every 5 minutes and serves a holographic, phone-friendly dashboard: fleet and per-rig hashrate in TH/s, earnings, power cost, net profit, rig cost and payback.

**Hashrate units.** HeroMiners reports Pearl hashrate in difficulty-1 shares per second. Each one is 2^32 hashes, so the server multiplies every pool hashrate by 2^32 (the pool's own `realHashrate / hashrate` ratio) to show real TH/s.

**Earnings.** Each rig's expected PRL a day = its 6-hour hashrate x block reward x 86,400 / (network difficulty x 2^32). The page also shows what the pool actually paid over 7 days as a check.

**Rigs.** `rigs.json` holds each rig's name, pool worker and watts at the wall. The page's Rig setup panel can override these per device.

**GPU payoff.** `payoff.json` lists every GPU's cost in payoff order (cards marked `paid` were paid off before the tracker; `ordered` ones aren't mining yet), each SafeTrade withdrawal of USDT from selling Pearl, and the USDT still on SafeTrade. Every dollar cashed out pays off the cards top to bottom; the dates use the fleet's live net a day. Add a `cashouts` row and update `safetradeBalance` after each withdrawal, then redeploy.

- `/` — the dashboard
- `/api/data` — the latest pool, plug and history data as JSON
- `/api/govee-debug` — exactly what Govee returns for each plug (no key shown)
- `/health` — health check

## Environment variables (set in Render, never committed)

| Key | What it is |
| --- | --- |
| `PRL_WALLET` | Pearl payout address mined to on HeroMiners |
| `GOVEE_API_KEY` | Govee developer API key |
| `POWER_RATE` | Electricity price in $/kWh (default: `rate` in rigs.json, else 0.09) |
| `RIGS_JSON` | Optional: replaces rigs.json with this JSON |
| `PAYOFF_JSON` | Optional: replaces payoff.json with this JSON |
| `EST_TOTAL_WATTS` | Fallback total watts when no plug reports power (default 1500) |
| `POLL_MINUTES` | How often the server checks (default 5) |

Render: start command `node pearl-dashboard/server.js`, no build step needed.

History is kept in memory, so it resets when the service restarts. On Render's free plan the service sleeps after about 15 minutes with nobody viewing it, and checks pause while it sleeps.
