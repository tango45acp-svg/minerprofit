// Pearl Rigs dashboard: polls HeroMiners and Govee every 5 minutes,
// keeps 24h of history in memory, serves the page and a JSON feed.
// No dependencies; needs Node 20+ (built-in fetch).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT || 3000);
const WALLET = (process.env.PRL_WALLET || '').trim();
const GOVEE_KEY = (process.env.GOVEE_API_KEY || '').trim();
const RATE = Number(process.env.POWER_RATE || 0.09);           // $ per kWh
const EST_WATTS = Number(process.env.EST_TOTAL_WATTS || 1500); // used when no plug reports watts
const POLL_MS = Number(process.env.POLL_MINUTES || 5) * 60_000;
const POOL = 'https://pearl.herominers.com/api';
const GOVEE = 'https://openapi.api.govee.com/router/api/v1';
const HISTORY_MAX = Math.ceil((24 * 60 * 60_000) / POLL_MS);   // 24h of samples

const state = {
  startedAt: Date.now(),
  lastPoll: null,
  nextPoll: null,
  pool: null,
  govee: { enabled: !!GOVEE_KEY, plugs: [], error: null, devicesFetchedAt: 0, raw: [] },
  history: [],          // [{t, hashrate, watts, workers:{name:hashrate}, plugs:{id:watts}}]
  errors: [],
};
let goveeDevices = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

function noteError(where, err) {
  const msg = `${where}: ${err.message || err}`;
  console.error(new Date().toISOString(), msg);
  state.errors.unshift({ t: Date.now(), msg });
  state.errors = state.errors.slice(0, 10);
}

// ---------- HeroMiners ----------
async function pollPool() {
  const [mine, net] = await Promise.all([
    getJSON(`${POOL}/stats_address?address=${encodeURIComponent(WALLET)}&recentBlocksAmount=0&longpoll=false`),
    getJSON(`${POOL}/stats`),
  ]);
  const units = Number(net?.config?.coinUnits) || 1e8;
  const s = mine.stats || {};
  const coin = (v) => (v == null ? null : Number(v) / units);
  const payments = [];
  const p = mine.payments || [];
  for (let i = 0; i + 1 < p.length; i += 2) {
    const [hash, amount, fee] = String(p[i]).split(':');
    payments.push({ hash, amount: coin(amount), fee: coin(fee), t: Number(p[i + 1]) * 1000 });
  }
  return {
    fetchedAt: Date.now(),
    price: Number(net?.pool?.price?.usd) || null,
    networkHeight: Number(s.networkHeight || net?.network?.height) || null,
    networkDifficulty: Number(net?.network?.difficulty) || null,
    poolHashrate: Number(net?.pool?.hashrate) || null,
    fee: net?.config?.fee ?? null,
    minPayout: coin(net?.config?.minPaymentThreshold),
    hashrate: Number(s.hashrate) || 0,
    hashrate1h: Number(s.hashrate_1h) || 0,
    hashrate6h: Number(s.hashrate_6h) || 0,
    hashrate24h: Number(s.hashrate_24h) || 0,
    sharesGood: Number(s.shares_good) || 0,
    sharesStale: Number(s.shares_stale) || 0,
    sharesInvalid: Number(s.shares_invalid) || 0,
    lastShare: Number(s.lastShare) * 1000 || null,
    balance: coin(s.balance) ?? 0,
    paid: coin(s.paid) ?? 0,
    paid24h: coin(s.payments_24h) ?? 0,
    paid7d: coin(s.payments_7d) ?? 0,
    payments: payments.slice(0, 10),
    hashrateChart: (mine.charts?.hashrate || []).map(([t, h]) => [t * 1000, Number(h)]),
    workers: (mine.workers || []).map((w) => ({
      name: w.name,
      hashrate: Number(w.hashrate) || 0,
      hashrate1h: Number(w.hashrate_1h) || 0,
      hashrate6h: Number(w.hashrate_6h) || 0,
      hashrate24h: Number(w.hashrate_24h) || 0,
      lastShare: Number(w.lastShare) * 1000 || null,
      sharesGood: Number(w.shares_good) || 0,
      sharesStale: Number(w.shares_stale) || 0,
      sharesInvalid: Number(w.shares_invalid) || 0,
      region: w.region || null,
      agent: w.agent || null,
    })),
  };
}

// ---------- Govee ----------
const goveeHeaders = () => ({ 'Govee-API-Key': GOVEE_KEY, 'Content-Type': 'application/json' });

async function refreshGoveeDevices() {
  const r = await getJSON(`${GOVEE}/user/devices`, { headers: goveeHeaders() });
  const all = Array.isArray(r.data) ? r.data : [];
  // Keep anything that looks like a plug/outlet; fall back to every device if none match.
  const plugs = all.filter((d) => /socket|plug|outlet/i.test(`${d.type} ${d.deviceName} ${d.sku}`));
  goveeDevices = (plugs.length ? plugs : all).map((d) => ({
    sku: d.sku, device: d.device, name: d.deviceName || d.sku, type: d.type,
    capabilities: (d.capabilities || []).map((c) => `${c.type}:${c.instance}`),
  }));
  state.govee.devicesFetchedAt = Date.now();
}

// Pull a watt figure out of whatever shape Govee returns for a plug.
function findWatts(caps) {
  let watts = null, extra = {};
  const consider = (key, val) => {
    if (val == null) return;
    if (typeof val === 'object') { for (const [k, v] of Object.entries(val)) consider(`${key}.${k}`, v); return; }
    const n = Number(val);
    if (!Number.isFinite(n)) return;
    const k = key.toLowerCase();
    if (/volt/.test(k)) extra.volts = n;
    else if (/current|amp/.test(k)) extra.amps = n;
    else if (/energy|kwh|consum/.test(k)) extra.kwh = n;
    else if (/watt|power(?!switch)|electric/.test(k) && watts == null) watts = n;
  };
  for (const c of caps || []) {
    if (/powerSwitch|online/i.test(c.instance)) continue;
    consider(c.instance || c.type, c.state?.value);
  }
  return { watts, ...extra };
}

async function pollGovee() {
  if (!GOVEE_KEY) return [];
  if (!goveeDevices.length || Date.now() - state.govee.devicesFetchedAt > 60 * 60_000) {
    await refreshGoveeDevices();
  }
  const out = [], raw = [];
  for (const d of goveeDevices) {
    try {
      const r = await getJSON(`${GOVEE}/device/state`, {
        method: 'POST', headers: goveeHeaders(),
        body: JSON.stringify({ requestId: randomUUID(), payload: { sku: d.sku, device: d.device } }),
      });
      const caps = r?.payload?.capabilities || [];
      const get = (inst) => caps.find((c) => c.instance === inst)?.state?.value;
      const m = findWatts(caps);
      out.push({
        id: d.device, name: d.name, sku: d.sku,
        online: get('online') !== false,
        on: get('powerSwitch') == null ? null : Number(get('powerSwitch')) === 1,
        ...m,
      });
      raw.push({ name: d.name, sku: d.sku, listed: d.capabilities, state: caps.map((c) => ({ instance: c.instance, value: c.state?.value })) });
    } catch (e) {
      out.push({ id: d.device, name: d.name, sku: d.sku, error: e.message });
    }
    await sleep(300);
  }
  state.govee.raw = raw;
  return out;
}

// ---------- loop ----------
async function poll() {
  const t = Date.now();
  try { state.pool = await pollPool(); } catch (e) { noteError('HeroMiners', e); }
  if (GOVEE_KEY) {
    try { state.govee.plugs = await pollGovee(); state.govee.error = null; }
    catch (e) { state.govee.error = e.message; noteError('Govee', e); }
  }
  const plugWatts = state.govee.plugs.filter((p) => Number.isFinite(p.watts));
  state.history.push({
    t,
    hashrate: state.pool?.hashrate ?? null,
    watts: plugWatts.length ? plugWatts.reduce((a, p) => a + p.watts, 0) : null,
    workers: Object.fromEntries((state.pool?.workers || []).map((w) => [w.name, w.hashrate])),
    plugs: Object.fromEntries(plugWatts.map((p) => [p.id, p.watts])),
  });
  if (state.history.length > HISTORY_MAX) state.history.splice(0, state.history.length - HISTORY_MAX);
  state.lastPoll = t;
  state.nextPoll = t + POLL_MS;
}

function payload() {
  return {
    now: Date.now(),
    config: { rate: RATE, estWatts: EST_WATTS, pollMs: POLL_MS, wallet: WALLET, goveeEnabled: !!GOVEE_KEY },
    startedAt: state.startedAt,
    lastPoll: state.lastPoll,
    nextPoll: state.nextPoll,
    pool: state.pool,
    govee: { enabled: !!GOVEE_KEY, error: state.govee.error, plugs: state.govee.plugs },
    history: state.history,
    errors: state.errors,
  };
}

// ---------- http ----------
let page = null;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, body, type) => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  };
  try {
    if (url.pathname === '/api/data') return send(200, JSON.stringify(payload()), 'application/json');
    if (url.pathname === '/api/govee-debug') {
      return send(200, JSON.stringify({ devices: goveeDevices.map(({ device, ...d }) => ({ ...d, id: device })), lastStates: state.govee.raw, error: state.govee.error }, null, 2), 'application/json');
    }
    if (url.pathname === '/api/refresh' && req.method === 'POST') {
      // Manual refresh, at most once a minute so Govee's rate limit stays safe.
      if (!state.lastPoll || Date.now() - state.lastPoll > 60_000) await poll();
      return send(200, JSON.stringify(payload()), 'application/json');
    }
    if (url.pathname === '/health') return send(200, 'ok', 'text/plain');
    if (url.pathname === '/' || url.pathname === '/index.html') {
      if (!page || process.env.NODE_ENV === 'development') page = await readFile(new URL('./public/index.html', import.meta.url));
      return send(200, page, 'text/html; charset=utf-8');
    }
    send(404, 'Not found', 'text/plain');
  } catch (e) {
    send(500, String(e.message || e), 'text/plain');
  }
});

if (!WALLET) console.warn('PRL_WALLET is not set; pool stats will fail.');
server.listen(PORT, () => {
  console.log(`Pearl Rigs on :${PORT}, polling every ${POLL_MS / 60000} min`);
  poll();
  setInterval(poll, POLL_MS);
});
