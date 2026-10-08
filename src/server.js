import express from 'express';
import { pathToFileURL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { profit, compare, market, ApiError } from './service.js';
import { listCoins, COINS } from './coins.js';
import { searchHardware } from './hardware.js';
import { buildPaymentLayer, PRICES } from './payments.js';
import { openapi, llmsTxt } from './docs.js';
import { buildMcpServer } from './mcp.js';
import { setOverride, getOverrides } from './market.js';

export async function createApp() {
  const app = express();
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1));
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  // CORS: agents and browser tools call this from anywhere.
  app.use((req, res, next) => {
    res.set('access-control-allow-origin', '*');
    res.set('access-control-allow-headers', '*');
    res.set('access-control-expose-headers', 'payment-required, payment-response, x-payment-response, x-free-calls-remaining');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  const baseUrl = (req) => process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;

  // ---------- Free routes ----------
  app.get('/health', (req, res) => res.json({ ok: true }));

  app.get('/', (req, res) => {
    const b = baseUrl(req);
    res.json({
      name: 'MinerProfit',
      description: 'Live crypto mining profitability API for AI agents. Pay per call with x402 (USDC on Base).',
      docs: { openapi: `${b}/openapi.json`, llms_txt: `${b}/llms.txt`, mcp: `${b}/mcp` },
      endpoints: {
        'GET /v1/profit': `profit for one coin — ${PRICES.profit}`,
        'GET /v1/compare': `rank coins for a rig — ${PRICES.compare}`,
        'GET /v1/hardware': 'free',
        'GET /v1/coins': 'free',
      },
      example: `${b}/v1/profit?coin=KAS&model=iceriver-ks0-ultra&kwh=0.08`,
    });
  });

  app.get('/openapi.json', (req, res) => res.json(openapi(baseUrl(req))));
  app.get('/llms.txt', (req, res) => res.type('text/plain').send(llmsTxt(baseUrl(req))));

  app.get('/v1/hardware', (req, res) => {
    const items = searchHardware({ q: req.query.q, coin: req.query.coin, type: req.query.type });
    res.json({ count: items.length, hardware: items });
  });

  app.get('/v1/coins', async (req, res, next) => {
    try {
      const coins = listCoins();
      if (req.query.live === undefined || req.query.live === '0') return res.json({ coins });
      const live = await market(Object.keys(COINS));
      res.json({ coins: coins.map((c) => ({ ...c, live: live.find((l) => l.coin === c.symbol) })) });
    } catch (e) {
      next(e);
    }
  });

  // Admin: set manual fallback data (e.g. for a new coin with no public API yet).
  app.get('/admin/overrides', requireAdmin, (req, res) => res.json(getOverrides()));
  app.post('/admin/overrides/:coin', requireAdmin, (req, res, next) => {
    try {
      res.json({ coin: req.params.coin.toUpperCase(), override: setOverride(req.params.coin, req.body || {}) });
    } catch (e) {
      next(new ApiError(e.code || 'bad_request', e.message));
    }
  });

  // ---------- Hosted MCP (free tier, rate-limited) ----------
  const mcpLimiter = dailyLimiter(Number(process.env.MCP_FREE_CALLS_PER_DAY ?? 50));
  app.post('/mcp', async (req, res) => {
    const isToolCall = [].concat(req.body || []).some((m) => m?.method === 'tools/call');
    if (isToolCall && !mcpLimiter(req.ip)) {
      return res.status(429).json({
        jsonrpc: '2.0',
        id: req.body?.id ?? null,
        error: { code: -32000, message: `Free MCP limit reached for today. Use the paid HTTP API (${baseUrl(req)}/llms.txt) with an x402 client, or the stdio MCP package with a wallet.` },
      });
    }
    try {
      const server = buildMcpServer({
        get_mining_profit: profit,
        compare_coins: compare,
        list_hardware: async (a) => ({ hardware: searchHardware(a) }),
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('[mcp]', e);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'internal error' } });
    }
  });
  app.all('/mcp', (req, res) => res.status(405).set('allow', 'POST').json({ error: { code: 'method_not_allowed', message: 'POST JSON-RPC to /mcp' } }));

  // ---------- Paid routes ----------
  const payments = await buildPaymentLayer();
  app.locals.payments = payments.cfg;
  app.use(payments.middleware);

  app.get('/v1/profit', async (req, res, next) => {
    try {
      res.json(await profit(req.query));
    } catch (e) {
      next(e);
    }
  });

  app.get('/v1/compare', async (req, res, next) => {
    try {
      res.json(await compare(req.query));
    } catch (e) {
      next(e);
    }
  });

  // ---------- Errors ----------
  app.use((req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: `no route ${req.method} ${req.path}`, hint: 'GET / lists endpoints' } });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ApiError) {
      return res.status(err.status).json({
        error: { code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}), ...(err.details ? { details: err.details } : {}) },
      });
    }
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'bad_json', message: 'request body is not valid JSON' } });
    }
    console.error(err);
    res.status(500).json({ error: { code: 'internal', message: 'internal error' } });
  });

  return app;
}

function requireAdmin(req, res, next) {
  const token = process.env.ADMIN_TOKEN;
  if (!token || req.get('authorization') !== `Bearer ${token}`) {
    return res.status(401).json({ error: { code: 'unauthorized', message: 'admin token required' } });
  }
  next();
}

function dailyLimiter(perDay) {
  const counts = new Map();
  let day = new Date().toISOString().slice(0, 10);
  return (key) => {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== day) {
      counts.clear();
      day = today;
    }
    const used = counts.get(key) || 0;
    if (used >= perDay) return false;
    counts.set(key, used + 1);
    return true;
  };
}

// Start when run directly.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const port = Number(process.env.PORT || 3000);
  createApp()
    .then((app) => {
      app.listen(port, () => {
        const p = app.locals.payments;
        console.log(`MinerProfit listening on :${port}`);
        console.log(p.enabled ? `[payments] x402 on ${p.networkName} -> ${p.payTo}, ${p.freePerDay} free calls/IP/day` : '[payments] disabled (set PAY_TO)');
      });
    })
    .catch((e) => {
      console.error('failed to start:', e.message);
      process.exit(1);
    });
}
