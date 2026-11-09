# Pearl Rigs dashboard

A small, dependency-free Node server that checks HeroMiners and Govee every 5 minutes and serves a phone-friendly dashboard. Each rig is drawn as an open-air frame holding its actual cards (from `gpus` in `rigs.json`), with its power supply showing watts at the wall; cards that are bought but not mining yet sit in boxes under "On order". It shows fleet and per-rig hashrate in TH/s, earnings, power cost, net profit, rig cost and payback.

**Hashrate units.** HeroMiners reports Pearl hashrate in difficulty-1 shares per second. Each one is 2^32 hashes, so the server multiplies every pool hashrate by 2^32 (the pool's own `realHashrate / hashrate` ratio) to show real TH/s.

**Earnings.** Each rig's expected PRL a day = its 6-hour hashrate x block reward x 86,400 / (network difficulty x 2^32). The page also shows what the pool actually paid over 7 days as a check.

**Rigs.** `rigs.json` holds each rig's name, pool worker and watts at the wall. The page's Rig setup panel can override these per device.

**GPU payoff.** `payoff.json` lists every GPU's cost in payoff order (cards marked `paid` were paid off before the tracker; `ordered` ones aren't mining yet), each SafeTrade withdrawal of USDT from selling Pearl, and the USDT still on SafeTrade. Every dollar cashed out pays off the cards top to bottom; the dates use the fleet's live net a day. Add a `cashouts` row and update `safetradeBalance` after each withdrawal, then redeploy.

**Electricity.** `electricBills` in `payoff.json` holds one row per monthly electric bill: `{ "month": "2026-11", "amount": 182.40 }`, plus an optional `"mining"` dollar amount if only part of the bill should count. Bills are an expense: they come off the cash before it pays down GPUs. Future payoff dates already subtract estimated power from the live earnings.

**Units.** Every hashrate on the page is in TH/s, the unit Pearl uses.

- `/` — the dashboard
- `/api/data` — the latest pool, plug and history data as JSON
- `/api/govee-debug` — exactly what Govee returns for each plug (no key shown). Needs `Authorization: Bearer <ADMIN_TOKEN>`, or being signed in when a password is set; otherwise it answers 404
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
| `POLL_MINUTES` | How often the server checks (default 5, between 1 and 60) |
| `DASH_PASSWORD` | Optional: lock the whole dashboard behind this password (sign-in lasts 30 days per device) |
| `ADMIN_TOKEN` | Optional: unlocks `/api/govee-debug` |

Render: start command `node pearl-dashboard/server.js`, no build step needed.

## Security

- **Locked-down page.** A Content-Security-Policy only lets the page's own script run (matched by fingerprint), so nothing injected can execute. The page can't be framed, isn't indexed by search engines, and is HTTPS-only.
- **Nothing from outside is trusted.** Pool and Govee replies are size-capped, timed out, type-checked and trimmed. Anyone can point a miner at a wallet under any worker name, so names are cleaned, capped at 64 characters, and only the 60 busiest workers are kept.
- **Less data leaves the server.** The browser gets a shortened wallet, no payout transaction ids, no Govee device addresses, and no raw upstream error text.
- **Abuse limits.** 240 requests a minute per visitor, manual pool checks at most once a minute, 8 password tries a minute, tiny request bodies only, and actions can't be triggered from another website.
- **Optional password.** Set `DASH_PASSWORD` in Render and everything except `/health` needs a sign-in. Without it, anyone who has the link can see the numbers (including cash-outs).
- **No secrets in the repo.** The wallet, Govee key and password live only in Render's environment variables.

`npm test` (inside `pearl-dashboard/`) starts the server on made-up data and runs these checks.

History is kept in memory, so it resets when the service restarts. On Render's free plan the service sleeps after about 15 minutes with nobody viewing it, and checks pause while it sleeps.
