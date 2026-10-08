#!/usr/bin/env node
// Local (stdio) MCP server that calls the hosted MinerProfit HTTP API and
// pays per call with x402 from the agent's own wallet.
//
// Claude Desktop / Claude Code config:
// {
//   "mcpServers": {
//     "minerprofit": {
//       "command": "node",
//       "args": ["/path/to/minerprofit/mcp/stdio.js"],
//       "env": {
//         "MINERPROFIT_URL": "https://your-app.onrender.com",
//         "WALLET_PRIVATE_KEY": "0x...",          // funded with a little USDC on Base
//         "X402_NETWORK": "base"                   // or base-sepolia for testing
//       }
//     }
//   }
// }
// Without WALLET_PRIVATE_KEY it still works inside the server's free allowance.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildMcpServer } from '../src/mcp.js';

const BASE = (process.env.MINERPROFIT_URL || 'http://localhost:3000').replace(/\/$/, '');
const NETWORKS = { base: 'eip155:8453', 'base-sepolia': 'eip155:84532' };

async function makeFetch() {
  const key = process.env.WALLET_PRIVATE_KEY;
  if (!key) return fetch;
  const { wrapFetchWithPaymentFromConfig } = await import('@x402/fetch');
  const { ExactEvmScheme } = await import('@x402/evm');
  const { privateKeyToAccount } = await import('viem/accounts');
  const net = process.env.X402_NETWORK || 'base';
  return wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: NETWORKS[net] || net, client: new ExactEvmScheme(privateKeyToAccount(key)) }],
  });
}

const payFetch = await makeFetch();

async function call(path, args) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(args || {})) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const res = await payFetch(`${BASE}${path}?${qs}`);
  const body = await res.json().catch(() => ({}));
  if (res.status === 402) {
    throw Object.assign(new Error('payment required — set WALLET_PRIVATE_KEY with USDC on Base'), { code: 'payment_required' });
  }
  if (!res.ok) {
    const e = body?.error || {};
    throw Object.assign(new Error(e.message || `HTTP ${res.status}`), { code: e.code, hint: e.hint });
  }
  return body;
}

const server = buildMcpServer({
  get_mining_profit: (a) => call('/v1/profit', a),
  compare_coins: (a) => call('/v1/compare', a),
  list_hardware: (a) => call('/v1/hardware', a),
});

await server.connect(new StdioServerTransport());
