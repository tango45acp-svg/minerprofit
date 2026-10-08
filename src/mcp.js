// MCP tool definitions. Used by the hosted /mcp endpoint (direct calls into
// the service layer) and by mcp/stdio.js (which calls the paid HTTP API).
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export const TOOL_DEFS = {
  get_mining_profit: {
    title: 'Mining profit',
    description:
      'Live crypto mining profitability. Pass a coin and either a hardware model (see list_hardware) or hashrate+watts, plus electricity price in USD/kWh. Returns daily coins, revenue, power cost, profit, break-even electricity price and optional ROI days.',
    inputSchema: {
      coin: z.string().optional().describe('BTC, KAS, PRL, RVN or ERG. Optional when the model mines one coin.'),
      model: z.string().optional().describe('Hardware id(s), comma-separated, with optional :count. e.g. "rtx-4090,rtx-4080-super" or "ks0-ultra:3"'),
      hashrate: z.string().optional().describe('Raw hashrate with unit, e.g. "10TH" or "440GH". Use with watts instead of model.'),
      watts: z.number().optional().describe('Wall power draw in watts'),
      kwh: z.number().optional().describe('Electricity price in USD per kWh'),
      pool_fee: z.number().optional().describe('Pool fee percent, default 1'),
      hardware_cost: z.number().optional().describe('Hardware cost in USD for ROI'),
      price_usd: z.number().optional().describe('What-if coin price'),
    },
  },
  compare_coins: {
    title: 'Compare coins for a rig',
    description: 'Rank every coin a GPU/ASIC rig can mine by live daily profit at a given electricity price.',
    inputSchema: {
      model: z.string().describe('Hardware id(s), e.g. "rtx-4090" or "rtx-4090,rtx-4080-super"'),
      kwh: z.number().optional().describe('Electricity price in USD per kWh'),
      pool_fee: z.number().optional(),
      hardware_cost: z.number().optional(),
    },
  },
  list_hardware: {
    title: 'List hardware',
    description: 'Search supported miners and GPUs with stock hashrate and watts per coin. Use the id in other tools.',
    inputSchema: {
      q: z.string().optional().describe('Search text, e.g. "4090" or "ks0"'),
      coin: z.string().optional().describe('Only hardware that can mine this coin'),
      type: z.enum(['asic', 'gpu']).optional(),
    },
  },
};

/**
 * @param {Record<string,(args:object)=>Promise<any>>} handlers keyed by tool name
 */
export function buildMcpServer(handlers) {
  const server = new McpServer({ name: 'minerprofit', version: '1.0.0' });
  for (const [name, def] of Object.entries(TOOL_DEFS)) {
    server.registerTool(name, def, async (args) => {
      try {
        const data = await handlers[name](args);
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (e) {
        const err = { code: e.code || 'error', message: e.message, ...(e.hint ? { hint: e.hint } : {}) };
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: err }) }] };
      }
    });
  }
  return server;
}
