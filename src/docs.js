// Machine-readable docs so agents can discover and use the API without a human.
import { listCoins } from './coins.js';
import { PRICES } from './payments.js';

const profitParams = [
  { name: 'coin', in: 'query', schema: { type: 'string' }, description: 'Coin symbol: BTC, KAS, PRL, RVN, ERG. Optional with model if the hardware mines one coin.' },
  { name: 'model', in: 'query', schema: { type: 'string' }, description: 'Hardware id(s) from /v1/hardware. Comma-separate a rig; add :N for counts, e.g. "ks0-ultra:3,ks0-pro".' },
  { name: 'hashrate', in: 'query', schema: { type: 'string' }, description: 'Raw hashrate with unit, e.g. "10TH", "440GH/s". Use with watts when not passing model.' },
  { name: 'watts', in: 'query', schema: { type: 'number' }, description: 'Wall power draw. Overrides the model spec if given.' },
  { name: 'kwh', in: 'query', schema: { type: 'number' }, description: 'Electricity price in USD per kWh (default 0.10, flagged in warnings).' },
  { name: 'pool_fee', in: 'query', schema: { type: 'number' }, description: 'Pool fee percent (default 1).' },
  { name: 'hardware_cost', in: 'query', schema: { type: 'number' }, description: 'Hardware cost in USD; adds roi_days.' },
  { name: 'price_usd', in: 'query', schema: { type: 'number' }, description: 'What-if: override coin price.' },
  { name: 'network_hashrate', in: 'query', schema: { type: 'string' }, description: 'What-if: override network hashrate, e.g. "400PH".' },
  { name: 'block_reward', in: 'query', schema: { type: 'number' }, description: 'What-if: override block reward.' },
  { name: 'block_time_sec', in: 'query', schema: { type: 'number' }, description: 'What-if: override block time.' },
];

export function openapi(baseUrl) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'MinerProfit API',
      version: '1.0.0',
      description: `Live crypto mining profitability for AI agents. Paid routes use x402 (USDC on Base): /v1/profit ${PRICES.profit}, /v1/compare ${PRICES.compare} per call, with a small free daily allowance per IP.`,
    },
    servers: [{ url: baseUrl }],
    paths: {
      '/v1/profit': {
        get: {
          operationId: 'getMiningProfit',
          summary: 'Daily/weekly/monthly mining profit for one coin',
          parameters: profitParams,
          responses: { 200: { description: 'Profit breakdown' }, 402: { description: 'Payment required (x402)' }, 400: { description: 'Bad input' } },
        },
      },
      '/v1/compare': {
        get: {
          operationId: 'compareCoins',
          summary: 'Rank every coin a rig can mine by daily profit',
          parameters: profitParams.filter((p) => ['model', 'kwh', 'pool_fee', 'hardware_cost'].includes(p.name)),
          responses: { 200: { description: 'Ranking' }, 402: { description: 'Payment required (x402)' } },
        },
      },
      '/v1/hardware': {
        get: {
          operationId: 'listHardware',
          summary: 'Supported miners and GPUs with stock hashrate and watts (free)',
          parameters: [
            { name: 'q', in: 'query', schema: { type: 'string' } },
            { name: 'coin', in: 'query', schema: { type: 'string' } },
            { name: 'type', in: 'query', schema: { type: 'string', enum: ['asic', 'gpu'] } },
          ],
          responses: { 200: { description: 'Hardware list' } },
        },
      },
      '/v1/coins': {
        get: {
          operationId: 'listCoins',
          summary: 'Supported coins; add live=1 for current price/network data (free)',
          parameters: [{ name: 'live', in: 'query', schema: { type: 'string' } }],
          responses: { 200: { description: 'Coin list' } },
        },
      },
    },
  };
}

export function llmsTxt(baseUrl) {
  const coins = listCoins().map((c) => `${c.symbol} (${c.name}, ${c.algorithm})`).join(', ');
  return `# MinerProfit

> Live crypto mining profitability API built for AI agents. Give it a coin, hardware model (or hashrate + watts) and electricity price; get daily revenue, power cost, profit, break-even electricity price and ROI.

Base URL: ${baseUrl}
Payment: x402, USDC on Base. No signup or API key. A few free calls per day per IP; after that the API answers 402 with payment requirements your x402 client can pay automatically.
MCP: ${baseUrl}/mcp (Streamable HTTP) — tools get_mining_profit, compare_coins, list_hardware

Supported coins: ${coins}

## Endpoints

- [GET /v1/profit](${baseUrl}/v1/profit?coin=KAS&model=iceriver-ks0-ultra&kwh=0.08): profit for one coin (${PRICES.profit})
- [GET /v1/compare](${baseUrl}/v1/compare?model=rtx-4090&kwh=0.10): rank coins for a rig (${PRICES.compare})
- [GET /v1/hardware](${baseUrl}/v1/hardware): hardware ids with stock specs (free)
- [GET /v1/coins](${baseUrl}/v1/coins?live=1): coins and live market data (free)
- [OpenAPI](${baseUrl}/openapi.json)

## Tips

- model accepts rigs: model=rtx-4090,rtx-4080-super or model=ks0-ultra:3
- Always pass kwh; without it $0.10/kWh is assumed and flagged in warnings.
- hardware_cost=<USD> adds roi_days.
- What-if: price_usd, network_hashrate, block_reward, block_time_sec override live data.
- Errors are JSON: {"error":{"code","message","hint"}}. 503 data_unavailable means upstream feeds are down — retry or pass what-if values.
`;
}
