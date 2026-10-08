// Deterministic upstream data so tests never hit the network.
export const MOCK = {
  kaspaHashrateTH: 400_000, // 400 PH/s
  kaspaReward: 2.6,
  btcHashrate: 1e21, // 1 ZH/s
  btcRewardSats: 3.2e8,
  prices: { bitcoin: 100000, kaspa: 0.08, 'pearl-2': 0.5, ravencoin: 0.02, ergo: 1.0 },
  wtm: {
    KAS: { tag: 'KAS', nethash: 380e15, block_time: '0.1', block_reward: 2.5, exchange_rate: 8e-7, exchange_rate_curr: 'BTC' },
    PRL: { tag: 'PRL', nethash: 50e18, block_time: '60', block_reward: 2640, exchange_rate: 5e-6, exchange_rate_curr: 'BTC' },
    RVN: { tag: 'RVN', nethash: 5e12, block_time: '60', block_reward: 1250, exchange_rate: 2e-7, exchange_rate_curr: 'BTC' },
    ERG: { tag: 'ERG', nethash: 20e12, block_time: '120', block_reward: 6, exchange_rate: 1e-5, exchange_rate_curr: 'BTC' },
  },
};

export const down = new Set(); // hosts to simulate as failing
export const calls = new Map(); // host -> request count
export const PAPRIKA = { 'btc-bitcoin': 101000, 'kas-kaspa': 0.081, 'rvn-ravencoin': 0.021, 'erg-ergo': 1.01 };

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

const realFetch = globalThis.fetch;

export function installFetchMock() {
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    // Let local test-server requests through.
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);
    calls.set(url.hostname, (calls.get(url.hostname) || 0) + 1);
    if (down.has(url.hostname)) return json({ error: 'down' }, url.hostname === 'api.coingecko.com' ? 429 : 503);

    if (url.hostname === 'api.kaspa.org') {
      if (url.pathname === '/info/hashrate') return json({ hashrate: MOCK.kaspaHashrateTH });
      if (url.pathname === '/info/blockreward') return json({ blockreward: MOCK.kaspaReward });
    }
    if (url.hostname === 'api.coinpaprika.com') {
      const id = decodeURIComponent(url.pathname.split('/').pop());
      return PAPRIKA[id] ? json({ id, quotes: { USD: { price: PAPRIKA[id] } } }) : json({ error: 'id not found' }, 404);
    }
    if (url.hostname === 'mempool.space') {
      if (url.pathname.endsWith('/v1/prices')) return json({ USD: 99000 });
      if (url.pathname.endsWith('/mining/hashrate/3d')) return json({ currentHashrate: MOCK.btcHashrate });
      if (url.pathname.includes('/mining/reward-stats/')) return json({ startBlock: 1, endBlock: 144, totalReward: String(MOCK.btcRewardSats * 144) });
    }
    if (url.hostname === 'api.coingecko.com') {
      const ids = url.searchParams.get('ids').split(',');
      return json(Object.fromEntries(ids.filter((i) => MOCK.prices[i]).map((i) => [i, { usd: MOCK.prices[i] }])));
    }
    if (url.hostname === 'whattomine.com') {
      return json({ coins: Object.fromEntries(Object.entries(MOCK.wtm).map(([k, v]) => [k, v])) });
    }
    if (url.hostname === 'x402.org') {
      if (url.pathname.endsWith('/supported')) {
        return json({ kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:84532' }], extensions: [], signers: {} });
      }
    }
    return json({ error: `unmocked ${url.href}` }, 404);
  };
}

export async function startApp(env = {}) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const { createApp } = await import('../src/server.js');
  const app = await createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    close: () => {
      server.close();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}
