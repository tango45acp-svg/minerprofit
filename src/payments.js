// x402 payments (USDC on Base) + a small free tier.
//
// Env:
//   PAY_TO            your EVM address that receives USDC. Unset = payments off (dev mode).
//   X402_NETWORK      "base" (mainnet) or "base-sepolia" (testnet, default)
//   CDP_API_KEY_ID / CDP_API_KEY_SECRET   needed for the mainnet Coinbase facilitator
//   FACILITATOR_URL   custom facilitator (optional)
//   PRICE_PROFIT / PRICE_COMPARE          e.g. "$0.002"
//   FREE_CALLS_PER_DAY                    per-IP free calls on paid routes (default 25)
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { declareDiscoveryExtension, bazaarResourceServerExtension } from '@x402/extensions/bazaar';

const NETWORKS = {
  base: 'eip155:8453',
  'base-sepolia': 'eip155:84532',
};

export const PRICES = {
  profit: process.env.PRICE_PROFIT || '$0.002',
  compare: process.env.PRICE_COMPARE || '$0.005',
};

export function paymentConfig() {
  const payTo = process.env.PAY_TO;
  const netName = process.env.X402_NETWORK || 'base-sepolia';
  const network = NETWORKS[netName] || netName;
  return {
    enabled: Boolean(payTo),
    payTo,
    networkName: netName,
    network,
    testnet: network === NETWORKS['base-sepolia'],
    freePerDay: Number(process.env.FREE_CALLS_PER_DAY ?? 25),
  };
}

async function facilitatorClient(cfg) {
  if (process.env.FACILITATOR_URL) return new HTTPFacilitatorClient({ url: process.env.FACILITATOR_URL });
  if (!cfg.testnet) {
    if (!process.env.CDP_API_KEY_ID || !process.env.CDP_API_KEY_SECRET) {
      throw new Error('mainnet payments need CDP_API_KEY_ID and CDP_API_KEY_SECRET (free at portal.cdp.coinbase.com)');
    }
    const { facilitator } = await import('@coinbase/x402');
    return new HTTPFacilitatorClient(facilitator);
  }
  return new HTTPFacilitatorClient({ url: 'https://x402.org/facilitator' });
}

const profitDiscovery = declareDiscoveryExtension({
  method: 'GET',
  input: { coin: 'KAS', model: 'iceriver-ks0-ultra', kwh: 0.08 },
  inputSchema: {
    properties: {
      coin: { type: 'string', description: 'BTC, KAS, PRL, RVN, ERG' },
      model: { type: 'string', description: 'hardware id(s), e.g. rtx-4090,rtx-4080-super or ks0-ultra:3' },
      hashrate: { type: 'string', description: 'e.g. 10TH, 440GH (use instead of model)' },
      watts: { type: 'number' },
      kwh: { type: 'number', description: 'electricity USD/kWh' },
      pool_fee: { type: 'number' },
      hardware_cost: { type: 'number', description: 'USD, enables roi_days' },
    },
  },
  output: {
    example: {
      coin: 'KAS',
      daily: { coins: 412.3, revenue_usd: 31.2, power_cost_usd: 0.19, profit_usd: 31.01 },
      breakeven_electricity_usd_per_kwh: 13.0,
    },
  },
});

const compareDiscovery = declareDiscoveryExtension({
  method: 'GET',
  input: { model: 'rtx-4090', kwh: 0.1 },
  inputSchema: {
    properties: {
      model: { type: 'string', description: 'hardware id(s)' },
      kwh: { type: 'number' },
      hardware_cost: { type: 'number' },
    },
    required: ['model'],
  },
  output: { example: { best: { coin: 'PRL', daily_profit_usd: 1.23 }, ranking: [] } },
});

/**
 * Returns express middleware that lets free-tier calls through and
 * requires x402 payment for the rest. When payments are off, everything passes.
 */
export async function buildPaymentLayer() {
  const cfg = paymentConfig();
  if (!cfg.enabled) {
    console.warn('[payments] PAY_TO not set — paid routes are FREE (dev mode)');
    return { cfg, middleware: (req, res, next) => next() };
  }

  const fc = await facilitatorClient(cfg);
  const server = new x402ResourceServer(fc)
    .register(cfg.network, new ExactEvmScheme())
    .registerExtension(bazaarResourceServerExtension);

  const accepts = (price) => ({ scheme: 'exact', price, network: cfg.network, payTo: cfg.payTo, maxTimeoutSeconds: 60 });
  const common = { mimeType: 'application/json', serviceName: 'MinerProfit', tags: ['crypto', 'mining', 'profitability'] };
  const routes = {
    'GET /v1/profit': {
      ...common,
      accepts: accepts(PRICES.profit),
      description: 'Live mining profitability for a coin + hashrate/hardware + electricity price',
      extensions: profitDiscovery,
    },
    'GET /v1/compare': {
      ...common,
      accepts: accepts(PRICES.compare),
      description: 'Rank every coin a GPU/ASIC rig can mine by live daily profit',
      extensions: compareDiscovery,
    },
  };

  const sync = process.env.X402_SYNC_ON_START !== '0';
  const pay = paymentMiddleware(routes, server, { appName: 'MinerProfit', testnet: cfg.testnet }, undefined, sync);
  const free = freeTier(cfg.freePerDay);

  return {
    cfg,
    middleware: (req, res, next) => {
      if (free(req, res)) return next();
      return pay(req, res, next);
    },
  };
}

// ---------- Free tier (per IP, per UTC day, in memory) ----------

const PAID_PATHS = new Set(['/v1/profit', '/v1/compare']);

export function freeTier(perDay) {
  const counts = new Map();
  let day = utcDay();
  return function allowFree(req, res) {
    if (!PAID_PATHS.has(req.path)) return true; // not a paid route
    if (req.get('x-payment') || req.get('payment-signature')) return false; // caller is paying
    if (perDay <= 0) return false;
    const today = utcDay();
    if (today !== day) {
      counts.clear();
      day = today;
    }
    const key = req.ip || 'unknown';
    const used = counts.get(key) || 0;
    if (used >= perDay) {
      res.set('x-free-calls-remaining', '0');
      return false;
    }
    counts.set(key, used + 1);
    res.set('x-free-calls-remaining', String(perDay - used - 1));
    return true;
  };
}

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}
