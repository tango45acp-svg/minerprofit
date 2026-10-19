# Pearl Rigs dashboard

A small, dependency-free Node server that checks HeroMiners and Govee every 5 minutes and serves a phone-friendly dashboard.

- `/` — the dashboard
- `/api/data` — the latest pool, plug and history data as JSON
- `/api/govee-debug` — exactly what Govee returns for each plug (no key shown)
- `/health` — health check

## Environment variables (set in Render, never committed)

| Key | What it is |
| --- | --- |
| `PRL_WALLET` | Pearl payout address mined to on HeroMiners |
| `GOVEE_API_KEY` | Govee developer API key |
| `POWER_RATE` | Electricity price in $/kWh (default 0.09) |
| `EST_TOTAL_WATTS` | Fallback total watts when no plug reports power (default 1500) |
| `POLL_MINUTES` | How often the server checks (default 5) |

Render: start command `node pearl-dashboard/server.js`, no build step needed.

History is kept in memory, so it resets when the service restarts. On Render's free plan the service sleeps after about 15 minutes with nobody viewing it, and checks pause while it sleeps.
