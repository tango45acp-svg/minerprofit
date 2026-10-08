import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFetchMock, startApp, down, MOCK } from './helpers.js';

process.env.OVERRIDES_FILE = '/nonexistent/overrides.json'; // start with no overrides
installFetchMock();

const { parseHashrate, formatHashrate } = await import('../src/units.js');
const { calcProfit } = await import('../src/engine.js');
const { cache } = await import('../src/market.js');

let app;
before(async () => {
  app = await startApp({ PAY_TO: '' });
});
after(() => app.close());
beforeEach(() => {
  down.clear();
  cache.clear();
});

const get = async (path) => {
  const res = await fetch(app.base + path);
  return { status: res.status, body: await res.json(), headers: res.headers };
};

// ---------- units / engine ----------

test('parses hashrate strings', () => {
  assert.equal(parseHashrate('10TH'), 10e12);
  assert.equal(parseHashrate('440 GH/s'), 440e9);
  assert.equal(parseHashrate('65mh'), 65e6);
  assert.equal(parseHashrate('1.5e12'), 1.5e12);
  assert.throws(() => parseHashrate('fast'));
  assert.throws(() => parseHashrate('-5TH'));
  assert.equal(formatHashrate(4.4e11), '440 GH/s');
});

test('engine math matches hand calculation', () => {
  const r = calcProfit({
    snapshot: { symbol: 'X', name: 'X', algorithm: 'a', networkHashrate: 1e15, blockReward: 10, blockTimeSec: 60, priceUsd: 2, sources: {}, asOf: '', stale: false },
    hashrate: 1e12, // 0.1% of network
    watts: 1000,
    kwh: 0.1,
    poolFeePct: 0,
    hardwareCostUsd: 100,
  });
  // 1440 blocks * 10 * 0.001 = 14.4 coins -> $28.80; power 24kWh * 0.1 = $2.40
  assert.equal(r.daily.coins, 14.4);
  assert.equal(r.daily.revenue_usd, 28.8);
  assert.equal(r.daily.power_cost_usd, 2.4);
  assert.equal(r.daily.profit_usd, 26.4);
  assert.equal(r.breakeven_electricity_usd_per_kwh, 1.2);
  assert.equal(r.roi_days, 3.8);
});

// ---------- HTTP ----------

test('index, llms.txt and openapi are served', async () => {
  const idx = await get('/');
  assert.equal(idx.status, 200);
  assert.ok(idx.body.endpoints['GET /v1/profit']);
  const llms = await fetch(app.base + '/llms.txt').then((r) => r.text());
  assert.match(llms, /# MinerProfit/);
  const spec = await get('/openapi.json');
  assert.ok(spec.body.paths['/v1/profit']);
});

test('KAS profit for a KS0 Ultra uses chain data', async () => {
  const { status, body } = await get('/v1/profit?coin=KAS&model=iceriver-ks0-ultra&kwh=0.08');
  assert.equal(status, 200);
  // share 400e9/400e15 = 1e-6; 864000 blocks * 2.6 * 1e-6 * 0.99 = 2.22394 KAS
  assert.equal(body.daily.coins, 2.2239);
  assert.equal(body.daily.power_cost_usd, 0.19); // 0.1kW*24*0.08
  assert.equal(body.market.sources.network, 'chain_api');
  assert.equal(body.market.sources.price, 'coingecko');
  assert.equal(body.inputs.watts, 100);
});

test('coin is inferred when the model mines one coin; aliases work', async () => {
  const { status, body } = await get('/v1/profit?model=ks0ultra:3&kwh=0.08');
  assert.equal(status, 200);
  assert.equal(body.coin, 'KAS');
  assert.equal(body.inputs.watts, 300);
  assert.equal(body.inputs.hashrate, '1.2 TH/s');
});

test('multi-GPU rig sums hashrate and watts', async () => {
  const { status, body } = await get('/v1/profit?coin=PRL&model=rtx-4090,rtx-4080-super&kwh=0.08&hardware_cost=650');
  assert.equal(status, 200);
  assert.equal(body.inputs.hashrate, '496 TH/s');
  assert.equal(body.inputs.watts, 720);
  assert.equal(body.market.sources.network, 'whattomine');
  assert.ok('roi_days' in body);
});

test('raw hashrate + watts works for BTC', async () => {
  const { status, body } = await get('/v1/profit?coin=btc&hashrate=200TH&watts=3500&kwh=0.05');
  assert.equal(status, 200);
  // share 2e-7 * 144 * 3.2 * 0.99 = 0.0000912384 BTC
  assert.equal(body.daily.coins, 0.00009124);
  assert.equal(body.daily.revenue_usd, 9.12);
});

test('falls back to WhatToMine when the Kaspa API is down', async () => {
  down.add('api.kaspa.org');
  const { status, body } = await get('/v1/profit?coin=KAS&hashrate=1TH&watts=100&kwh=0.1');
  assert.equal(status, 200);
  assert.equal(body.market.sources.network, 'whattomine');
});

test('returns a clean 503 when every price source is down', async () => {
  down.add('api.coingecko.com');
  const { status, body } = await get('/v1/profit?coin=PRL&model=rtx-4090&kwh=0.1');
  // with coingecko down we also lose the BTC price, so expect a clean 503
  assert.equal(status, 503);
  assert.equal(body.error.code, 'data_unavailable');
});

test('what-if values let agents price a coin with no live data', async () => {
  down.add('whattomine.com');
  const fail = await get('/v1/profit?coin=PRL&model=rtx-4090&kwh=0.1');
  assert.equal(fail.status, 503);
  assert.ok(fail.body.error.hint);
  const ok = await get('/v1/profit?coin=PRL&model=rtx-4090&kwh=0.1&network_hashrate=50EH&block_reward=2640&block_time_sec=60');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.market.sources.network, 'caller_supplied');
});

test('compare ranks every coin a 4090 can mine', async () => {
  const { status, body } = await get('/v1/compare?model=rtx-4090&kwh=0.1');
  assert.equal(status, 200);
  assert.deepEqual(body.ranking.map((r) => r.coin).sort(), ['ERG', 'PRL', 'RVN']);
  const profits = body.ranking.map((r) => r.daily_profit_usd);
  assert.deepEqual(profits, [...profits].sort((a, b) => b - a));
  assert.equal(body.best.coin, body.ranking[0].coin);
});

test('helpful errors for bad input', async () => {
  let r = await get('/v1/profit?coin=KAS&model=ks99');
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'unknown_model');
  assert.ok(r.body.error.hint);
  r = await get('/v1/profit?coin=DOGE&hashrate=1GH&watts=10');
  assert.equal(r.body.error.code, 'unknown_coin');
  r = await get('/v1/profit?coin=BTC&model=rtx-4090');
  assert.equal(r.body.error.code, 'incompatible_rig');
  r = await get('/v1/profit?model=rtx-4090');
  assert.equal(r.body.error.code, 'coin_required');
  r = await get('/v1/profit?coin=KAS&hashrate=1TH');
  assert.match(r.body.error.message, /watts/);
});

test('missing kwh is flagged, not silently assumed', async () => {
  const { body } = await get('/v1/profit?coin=KAS&model=ks0');
  assert.match(body.warnings[0], /assumed \$0\.1\/kWh/);
});

test('hardware search', async () => {
  const { body } = await get('/v1/hardware?coin=PRL');
  assert.ok(body.hardware.every((h) => h.coins.PRL));
  assert.ok(body.hardware.find((h) => h.id === 'rtx-5070'));
});

test('coins live endpoint', async () => {
  const { body } = await get('/v1/coins?live=1');
  const kas = body.coins.find((c) => c.symbol === 'KAS');
  assert.equal(kas.live.price_usd, MOCK.prices.kaspa);
});

// ---------- MCP ----------

async function mcp(method, params, id = 1) {
  const res = await fetch(app.base + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return res.json();
}

test('hosted MCP lists and runs tools', async () => {
  const init = await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'minerprofit');
  const list = await mcp('tools/list', {});
  assert.deepEqual(list.result.tools.map((t) => t.name).sort(), ['compare_coins', 'get_mining_profit', 'list_hardware']);
  const call = await mcp('tools/call', { name: 'get_mining_profit', arguments: { coin: 'KAS', model: 'ks0-pro', kwh: 0.08 } });
  const data = JSON.parse(call.result.content[0].text);
  assert.equal(data.coin, 'KAS');
  const bad = await mcp('tools/call', { name: 'get_mining_profit', arguments: { model: 'nope' } });
  assert.equal(bad.result.isError, true);
});
