// Assembles a live "snapshot" per coin with a fallback chain:
//   network: native chain API -> WhatToMine -> manual override
//   price:   CoinGecko -> WhatToMine BTC rate x BTC price -> manual override
// Every snapshot reports which source it used and whether data is stale.
import fs from 'node:fs';
import path from 'node:path';
import { TTLCache } from './cache.js';
import { COINS, getCoin } from './coins.js';
import { coingeckoPrices, whattomineCoins } from './sources.js';
import { parseHashrate } from './units.js';

const NETWORK_TTL = Number(process.env.NETWORK_TTL_MS || 60_000);
const PRICE_TTL = Number(process.env.PRICE_TTL_MS || 60_000);
const WTM_TTL = Number(process.env.WTM_TTL_MS || 120_000);

export const cache = new TTLCache();

// ---------- Manual overrides ----------

const OVERRIDES_FILE = process.env.OVERRIDES_FILE || path.resolve('data/overrides.json');
let overrides = loadOverrides();

function loadOverrides() {
  let fromFile = {};
  try {
    fromFile = JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8'));
  } catch { /* missing file is fine */ }
  let fromEnv = {};
  try {
    if (process.env.OVERRIDES_JSON) fromEnv = JSON.parse(process.env.OVERRIDES_JSON);
  } catch (e) {
    console.warn('OVERRIDES_JSON is not valid JSON, ignoring:', e.message);
  }
  const merged = {};
  for (const [k, v] of Object.entries({ ...fromFile, ...fromEnv })) {
    if (k.startsWith('_')) continue;
    merged[k.toUpperCase()] = v;
  }
  return merged;
}

export function getOverrides() {
  return overrides;
}

/** Validate + store an override for one coin. Persists to disk best-effort. */
export function setOverride(symbol, data) {
  const coin = getCoin(symbol);
  if (!coin) throw Object.assign(new Error(`unknown coin "${symbol}"`), { code: 'unknown_coin' });
  const o = {};
  if (data.networkHashrate !== undefined) o.networkHashrate = parseHashrate(data.networkHashrate, 'H');
  if (data.blockReward !== undefined) o.blockReward = positive(data.blockReward, 'blockReward');
  if (data.blockTimeSec !== undefined) o.blockTimeSec = positive(data.blockTimeSec, 'blockTimeSec');
  if (data.priceUsd !== undefined) o.priceUsd = positive(data.priceUsd, 'priceUsd');
  if (data.force !== undefined) o.force = Boolean(data.force);
  if (data.note) o.note = String(data.note).slice(0, 300);
  o.updatedAt = new Date().toISOString();
  overrides = { ...overrides, [coin.symbol]: { ...(overrides[coin.symbol] || {}), ...o } };
  try {
    fs.mkdirSync(path.dirname(OVERRIDES_FILE), { recursive: true });
    fs.writeFileSync(OVERRIDES_FILE, JSON.stringify(overrides, null, 2));
  } catch (e) {
    console.warn('could not persist overrides:', e.message);
  }
  cache.clear();
  return overrides[coin.symbol];
}

function positive(v, label) {
  const n = Number(v);
  if (!(n > 0)) throw Object.assign(new Error(`${label} must be a positive number`), { code: 'bad_request' });
  return n;
}

function overrideNetwork(sym) {
  const o = overrides[sym];
  if (!o) return null;
  const nh = typeof o.networkHashrate === 'string' ? parseHashrate(o.networkHashrate) : o.networkHashrate;
  if (nh > 0 && o.blockReward > 0 && o.blockTimeSec > 0) {
    return { networkHashrate: nh, blockReward: o.blockReward, blockTimeSec: o.blockTimeSec };
  }
  return null;
}

// ---------- Fetch helpers ----------

async function wtm() {
  return cache.get('wtm', WTM_TTL, whattomineCoins);
}

async function allPrices() {
  const ids = Object.values(COINS).map((c) => c.coingeckoId).filter(Boolean);
  return cache.get('prices', PRICE_TTL, () => coingeckoPrices(ids));
}

async function networkFor(coin) {
  const errors = [];
  const ov = overrides[coin.symbol];
  if (ov?.force) {
    const n = overrideNetwork(coin.symbol);
    if (n) return { ...n, source: 'manual_override', stale: false, at: Date.parse(ov.updatedAt) || Date.now() };
  }
  if (coin.native) {
    try {
      const r = await cache.get(`net:${coin.symbol}`, NETWORK_TTL, coin.native);
      return { ...r.value, source: 'chain_api', stale: r.stale, at: r.at };
    } catch (e) {
      errors.push(`chain_api: ${e.message}`);
    }
  }
  if (coin.wtmTag) {
    try {
      const r = await wtm();
      const c = r.value[coin.wtmTag];
      if (c) return { ...c, source: 'whattomine', stale: r.stale || c.lagging, at: r.at };
      errors.push(`whattomine: ${coin.wtmTag} not listed`);
    } catch (e) {
      errors.push(`whattomine: ${e.message}`);
    }
  }
  const n = overrideNetwork(coin.symbol);
  if (n) return { ...n, source: 'manual_override', stale: false, at: Date.parse(ov.updatedAt) || Date.now() };
  const err = new Error(`no network data available for ${coin.symbol}`);
  err.code = 'data_unavailable';
  err.details = errors;
  err.hint = 'Retry shortly, or pass network_hashrate, block_reward and block_time_sec to compute a what-if';
  throw err;
}

async function priceFor(coin) {
  const errors = [];
  const ov = overrides[coin.symbol];
  if (ov?.force && ov.priceUsd) return { priceUsd: ov.priceUsd, source: 'manual_override', stale: false, at: Date.now() };
  try {
    const r = await allPrices();
    const p = r.value[coin.coingeckoId];
    if (p) return { priceUsd: p, source: 'coingecko', stale: r.stale, at: r.at };
    errors.push(`coingecko: no price for ${coin.coingeckoId}`);
  } catch (e) {
    errors.push(`coingecko: ${e.message}`);
  }
  if (coin.wtmTag) {
    try {
      const [w, prices] = await Promise.all([wtm(), allPrices()]);
      const rate = w.value[coin.wtmTag]?.exchangeRateBtc;
      const btc = prices.value.bitcoin;
      if (rate > 0 && btc > 0) return { priceUsd: rate * btc, source: 'whattomine_btc_rate', stale: w.stale || prices.stale, at: w.at };
    } catch (e) {
      errors.push(`whattomine: ${e.message}`);
    }
  }
  if (ov?.priceUsd) return { priceUsd: ov.priceUsd, source: 'manual_override', stale: false, at: Date.parse(ov.updatedAt) || Date.now() };
  const err = new Error(`no price available for ${coin.symbol}`);
  err.code = 'data_unavailable';
  err.details = errors;
  err.hint = 'Retry shortly, or pass price_usd to compute a what-if';
  throw err;
}

/**
 * Live snapshot for a coin. `what_if` values (from the caller) replace live
 * ones, so an agent can model "what if price doubles" or a coin we lack data for.
 */
export async function getSnapshot(symbol, whatIf = {}) {
  const coin = getCoin(symbol);
  if (!coin) {
    const e = new Error(`unsupported coin "${symbol}"`);
    e.code = 'unknown_coin';
    e.hint = `supported: ${Object.keys(COINS).join(', ')}`;
    throw e;
  }

  const haveNet = whatIf.networkHashrate && whatIf.blockReward && whatIf.blockTimeSec;
  const [net, price] = await Promise.all([
    haveNet ? null : networkFor(coin).catch((e) => e),
    whatIf.priceUsd ? null : priceFor(coin).catch((e) => e),
  ]);
  // Only fail if a value we need is missing and wasn't supplied.
  const merged = {};
  for (const [k, live] of [['networkHashrate', net], ['blockReward', net], ['blockTimeSec', net]]) {
    if (whatIf[k]) merged[k] = whatIf[k];
    else if (live instanceof Error) throw live;
    else merged[k] = live[k];
  }
  if (whatIf.priceUsd) merged.priceUsd = whatIf.priceUsd;
  else if (price instanceof Error) throw price;
  else merged.priceUsd = price.priceUsd;

  const times = [net, price].filter((x) => x && !(x instanceof Error)).map((x) => x.at);
  return {
    symbol: coin.symbol,
    name: coin.name,
    algorithm: coin.algorithm,
    displayUnit: coin.displayUnit,
    ...merged,
    sources: {
      network: haveNet ? 'caller_supplied' : net.source + (whatIf.networkHashrate || whatIf.blockReward || whatIf.blockTimeSec ? '+caller_supplied' : ''),
      price: whatIf.priceUsd ? 'caller_supplied' : price.source,
    },
    stale: Boolean((net && !(net instanceof Error) && net.stale) || (price && !(price instanceof Error) && price.stale)),
    asOf: new Date(times.length ? Math.min(...times) : Date.now()).toISOString(),
    notes: coin.notes,
  };
}
