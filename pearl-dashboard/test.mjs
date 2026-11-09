// Safety checks for the Pearl Rigs server. Run with: npm test (from pearl-dashboard/)
// Starts the real server against made-up pool data and pokes at it the way an attacker would.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('./server.js', import.meta.url));
const WALLET = 'prl1qtestwalletaddressthatmustneverbesentinfull000000';
const TX = 'ab'.repeat(32);
const now = Math.floor(Date.now() / 1000);
const worker = (name, h) => ({ name, hashrate: h, hashrate_1h: h, hashrate_6h: h, hashrate_24h: h, lastShare: now - 30, shares_good: 100, shares_stale: 1, shares_invalid: 0 });
const fixture = join(mkdtempSync(join(tmpdir(), 'pearl-')), 'pool.json');
writeFileSync(fixture, JSON.stringify({
  mine: {
    stats: { hashrate: 150000, hashrate_6h: 150000, hashrate_24h: 150000, balance: 5e7, paid: 1e10, payments_24h: 1e9, payments_7d: 7e9, lastShare: now - 20 },
    payments: [`${TX}:150000000:100000`, now - 3600],
    charts: { hashrate: [[now - 1200, 140000], [now - 600, 150000]] },
    workers: [
      worker('desktop-d40gemj', 47000),
      worker('<img src=x onerror=alert(1)>', 10),
      worker('x'.repeat(500), 5),
      ...Array.from({ length: 300 }, (_, i) => worker(`flood-${i}`, 1)),
    ],
  },
  net: { config: { coinUnits: 1e8, minPaymentThreshold: 1e8, coinDifficultyTarget: 60 }, network: { difficulty: 4.8e9, reward: 1e9 }, pool: { hashrate: 2e7, realHashrate: 2e7 * 2 ** 32, price: { usd: 0.6 } } },
}));

let nextPort = 3900 + Math.floor(Math.random() * 500);
async function boot(env = {}) {
  const port = nextPort++;
  const child = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, PORT: String(port), MOCK_POOL: fixture, PRL_WALLET: WALLET, ...env }, stdio: 'pipe' });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 100 && !log.includes('Pearl Rigs on'); i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 150));   // first pool check
  const req = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    r.on('error', reject);
    r.end(body);
  });
  return { req, stop: () => child.kill(), alive: () => child.exitCode === null, log: () => log };
}

test('open dashboard', async (t) => {
  const s = await boot({ ADMIN_TOKEN: 'debug-token-123' });
  t.after(s.stop);

  await t.test('page carries the security headers and a script fingerprint', async () => {
    const r = await s.req('/');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-security-policy'], /script-src 'sha256-[A-Za-z0-9+/=]+'/);
    assert.doesNotMatch(r.headers['content-security-policy'], /script-src[^;]*unsafe/);
    assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.equal(r.headers['referrer-policy'], 'same-origin');
    assert.match(r.headers['strict-transport-security'], /max-age=\d+/);
    assert.match(r.headers['x-robots-tag'], /noindex/);
    assert.equal(r.headers['cache-control'], 'no-store');
  });

  await t.test('feed leaves out the full wallet and payout transaction ids', async () => {
    const r = await s.req('/api/data');
    assert.equal(r.status, 200);
    assert.ok(!r.text.includes(WALLET), 'full wallet leaked');
    assert.ok(!r.text.includes(TX), 'tx hash leaked');
    const d = JSON.parse(r.text);
    assert.equal(d.config.wallet, 'prl1qtes…000000');
    assert.equal(d.pool.payments[0].amount, 1.5);
  });

  await t.test('junk workers are capped and long names trimmed', async () => {
    const d = JSON.parse((await s.req('/api/data')).text);
    assert.equal(d.pool.workers.length, 60);
    assert.ok(d.pool.workers.some((w) => w.name === 'desktop-d40gemj'), 'the real rig is kept');
    assert.ok(d.pool.workers.every((w) => w.name.length <= 64));
    assert.equal(d.pool.workersHidden, 243);
  });

  await t.test('hashrate is scaled to real hashes per second', async () => {
    const d = JSON.parse((await s.req('/api/data')).text);
    const w = d.pool.workers.find((x) => x.name === 'desktop-d40gemj');
    assert.equal(w.hashrate, 47000 * 2 ** 32);
    assert.ok(Math.abs(d.pool.network.prlPerHashDay - (10 * 86400) / (4.8e9 * 2 ** 32)) < 1e-24);
  });

  await t.test('a malformed address cannot crash the server', async () => {
    const r = await s.req('//');
    assert.equal(r.status, 400);
    assert.equal((await s.req('/health')).status, 200);
    assert.ok(s.alive());
  });

  await t.test('unknown paths, wrong methods and big bodies are refused', async () => {
    assert.equal((await s.req('/server.js')).status, 404);
    assert.equal((await s.req('/../rigs.json')).status, 404);
    assert.equal((await s.req('/api/data', { method: 'DELETE' })).status, 405);
    assert.equal((await s.req('/api/refresh')).status, 405);
    assert.equal((await s.req('/api/refresh', { method: 'POST', headers: { 'Content-Length': 5000 }, body: 'x'.repeat(5000) })).status, 413);
  });

  await t.test('another website cannot trigger actions', async () => {
    assert.equal((await s.req('/api/refresh', { method: 'POST', headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await s.req('/api/refresh', { method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await s.req('/api/refresh', { method: 'POST', headers: { Origin: 'null' } })).status, 403);
    assert.equal((await s.req('/api/refresh', { method: 'POST', headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
  });

  await t.test('Govee debug needs the admin token', async () => {
    assert.equal((await s.req('/api/govee-debug')).status, 404);
    assert.equal((await s.req('/api/govee-debug', { headers: { Authorization: 'Bearer wrong' } })).status, 404);
    assert.equal((await s.req('/api/govee-debug', { headers: { Authorization: 'Bearer debug-token-123' } })).status, 200);
  });

  await t.test('errors never echo internals', async () => {
    const r = await s.req('/%E0%A4%A');
    assert.ok([400, 404].includes(r.status));
    assert.doesNotMatch(r.text, /at |node:|\.js/);
  });

  await t.test('one address hammering the server gets slowed down', async () => {
    let limited = 0;
    for (let i = 0; i < 260; i++) if ((await s.req('/api/data', { headers: { 'CF-Connecting-IP': '203.0.113.9' } })).status === 429) limited++;
    assert.ok(limited > 0 && limited < 40, `limited ${limited}`);
    assert.equal((await s.req('/api/data', { headers: { 'CF-Connecting-IP': '203.0.113.10' } })).status, 200, 'other visitors unaffected');
    assert.equal((await s.req('/health', { headers: { 'CF-Connecting-IP': '203.0.113.9' } })).status, 200, 'health check never limited');
  });
});

test('password-locked dashboard', async (t) => {
  const s = await boot({ DASH_PASSWORD: 'correct horse battery' });
  t.after(s.stop);
  const form = (pw, ip = '198.51.100.1') => s.req('/login', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': ip }, body: `password=${encodeURIComponent(pw)}`,
  });

  await t.test('nothing is readable without signing in', async () => {
    const page = await s.req('/');
    assert.equal(page.status, 303);
    assert.equal(page.headers.location, '/login');
    const feed = await s.req('/api/data');
    assert.equal(feed.status, 401);
    assert.ok(!feed.text.includes('pool'));
    assert.equal((await s.req('/api/refresh', { method: 'POST' })).status, 401);
    assert.equal((await s.req('/api/govee-debug')).status, 401);
    assert.equal((await s.req('/health')).status, 200);
    assert.equal((await s.req('/login')).status, 200);
  });

  await t.test('wrong password is refused, right one gets a locked-down cookie', async () => {
    const bad = await form('nope');
    assert.equal(bad.headers.location, '/login?failed');
    assert.equal(bad.headers['set-cookie'], undefined);
    const ok = await form('correct horse battery');
    assert.equal(ok.headers.location, '/');
    const cookie = ok.headers['set-cookie'][0];
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Lax/);
    const pair = cookie.split(';')[0];
    assert.equal((await s.req('/', { headers: { Cookie: pair } })).status, 200);
    assert.equal((await s.req('/api/data', { headers: { Cookie: pair } })).status, 200);

    const [exp, sig] = pair.slice(5).split('.');
    const forged = `pr_s=${Number(exp) + 1}.${sig}`;                       // changed expiry, old signature
    assert.equal((await s.req('/api/data', { headers: { Cookie: forged } })).status, 401);
    assert.equal((await s.req('/api/data', { headers: { Cookie: `pr_s=${exp}.${'A'.repeat(43)}` } })).status, 401);
    assert.equal((await s.req('/api/data', { headers: { Cookie: `pr_s=1000000000000.${sig}` } })).status, 401);
  });

  await t.test('password guessing is rate limited', async () => {
    const codes = [];
    for (let i = 0; i < 10; i++) codes.push((await form(`guess-${i}`, '198.51.100.77')).status);
    assert.ok(codes.includes(429), codes.join(','));
  });
});
