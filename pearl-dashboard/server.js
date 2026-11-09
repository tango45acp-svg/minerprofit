// Tango's Pearl Rigs: polls HeroMiners and Govee every 5 minutes, keeps 24h of
// history in memory, serves the page and a JSON feed.
// No dependencies; needs Node 20+ (built-in fetch).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { randomUUID, createHash, createHmac, timingSafeEqual } from 'node:crypto';

// HeroMiners reports Pearl hashrate in difficulty-1 shares per second.
// One difficulty-1 share = 2^32 hashes, so real H/s = pool number × 2^32
// (this is exactly the pool's own realHashrate / hashrate ratio).
const SHARE_HASHES = 2 ** 32;

// ---------- small, strict helpers: nothing from outside is trusted as-is ----------
const str = (v, max = 80) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
const fin = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const pos = (v) => { const n = fin(v); return n != null && n >= 0 ? n : null; };
const clamp = (v, lo, hi, dflt) => { const n = fin(v); return n == null ? dflt : Math.min(hi, Math.max(lo, n)); };
const ID = /^[A-Za-z0-9_-]{1,40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;
const list = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);

// Rig defaults (names, worker, watts at the wall, what each rig cost).
function loadRigs() {
  try {
    const raw = process.env.RIGS_JSON || readFileSync(new URL('./rigs.json', import.meta.url), 'utf8');
    const cfg = JSON.parse(raw);
    const rigs = list(cfg.rigs, 24).filter((r) => r && ID.test(r.id)).map((r) => ({
      id: r.id,
      name: str(r.name, 60) || r.id,
      gpus: list(r.gpus, 12).map((g) => str(g, 40)).filter(Boolean),
      worker: str(r.worker, 64),
      watts: pos(r.watts),
      wattsSource: r.wattsSource === 'est' ? 'est' : 'you',
      ...(pos(r.cost) != null ? { cost: pos(r.cost), costSource: r.costSource === 'est' ? 'est' : 'you' } : {}),
    }));
    return { rate: pos(cfg.rate), rigs };
  } catch (e) {
    console.error('rigs.json unreadable:', e.message);
    return { rate: null, rigs: [] };
  }
}
const RIG_CFG = loadRigs();

// Payoff tracker: what each GPU cost, in payoff order, and the cash Pearl has
// turned into (SafeTrade withdrawals + balance). PAYOFF_JSON replaces the file.
function loadPayoff() {
  try {
    const raw = process.env.PAYOFF_JSON || readFileSync(new URL('./payoff.json', import.meta.url), 'utf8');
    const cfg = JSON.parse(raw);
    const bal = cfg.safetradeBalance;
    return {
      cards: list(cfg.cards, 64).filter((c) => c && str(c.card, 40)).map((c) => ({
        id: str(c.id, 40),
        card: str(c.card, 40),
        rig: ID.test(c.rig) ? c.rig : null,
        cost: pos(c.cost),
        status: c.status === 'ordered' ? 'ordered' : 'mining',
        ...(c.paid === true ? { paid: true } : {}),
        ...(c.note ? { note: str(c.note, 80) } : {}),
      })),
      cashouts: list(cfg.cashouts, 500).filter((c) => c && DATE.test(c.date) && pos(c.usdt) != null).map((c) => ({
        date: c.date, network: str(c.network, 24), usdt: pos(c.usdt), fee: pos(c.fee) ?? 0,
      })),
      safetradeBalance: bal && DATE.test(bal.asOf) && pos(bal.usdt) != null ? { asOf: bal.asOf, usdt: pos(bal.usdt) } : null,
      electricBills: list(cfg.electricBills, 240).filter((b) => b && MONTH.test(b.month) && pos(b.amount) != null).map((b) => ({
        month: b.month, amount: pos(b.amount), ...(pos(b.mining) != null ? { mining: pos(b.mining) } : {}),
      })),
    };
  } catch (e) {
    console.error('payoff.json unreadable:', e.message);
    return { cards: [], cashouts: [], safetradeBalance: null, electricBills: [] };
  }
}
const PAYOFF = loadPayoff();
// A rig's cost is what its cards still owe, unless rigs.json sets one.
const RIGS = RIG_CFG.rigs.map((r) => {
  const owed = PAYOFF.cards.filter((c) => c.rig === r.id && !c.paid && c.cost > 0);
  if (r.cost != null || !owed.length) return r;
  return { ...r, cost: owed.reduce((a, c) => a + c.cost, 0), costSource: 'you' };
});
const RIG_WORKERS = new Set(RIGS.map((r) => r.worker).filter(Boolean));

const PORT = clamp(process.env.PORT, 1, 65535, 3000);
const WALLET = str(process.env.PRL_WALLET, 200);
const GOVEE_KEY = str(process.env.GOVEE_API_KEY, 200);
const RATE = pos(process.env.POWER_RATE) ?? RIG_CFG.rate ?? 0.09;                 // $ per kWh
const EST_WATTS = clamp(process.env.EST_TOTAL_WATTS, 0, 100_000, 1500);          // used when no plug reports watts
const POLL_MS = clamp(process.env.POLL_MINUTES, 1, 60, 5) * 60_000;              // never faster than once a minute
const PASSWORD = String(process.env.DASH_PASSWORD || '').trim();                 // optional: lock the whole dashboard
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || '').trim();                // optional: unlocks /api/govee-debug
const DEV = process.env.NODE_ENV === 'development';
const POOL = 'https://pearl.herominers.com/api';
const GOVEE = 'https://openapi.api.govee.com/router/api/v1';
const HISTORY_MAX = Math.ceil((24 * 60 * 60_000) / POLL_MS);                     // 24h of samples
const MAX_UPSTREAM_BYTES = 8 * 1024 * 1024;
const MAX_WORKERS = 60;

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
const shortWallet = (a) => (a.length > 20 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a);

// Fetch JSON with a timeout and a size cap, so a broken or hostile upstream can't hang or balloon the server.
async function getJSON(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(20_000) });
  if (Number(res.headers.get('content-length')) > MAX_UPSTREAM_BYTES) throw new Error('response too large');
  const chunks = []; let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.length;
    if (size > MAX_UPSTREAM_BYTES) throw new Error('response too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { detail: text.slice(0, 200) });
  return JSON.parse(text);
}

// What the page is allowed to see about a failure: never the upstream's own text.
function publicError(err) {
  const m = String(err?.message || '');
  if (/^HTTP \d{3}$/.test(m)) return m;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'timed out';
  if (err instanceof SyntaxError) return 'unexpected response';
  if (m === 'response too large') return m;
  return 'no response';
}

function noteError(where, err) {
  console.error(new Date().toISOString(), `${where}: ${err?.message || err}`, err?.detail || '');
  state.errors.unshift({ t: Date.now(), msg: `${where}: ${publicError(err)}` });
  state.errors = state.errors.slice(0, 10);
}

// ---------- HeroMiners ----------
async function pollPool() {
  // MOCK_POOL=path/to/fixture.json ({mine, net}) lets the page be previewed offline.
  const [mine, net] = process.env.MOCK_POOL
    ? (({ mine, net }) => [mine, net])(JSON.parse(await readFile(process.env.MOCK_POOL, 'utf8')))
    : await Promise.all([
      getJSON(`${POOL}/stats_address?address=${encodeURIComponent(WALLET)}&recentBlocksAmount=0&longpoll=false`),
      getJSON(`${POOL}/stats`),
    ]);
  if (!mine || typeof mine !== 'object' || !net || typeof net !== 'object') throw new SyntaxError('pool sent no data');
  const units = pos(net?.config?.coinUnits) || 1e8;
  const s = mine.stats || {};
  const coin = (v) => (fin(v) == null ? null : fin(v) / units);
  // Scale pool numbers to real hashes/s. Prefer the pool's own ratio, fall back to 2^32.
  const ratio = Number(net?.pool?.realHashrate) / Number(net?.pool?.hashrate);
  const scale = ratio > 1e8 && ratio < 1e11 ? ratio : SHARE_HASHES;
  const hs = (v) => (pos(v) || 0) * scale;
  const ms = (v) => (pos(v) ? pos(v) * 1000 : null);
  // Expected earnings: each pool-unit of hashrate finds reward·86400/difficulty PRL a day.
  const difficulty = pos(net?.network?.difficulty) || null;
  const reward = coin(net?.network?.reward ?? net?.lastblock?.reward);
  const blockTime = pos(net?.network?.difficultyTarget || net?.config?.coinDifficultyTarget) || null;
  const network = {
    difficulty,
    reward,
    blockTime,
    hashrate: difficulty && blockTime ? (difficulty * SHARE_HASHES) / blockTime : null,
    prlPerHashDay: difficulty && reward ? (reward * 86400) / (difficulty * scale) : null, // PRL/day per real H/s
  };
  const payments = [];
  const p = list(mine.payments, 40);
  for (let i = 0; i + 1 < p.length; i += 2) {
    const [, amount, fee] = String(p[i]).split(':');   // the tx hash stays on the server
    if (ms(p[i + 1])) payments.push({ amount: coin(amount), fee: coin(fee), t: ms(p[i + 1]) });
  }
  // Anyone can point a miner at a wallet under any worker name, so names are
  // cleaned and capped, and only the busiest workers are kept.
  const seen = new Set();
  const workers = list(mine.workers, 5000).map((w) => ({
    name: str(w?.name, 64),
    hashrate: hs(w?.hashrate),
    hashrate1h: hs(w?.hashrate_1h),
    hashrate6h: hs(w?.hashrate_6h),
    hashrate24h: hs(w?.hashrate_24h),
    lastShare: ms(w?.lastShare),
    sharesGood: pos(w?.shares_good) || 0,
    sharesStale: pos(w?.shares_stale) || 0,
    sharesInvalid: pos(w?.shares_invalid) || 0,
  })).filter((w) => w.name && !seen.has(w.name) && seen.add(w.name));
  const rank = (w) => (RIG_WORKERS.has(w.name) ? Infinity : w.hashrate6h || w.hashrate);
  const kept = workers.length > MAX_WORKERS
    ? new Set([...workers].sort((a, b) => rank(b) - rank(a)).slice(0, MAX_WORKERS).map((w) => w.name))
    : null;
  return {
    fetchedAt: Date.now(),
    price: pos(net?.pool?.price?.usd) || null,
    networkHeight: pos(s.networkHeight || net?.network?.height) || null,
    networkDifficulty: difficulty,
    network,
    hashScale: scale,
    poolHashrate: hs(net?.pool?.hashrate) || null,
    fee: fin(net?.config?.fee),
    minPayout: coin(net?.config?.minPaymentThreshold),
    hashrate: hs(s.hashrate),
    hashrate1h: hs(s.hashrate_1h),
    hashrate6h: hs(s.hashrate_6h),
    hashrate24h: hs(s.hashrate_24h),
    sharesGood: pos(s.shares_good) || 0,
    sharesStale: pos(s.shares_stale) || 0,
    sharesInvalid: pos(s.shares_invalid) || 0,
    lastShare: ms(s.lastShare),
    balance: coin(s.balance) ?? 0,
    paid: coin(s.paid) ?? 0,
    paid24h: coin(s.payments_24h) ?? 0,
    paid7d: coin(s.payments_7d) ?? 0,
    payments: payments.slice(0, 10),
    hashrateChart: list(mine.charts?.hashrate, 5000)
      .map((pt) => [ms(pt?.[0]), hs(pt?.[1])]).filter((pt) => pt[0]).slice(-600),
    workers: kept ? workers.filter((w) => kept.has(w.name)) : workers,
    workersHidden: kept ? workers.length - kept.size : 0,
  };
}

// ---------- Govee ----------
const goveeHeaders = () => ({ 'Govee-API-Key': GOVEE_KEY, 'Content-Type': 'application/json' });
// The key must only ever go to Govee itself, so redirects are refused.
const goveeOpts = (extra = {}) => ({ headers: goveeHeaders(), redirect: 'error', ...extra });
// Plugs are shown to the page under a short fingerprint, never their real device address.
const plugId = (device) => createHash('sha256').update(String(device)).digest('hex').slice(0, 10);

async function refreshGoveeDevices() {
  const r = await getJSON(`${GOVEE}/user/devices`, goveeOpts());
  const all = list(r?.data, 200).filter((d) => d && d.device && d.sku);
  // Keep anything that looks like a plug/outlet; fall back to every device if none match.
  const plugs = all.filter((d) => /socket|plug|outlet/i.test(`${d.type} ${d.deviceName} ${d.sku}`));
  goveeDevices = (plugs.length ? plugs : all).slice(0, 40).map((d) => ({
    sku: str(d.sku, 40), device: String(d.device), name: str(d.deviceName, 60) || str(d.sku, 40), type: str(d.type, 60),
    capabilities: list(d.capabilities, 40).map((c) => str(`${c?.type}:${c?.instance}`, 80)),
  }));
  state.govee.devicesFetchedAt = Date.now();
}

// Pull a watt figure out of whatever shape Govee returns for a plug.
function findWatts(caps) {
  let watts = null; const extra = {};
  const consider = (key, val, depth = 0) => {
    if (val == null || depth > 4) return;
    if (typeof val === 'object') { for (const [k, v] of Object.entries(val).slice(0, 40)) consider(`${key}.${k}`, v, depth + 1); return; }
    const n = Number(val);
    if (!Number.isFinite(n)) return;
    const k = key.toLowerCase();
    if (/volt/.test(k)) extra.volts = n;
    else if (/current|amp/.test(k)) extra.amps = n;
    else if (/energy|kwh|consum/.test(k)) extra.kwh = n;
    else if (/watt|power(?!switch)|electric/.test(k) && watts == null) watts = n;
  };
  for (const c of caps || []) {
    if (/powerSwitch|online/i.test(c?.instance)) continue;
    consider(String(c?.instance || c?.type), c?.state?.value);
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
    const id = plugId(d.device);
    try {
      const r = await getJSON(`${GOVEE}/device/state`, goveeOpts({
        method: 'POST',
        body: JSON.stringify({ requestId: randomUUID(), payload: { sku: d.sku, device: d.device } }),
      }));
      const caps = list(r?.payload?.capabilities, 40);
      const get = (inst) => caps.find((c) => c?.instance === inst)?.state?.value;
      const m = findWatts(caps);
      out.push({
        id, name: d.name, sku: d.sku,
        online: get('online') !== false,
        on: get('powerSwitch') == null ? null : Number(get('powerSwitch')) === 1,
        ...m,
      });
      raw.push({ id, name: d.name, sku: d.sku, listed: d.capabilities, state: caps.map((c) => ({ instance: str(c?.instance, 60), value: c?.state?.value })) });
    } catch (e) {
      console.error(new Date().toISOString(), `Govee plug ${d.name}: ${e.message}`, e.detail || '');
      out.push({ id, name: d.name, sku: d.sku, error: publicError(e) });
    }
    await sleep(300);
  }
  state.govee.raw = raw;
  return out;
}

// ---------- loop ----------
let lastPollStart = 0;
let polling = null;   // one check at a time, however many people press the button

async function doPoll() {
  const t = Date.now();
  lastPollStart = t;
  try { state.pool = await pollPool(); } catch (e) { noteError('HeroMiners', e); }
  if (GOVEE_KEY) {
    try { state.govee.plugs = await pollGovee(); state.govee.error = null; }
    catch (e) { state.govee.error = publicError(e); noteError('Govee', e); }
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
  cache.at = 0;
}
function poll() {
  polling ||= doPoll().catch((e) => noteError('Check', e)).finally(() => { polling = null; });
  return polling;
}

const cache = { at: 0, body: '' };   // the feed is built at most once a second
function payload() {
  if (Date.now() - cache.at < 1000) return cache.body;
  cache.at = Date.now();
  cache.body = JSON.stringify({
    now: Date.now(),
    config: { rate: RATE, estWatts: EST_WATTS, pollMs: POLL_MS, wallet: shortWallet(WALLET), goveeEnabled: !!GOVEE_KEY, locked: !!PASSWORD },
    rigs: RIGS,
    payoff: PAYOFF,
    startedAt: state.startedAt,
    lastPoll: state.lastPoll,
    nextPoll: state.nextPoll,
    pool: state.pool,
    govee: { enabled: !!GOVEE_KEY, error: state.govee.error, plugs: state.govee.plugs },
    history: state.history,
    errors: state.errors,
  });
  return cache.body;
}

// ---------- sign-in (only when DASH_PASSWORD is set) ----------
const sha = (v) => createHash('sha256').update(String(v)).digest();
const sameSecret = (a, b) => timingSafeEqual(sha(a), sha(b));   // constant-time, any lengths
const SESSION_KEY = PASSWORD ? sha(`pearl-rigs-session:${PASSWORD}`) : null;   // changing the password signs everyone out
const SESSION_DAYS = 30;
const signSession = (exp) => createHmac('sha256', SESSION_KEY).update(String(exp)).digest('base64url');
function signedIn(req) {
  if (!PASSWORD) return true;
  const m = /(?:^|;\s*)pr_s=(\d{10,16})\.([A-Za-z0-9_-]{43})(?:;|$)/.exec(String(req.headers.cookie || ''));
  return !!m && Number(m[1]) > Date.now() && sameSecret(m[2], signSession(m[1]));
}
const sessionCookie = (value, maxAge) => `pr_s=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
function isAdmin(req) {
  const m = /^Bearer\s+(\S{1,200})$/.exec(String(req.headers.authorization || ''));
  return !!ADMIN_TOKEN && !!m && sameSecret(m[1], ADMIN_TOKEN);
}

// ---------- rate limits ----------
const hits = new Map();   // key -> { n, reset }
function limited(key, max, windowMs = 60_000) {
  const now = Date.now();
  let h = hits.get(key);
  if (!h || h.reset <= now) {
    if (hits.size > 20_000) hits.clear();
    h = { n: 0, reset: now + windowMs };
    hits.set(key, h);
  }
  return ++h.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (h.reset <= now) hits.delete(k); }, 60_000).unref();
// Render sits behind Cloudflare, which sets CF-Connecting-IP itself; the others are fallbacks.
const clientIp = (req) => str(req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress, 64) || 'unknown';

// ---------- pages ----------
const BASE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Strict-Transport-Security': 'max-age=31536000',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
};
const LOCKED_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

// The page's own script is allowed by its exact fingerprint; nothing injected can run.
function loadPage() {
  const html = readFileSync(new URL('./public/index.html', import.meta.url));
  const hashes = [...html.toString('utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
  const csp = [
    "default-src 'none'",
    `script-src ${hashes.join(' ') || "'none'"}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  return { html, csp };
}
let page = loadPage();

const LOGIN_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const loginPage = (failed) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Tango’s Pearl Rigs</title>
<style>
html{background:#1c2227;color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;color:#e9edf0;font:400 16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
form{width:min(340px,100%);display:grid;gap:14px;padding:22px;background:#232a30;border:1px solid #3a454f;border-radius:6px}
h1{margin:0;font-size:1.3rem}label{display:grid;gap:6px;font-size:.86rem;color:#9ba6b0}
input{font:16px system-ui,sans-serif;color:#e9edf0;background:#1c2227;border:1px solid #3a454f;border-radius:4px;padding:10px 12px}
input:focus{outline:2px solid #4f8dff;outline-offset:1px}
button{font:600 1rem system-ui,sans-serif;color:#fff;background:#4f8dff;border:0;border-radius:4px;padding:10px 14px;cursor:pointer}
p{margin:0;font-size:.88rem;color:#ff6b6b}
</style></head><body>
<form method="post" action="/login">
<h1>Tango’s Pearl Rigs</h1>
<input type="text" name="username" autocomplete="username" value="tango" hidden>
<label for="pw">Password<input id="pw" name="password" type="password" autocomplete="current-password" required autofocus maxlength="200"></label>
${failed ? '<p role="alert">That password didn’t match. Try again.</p>' : ''}
<button type="submit">Sign in</button>
</form></body></html>`;

// ---------- http ----------
function send(req, res, code, body = '', type = 'text/plain; charset=utf-8', extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(code, {
    ...BASE_HEADERS, 'Content-Security-Policy': LOCKED_CSP, 'Content-Type': type, 'Content-Length': buf.length, ...extra,
  });
  res.end(req.method === 'HEAD' ? undefined : buf);
}
const sendJSON = (req, res, code, json) => send(req, res, code, json, 'application/json; charset=utf-8');
const redirect = (req, res, to, extra = {}) => send(req, res, 303, '', 'text/plain; charset=utf-8', { Location: to, ...extra });

function readBody(req, max = 2048) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// A form or script on another website must not be able to act on this one.
function sameOrigin(req) {
  const site = req.headers['sec-fetch-site'];   // set by the browser itself; a page can't fake it
  if (site) return site === 'same-origin' || site === 'none';
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

async function handle(req, res) {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return send(req, res, 400, 'Bad request'); }
  const path = url.pathname;
  const read = req.method === 'GET' || req.method === 'HEAD';
  const post = req.method === 'POST';
  if (!read && !post) return send(req, res, 405, 'Method not allowed', undefined, { Allow: 'GET, HEAD, POST' });
  if (Number(req.headers['content-length']) > 2048) return send(req, res, 413, 'Body too large', undefined, { Connection: 'close' });

  if (path === '/health' && read) return send(req, res, 200, 'ok');
  if (path === '/robots.txt' && read) return send(req, res, 200, 'User-agent: *\nDisallow: /\n');

  const ip = clientIp(req);
  if (limited(`all:${ip}`, 240) || limited('all', 3000)) return send(req, res, 429, 'Too many requests, slow down', undefined, { 'Retry-After': '30' });
  if (post && !sameOrigin(req)) return send(req, res, 403, 'Forbidden');

  if (path === '/login') {
    if (!PASSWORD || signedIn(req)) return redirect(req, res, '/');
    if (read) return send(req, res, 200, loginPage(url.searchParams.has('failed')), 'text/html; charset=utf-8', { 'Content-Security-Policy': LOGIN_CSP });
    if (limited(`login:${ip}`, 8) || limited('login', 60)) return send(req, res, 429, 'Too many tries. Wait a minute and try again.', undefined, { 'Retry-After': '60' });
    const given = new URLSearchParams(await readBody(req)).get('password') || '';
    await sleep(350);   // slows guessing
    if (!sameSecret(given, PASSWORD)) return redirect(req, res, '/login?failed');
    const exp = Date.now() + SESSION_DAYS * 864e5;
    return redirect(req, res, '/', { 'Set-Cookie': sessionCookie(`${exp}.${signSession(exp)}`, SESSION_DAYS * 86400) });
  }
  if (path === '/logout' && post) return redirect(req, res, PASSWORD ? '/login' : '/', { 'Set-Cookie': sessionCookie('', 0) });

  if (!signedIn(req)) {
    return path.startsWith('/api/') ? sendJSON(req, res, 401, '{"error":"Sign in first"}') : redirect(req, res, '/login');
  }

  if ((path === '/' || path === '/index.html') && read) {
    if (DEV) page = loadPage();
    return send(req, res, 200, page.html, 'text/html; charset=utf-8', { 'Content-Security-Policy': page.csp });
  }
  if (path === '/api/data' && read) return sendJSON(req, res, 200, payload());
  if (path === '/api/refresh') {
    if (!post) return send(req, res, 405, 'Method not allowed', undefined, { Allow: 'POST' });
    req.resume();
    if (limited(`refresh:${ip}`, 10)) return send(req, res, 429, 'Too many requests, slow down', undefined, { 'Retry-After': '30' });
    // Manual check, at most once a minute so the pool's and Govee's rate limits stay safe.
    if (polling) await polling;
    else if (Date.now() - lastPollStart > 60_000) await poll();
    return sendJSON(req, res, 200, payload());
  }
  // Raw Govee replies: only with the admin token, or when signed in on a locked dashboard.
  if (path === '/api/govee-debug' && read && (isAdmin(req) || PASSWORD)) {
    return sendJSON(req, res, 200, JSON.stringify({
      devices: goveeDevices.map(({ device, ...d }) => ({ ...d, id: plugId(device) })), lastStates: state.govee.raw, error: state.govee.error,
    }, null, 2));
  }
  return send(req, res, 404, 'Not found');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (!e?.status) console.error(new Date().toISOString(), 'request failed:', e);
    if (res.headersSent) return res.destroy();
    send(req, res, e?.status || 500, e?.status ? e.message : 'Server error');   // no internals in the reply
  });
});
server.headersTimeout = 15_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 65_000;
server.maxHeadersCount = 100;
server.on('clientError', (err, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });

process.on('unhandledRejection', (e) => console.error(new Date().toISOString(), 'unhandled:', e));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); });

if (!WALLET && !process.env.MOCK_POOL) console.warn('PRL_WALLET is not set; pool stats will fail.');
server.listen(PORT, () => {
  console.log(`Pearl Rigs on :${PORT}, polling every ${POLL_MS / 60000} min${PASSWORD ? ', password on' : ''}`);
  poll();
  setInterval(poll, POLL_MS);
});
