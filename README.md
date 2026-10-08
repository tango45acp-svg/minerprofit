# MinerProfit

A crypto mining profitability API built for AI agents. An agent sends a coin, its hardware (or hashrate and watts), and its electricity price. The API returns live daily revenue, power cost, profit, the break-even electricity price, and ROI.

- **Pay per call with x402.** Agents pay in USDC on Base, with no signup or API key. Each IP gets a small free allowance per day.
- **MCP built in.** Agents can connect to `/mcp` directly, or run a local stdio MCP that pays from its own wallet.
- **Self-describing.** The API serves `/llms.txt` and `/openapi.json`, returns JSON errors with hints, and supports x402 Bazaar discovery metadata.
- **Keeps working when sources fail.** It pulls from chain APIs, then WhatToMine, then manual overrides. Stale data is flagged rather than failing the request.

## Quick start

```bash
npm install
npm test          # 18 tests, no network needed
npm start         # http://localhost:3000
```

```bash
curl "localhost:3000/v1/profit?coin=KAS&model=iceriver-ks0-ultra&kwh=0.08"
curl "localhost:3000/v1/profit?coin=PRL&model=rtx-4090,rtx-4080-super&kwh=0.08"
curl "localhost:3000/v1/compare?model=rtx-5070&kwh=0.08&hardware_cost=650"
```

If `PAY_TO` is not set, paid routes are free. This is dev mode.

## Endpoints

| Route | Price | What it does |
|---|---|---|
| `GET /v1/profit` | $0.002 | Profit for one coin. Pass `coin` plus either `model` or `hashrate` + `watts`, and `kwh`. |
| `GET /v1/compare` | $0.005 | Ranks every coin a rig can mine, by daily profit. |
| `GET /v1/hardware` | free | Lists hardware ids with stock hashrate and watts. Filter with `q`, `coin`, or `type`. |
| `GET /v1/coins?live=1` | free | Supported coins and live market data. |
| `POST /mcp` | free (rate-limited) | MCP tools: `get_mining_profit`, `compare_coins`, `list_hardware`. |
| `/llms.txt`, `/openapi.json`, `/` | free | Machine-readable docs. |

**Useful parameters**

- `model=rtx-4090,rtx-4080-super` sums a mixed rig.
- `model=ks0-ultra:3` counts multiple identical units.
- `hardware_cost=650` adds `roi_days`.
- `pool_fee=1` sets the pool fee in percent. The default is 1.
- What-if overrides: `price_usd`, `network_hashrate=50EH`, `block_reward`, `block_time_sec`.

## Coins and data sources

| Coin | Network data | Price |
|---|---|---|
| BTC | mempool.space (block reward includes fees) | CoinGecko |
| KAS | api.kaspa.org (10 blocks/sec) | CoinGecko |
| PRL | WhatToMine, then manual override | CoinGecko (`pearl-2`) |
| RVN, ERG | WhatToMine | CoinGecko |

Every response includes `market.sources` and a `stale` flag, so agents know where each number came from.

**Pearl note:** I couldn't find a stable public API for Pearl's network hashrate. If WhatToMine doesn't list PRL, set it manually. You can read the network numbers off any Pearl pool or explorer:

```bash
curl -X POST https://YOUR_URL/admin/overrides/PRL \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"networkHashrate":"30EH","blockReward":2640,"blockTimeSec":60,"note":"from pool stats"}'
```

Overrides are only used when live sources fail. Add `"force": true` to always use them. On Render the disk is ephemeral, so set long-lived overrides in the `OVERRIDES_JSON` env var.

## Getting paid

1. **Get a wallet.** Any EVM address works, such as Coinbase Wallet or MetaMask. Set it as `PAY_TO`. Payments arrive as USDC on Base.
2. **Test on testnet first.** Use `X402_NETWORK=base-sepolia`. Get free test USDC from the Circle faucet, then pay your own endpoint:
   ```bash
   npx awal@latest x402 pay "https://YOUR_URL/v1/profit?coin=KAS&model=ks0&kwh=0.08"
   ```
3. **Switch to mainnet.** Set `X402_NETWORK=base`, plus `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET`. These are free from portal.cdp.coinbase.com.

Prices are set with `PRICE_PROFIT` and `PRICE_COMPARE`. The free allowance is set with `FREE_CALLS_PER_DAY`.

## Deploy (Render)

1. Push this folder to a GitHub repo.
2. In Render, go to **New > Blueprint** and pick the repo. It reads `render.yaml`.
3. Fill in `PAY_TO` and `PUBLIC_URL`, and the CDP keys once you're on mainnet.
4. Check that `https://YOUR_URL/llms.txt` loads.

The Starter plan ($7/mo) stays awake. Free instances sleep, which makes an agent's first call slow.

## Get agents to find it

- **x402 Bazaar:** the paid routes declare discovery metadata. With the Coinbase facilitator on mainnet, the Bazaar can catalog them for agents browsing it. Check the CDP docs for the current listing rules.
- **MCP registries:** list `https://YOUR_URL/mcp` on the official MCP Registry, Smithery, Glama, and mcp.so.
- **Local MCP with payments:** for Claude Desktop or Claude Code:
  ```json
  {
    "mcpServers": {
      "minerprofit": {
        "command": "node",
        "args": ["/path/to/minerprofit/mcp/stdio.js"],
        "env": { "MINERPROFIT_URL": "https://YOUR_URL", "WALLET_PRIVATE_KEY": "0x...", "X402_NETWORK": "base" }
      }
    }
  }
  ```
- **People too:** post the `llms.txt` link in mining Discords and subreddits, and in your YouTube video descriptions.

## Extending

- **Add hardware:** add an entry in `src/hardware.js`. GPU specs come from Kryptex device pages; ASIC specs are manufacturer stock numbers.
- **Add a coin:** add an entry in `src/coins.js` with a WhatToMine tag, a CoinGecko id, and an optional native source in `src/sources.js`.

## Layout

```
src/
  server.js    Express app, routes, MCP endpoint, errors
  service.js   request handling shared by HTTP + MCP
  engine.js    pure profit math
  market.js    live snapshots with fallback chain + overrides
  sources.js   upstream fetchers (CoinGecko, WhatToMine, Kaspa, mempool)
  hardware.js  hardware database + rig parsing
  coins.js     coin registry
  payments.js  x402 + free tier
  docs.js      openapi.json + llms.txt
  mcp.js       MCP tool definitions
mcp/stdio.js   local MCP server that pays via x402
test/          node:test suite with mocked upstreams
```
