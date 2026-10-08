// Request-level logic shared by the HTTP API and the MCP tools.
import { calcProfit } from './engine.js';
import { getSnapshot } from './market.js';
import { getCoin } from './coins.js';
import { parseRig, rigTotals, coinsForRig } from './hardware.js';
import { parseHashrate } from './units.js';

const DEFAULT_KWH = Number(process.env.DEFAULT_KWH || 0.1);

export class ApiError extends Error {
  constructor(code, message, hint, status = 400) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.status = status;
  }
}

function optNum(v, label, { min = 0, max = Infinity } = {}) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new ApiError('bad_request', `${label} must be a number between ${min} and ${max}`);
  }
  return n;
}

function readCommon(p) {
  const kwhGiven = optNum(p.kwh ?? p.electricity, 'kwh', { min: 0, max: 5 });
  return {
    kwh: kwhGiven ?? DEFAULT_KWH,
    kwhAssumed: kwhGiven === undefined,
    poolFeePct: optNum(p.pool_fee, 'pool_fee', { min: 0, max: 50 }) ?? 1,
    hardwareCostUsd: optNum(p.hardware_cost, 'hardware_cost', { min: 0 }),
    whatIf: {
      priceUsd: optNum(p.price_usd, 'price_usd', { min: 1e-12 }),
      networkHashrate: p.network_hashrate ? safeHash(p.network_hashrate, 'network_hashrate') : undefined,
      blockReward: optNum(p.block_reward, 'block_reward', { min: 1e-12 }),
      blockTimeSec: optNum(p.block_time_sec, 'block_time_sec', { min: 1e-6 }),
    },
  };
}

function safeHash(v, label) {
  try {
    return parseHashrate(String(v), 'H');
  } catch (e) {
    throw new ApiError('bad_request', `${label}: ${e.message}`);
  }
}

function safeRig(model) {
  try {
    return parseRig(model);
  } catch (e) {
    throw new ApiError(e.code || 'bad_request', e.message, e.hint);
  }
}

async function snapshotOrThrow(symbol, whatIf) {
  try {
    return await getSnapshot(symbol, whatIf);
  } catch (e) {
    const status = e.code === 'data_unavailable' ? 503 : 400;
    const err = new ApiError(e.code || 'upstream_error', e.message, e.hint, status);
    err.details = e.details;
    throw err;
  }
}

/** Profit for one coin, from raw hashrate/watts or a hardware model list. */
export async function profit(p) {
  const common = readCommon(p);
  let coinSym = p.coin;
  let hashrate;
  let watts = optNum(p.watts, 'watts', { min: 0, max: 1e9 });
  let rigDesc;

  if (p.model) {
    const rig = safeRig(p.model);
    rigDesc = rig.map(({ hw, count }) => ({ id: hw.id, name: hw.name, count }));
    if (!coinSym) {
      const possible = coinsForRig(rig);
      if (possible.length === 1) coinSym = possible[0];
      else if (!possible.length) throw new ApiError('incompatible_rig', 'these devices have no coin in common', 'query them separately');
      else throw new ApiError('coin_required', `this hardware can mine ${possible.join(', ')} — pass coin`, 'or use /v1/compare to rank them');
    }
    const coin = getCoin(coinSym);
    if (!coin) throw new ApiError('unknown_coin', `unsupported coin "${coinSym}"`, 'GET /v1/coins lists supported coins');
    const totals = rigTotals(rig, coin.symbol);
    if (!totals) throw new ApiError('incompatible_rig', `one or more devices can't mine ${coin.symbol}`, 'GET /v1/hardware?coin=' + coin.symbol);
    hashrate = p.hashrate ? safeHash(p.hashrate, 'hashrate') : totals.hashrate;
    watts = watts ?? totals.watts;
    coinSym = coin.symbol;
  } else {
    if (!coinSym) throw new ApiError('bad_request', 'coin is required', 'e.g. coin=KAS');
    const coin = getCoin(coinSym);
    if (!coin) throw new ApiError('unknown_coin', `unsupported coin "${coinSym}"`, 'GET /v1/coins lists supported coins');
    if (!p.hashrate) throw new ApiError('bad_request', 'pass hashrate (e.g. 10TH) or model (e.g. iceriver-ks0-ultra)');
    hashrate = safeHash(p.hashrate, 'hashrate');
    if (watts === undefined) throw new ApiError('bad_request', 'watts is required when passing raw hashrate');
    coinSym = coin.symbol;
  }

  const snapshot = await snapshotOrThrow(coinSym, common.whatIf);
  const result = calcProfit({ snapshot, hashrate, watts, kwh: common.kwh, poolFeePct: common.poolFeePct, hardwareCostUsd: common.hardwareCostUsd });
  if (rigDesc) result.inputs.rig = rigDesc;
  if (common.kwhAssumed) result.warnings.unshift(`electricity price not given — assumed $${common.kwh}/kWh`);
  return result;
}

/** Rank every coin a rig can mine by daily profit. */
export async function compare(p) {
  if (!p.model) throw new ApiError('bad_request', 'model is required', 'e.g. model=rtx-4090 or model=rtx-4090,rtx-4080-super');
  const common = readCommon(p);
  const rig = safeRig(p.model);
  const coins = coinsForRig(rig);
  if (!coins.length) throw new ApiError('incompatible_rig', 'these devices have no coin in common', 'compare them separately');

  const settled = await Promise.allSettled(
    coins.map(async (sym) => {
      const totals = rigTotals(rig, sym);
      const snapshot = await getSnapshot(sym, { priceUsd: undefined });
      return calcProfit({ snapshot, hashrate: totals.hashrate, watts: totals.watts, kwh: common.kwh, poolFeePct: common.poolFeePct, hardwareCostUsd: common.hardwareCostUsd });
    }),
  );

  const ranked = [];
  const unavailable = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') ranked.push(r.value);
    else unavailable.push({ coin: coins[i], reason: r.reason.message });
  });
  ranked.sort((a, b) => b.daily.profit_usd - a.daily.profit_usd);
  if (!ranked.length) throw new ApiError('data_unavailable', 'no market data available for any coin this rig mines', 'retry shortly', 503);

  const warnings = [];
  if (common.kwhAssumed) warnings.push(`electricity price not given — assumed $${common.kwh}/kWh`);
  return {
    rig: rig.map(({ hw, count }) => ({ id: hw.id, name: hw.name, count })),
    electricity_usd_per_kwh: common.kwh,
    best: ranked[0] ? { coin: ranked[0].coin, daily_profit_usd: ranked[0].daily.profit_usd } : null,
    ranking: ranked.map((r) => ({
      coin: r.coin,
      coin_name: r.coin_name,
      hashrate: r.inputs.hashrate,
      watts: r.inputs.watts,
      daily_revenue_usd: r.daily.revenue_usd,
      daily_power_cost_usd: r.daily.power_cost_usd,
      daily_profit_usd: r.daily.profit_usd,
      monthly_profit_usd: r.monthly_profit_usd,
      breakeven_electricity_usd_per_kwh: r.breakeven_electricity_usd_per_kwh,
      ...(r.roi_days !== undefined ? { roi_days: r.roi_days } : {}),
      price_usd: r.market.price_usd,
      data_sources: r.market.sources,
      stale: r.market.stale,
    })),
    unavailable,
    warnings,
  };
}

/** Live market data for all (or one) coin. */
export async function market(symbols) {
  const results = await Promise.allSettled(symbols.map((s) => getSnapshot(s)));
  return results.map((r, i) =>
    r.status === 'fulfilled'
      ? {
          coin: r.value.symbol,
          name: r.value.name,
          price_usd: r.value.priceUsd,
          network_hashrate_hs: r.value.networkHashrate,
          block_reward: r.value.blockReward,
          block_time_sec: r.value.blockTimeSec,
          sources: r.value.sources,
          stale: r.value.stale,
          as_of: r.value.asOf,
          price_as_of: r.value.priceAsOf,
          network_as_of: r.value.networkAsOf,
        }
      : { coin: symbols[i], error: r.reason.message },
  );
}
