import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installFetchMock, startApp } from './helpers.js';

process.env.OVERRIDES_FILE = '/nonexistent/overrides.json';
installFetchMock();

let app;
before(async () => {
  app = await startApp({
    PAY_TO: '0x1111111111111111111111111111111111111111',
    X402_NETWORK: 'base-sepolia',
    FREE_CALLS_PER_DAY: '1',
  });
});
after(() => app.close());

test('free tier, then x402 402 with payment requirements', async () => {
  const url = app.base + '/v1/profit?coin=KAS&model=ks0&kwh=0.08';
  const first = await fetch(url);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('x-free-calls-remaining'), '0');

  const second = await fetch(url, { headers: { accept: 'application/json' } });
  assert.equal(second.status, 402);
  const header = second.headers.get('payment-required');
  assert.ok(header, 'PAYMENT-REQUIRED header present');
  const req = JSON.parse(Buffer.from(header, 'base64').toString());
  const opt = req.accepts[0];
  assert.equal(opt.network, 'eip155:84532');
  assert.equal(opt.payTo, '0x1111111111111111111111111111111111111111');
  assert.equal(opt.amount, '2000'); // $0.002 in USDC (6 decimals)
});

test('free routes never require payment', async () => {
  for (const p of ['/', '/v1/hardware', '/v1/coins', '/llms.txt', '/health']) {
    const r = await fetch(app.base + p);
    assert.equal(r.status, 200, p);
  }
});
