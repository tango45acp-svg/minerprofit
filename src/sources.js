// Raw upstream data fetchers. Each returns normalized numbers:
//   network: { networkHashrate (H/s), blockReward (coins), blockTimeSec }
//   price:   USD per coin
// Keep these small and dumb; fallback logic lives in market.js.

const UA = 'minerprofit/1.0 (+https://github.com/)';

export async function fetchJson(url, { timeoutMs = 8000, headers = {} } = {}) {
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': UA, ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${new URL(url).host} responded ${res.status}`);
  return res.json();
}

function num(v, label) {
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isFinite(n) || n <= 0) throw new Error(`upstream returned invalid ${label}`);
  return n;
}

// ---------- Prices ----------

/** CoinGecko simple price. Returns { [coingeckoId]: usd }. */
export async function coingeckoPrices(ids) {
  const key = process.env.COINGECKO_API_KEY;
  const base = key && process.env.COINGECKO_PRO === '1'
    ? 'https://pro-api.coingecko.com/api/v3'
    : 'https://api.coingecko.com/api/v3';
  const headers = key
    ? { [process.env.COINGECKO_PRO === '1' ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key']: key }
    : {};
  const url = `${base}/simple/price?ids=${encodeURIComponent(ids.join(','))}&vs_currencies=usd`;
  const data = await fetchJson(url, { headers });
  const out = {};
  for (const id of ids) {
    const usd = data?.[id]?.usd;
    if (Number.isFinite(usd) && usd > 0) out[id] = usd;
  }
  return out;
}

// ---------- WhatToMine (generic multi-coin fallback) ----------

/** Returns { [TAG]: { networkHashrate, blockReward, blockTimeSec, exchangeRateBtc } } */
export async function whattomineCoins() {
  const data = await fetchJson('https://whattomine.com/coins.json', { timeoutMs: 10000 });
  const out = {};
  for (const c of Object.values(data?.coins || {})) {
    if (!c?.tag) continue;
    const tag = String(c.tag).toUpperCase();
    const entry = {
      networkHashrate: Number(c.nethash),
      blockReward: Number(c.block_reward24 ?? c.block_reward),
      blockTimeSec: Number(c.block_time),
      exchangeRateBtc: c.exchange_rate_curr === 'BTC' ? Number(c.exchange_rate24 ?? c.exchange_rate) : NaN,
      lagging: Boolean(c.lagging),
    };
    // Some tags appear more than once (e.g. multiple algos); keep the first sane one.
    if (!out[tag] && entry.networkHashrate > 0 && entry.blockReward > 0 && entry.blockTimeSec > 0) {
      out[tag] = entry;
    }
  }
  return out;
}

// ---------- Native chain sources ----------

/** Kaspa via the public api.kaspa.org REST server. 10 blocks/sec since Crescendo. */
export async function kaspaNetwork() {
  const base = process.env.KASPA_API_URL || 'https://api.kaspa.org';
  const [hr, br] = await Promise.all([
    fetchJson(`${base}/info/hashrate?stringOnly=false`),
    fetchJson(`${base}/info/blockreward?stringOnly=false`),
  ]);
  return {
    networkHashrate: num(hr.hashrate, 'Kaspa hashrate') * 1e12, // API reports TH/s
    blockReward: num(br.blockreward, 'Kaspa block reward'),
    blockTimeSec: Number(process.env.KASPA_BLOCK_TIME_SEC || 0.1),
  };
}

/** Bitcoin via mempool.space. Block reward includes average fees over the last day. */
export async function bitcoinNetwork() {
  const base = process.env.MEMPOOL_API_URL || 'https://mempool.space/api';
  const [hr, rewards] = await Promise.all([
    fetchJson(`${base}/v1/mining/hashrate/3d`),
    fetchJson(`${base}/v1/mining/reward-stats/144`),
  ]);
  const blocks = Math.max(1, Number(rewards.endBlock) - Number(rewards.startBlock) + 1) || 144;
  return {
    networkHashrate: num(hr.currentHashrate, 'Bitcoin hashrate'),
    blockReward: num(rewards.totalReward, 'Bitcoin reward') / blocks / 1e8,
    blockTimeSec: 600,
  };
}
