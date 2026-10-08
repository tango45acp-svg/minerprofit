// Coin registry. To add a coin: give it a WhatToMine tag and/or a native
// source, a CoinGecko id for price, and the unit miners usually quote it in.
import { kaspaNetwork, bitcoinNetwork } from './sources.js';

export const COINS = {
  BTC: {
    name: 'Bitcoin',
    algorithm: 'SHA-256',
    displayUnit: 'TH',
    coingeckoId: 'bitcoin',
    paprikaId: 'btc-bitcoin',
    wtmTag: null, // BTC lives in WhatToMine's ASIC list, not coins.json
    native: bitcoinNetwork,
  },
  KAS: {
    name: 'Kaspa',
    algorithm: 'kHeavyHash',
    displayUnit: 'GH',
    coingeckoId: 'kaspa',
    paprikaId: 'kas-kaspa',
    wtmTag: 'KAS',
    native: kaspaNetwork,
  },
  PRL: {
    name: 'Pearl',
    algorithm: 'pearlhash',
    displayUnit: 'TH',
    coingeckoId: 'pearl-2',
    wtmTag: 'PRL',
    native: null, // no stable public network API yet — WhatToMine, then manual overrides
    notes: 'New chain with a declining block reward; profitability moves fast.',
  },
  RVN: {
    name: 'Ravencoin',
    algorithm: 'KawPow',
    displayUnit: 'MH',
    coingeckoId: 'ravencoin',
    paprikaId: 'rvn-ravencoin',
    wtmTag: 'RVN',
    native: null,
  },
  ERG: {
    name: 'Ergo',
    algorithm: 'Autolykos2',
    displayUnit: 'MH',
    coingeckoId: 'ergo',
    paprikaId: 'erg-ergo',
    wtmTag: 'ERG',
    native: null,
  },
};

export function getCoin(symbol) {
  if (!symbol) return null;
  const sym = String(symbol).trim().toUpperCase();
  const byName = Object.entries(COINS).find(([, c]) => c.name.toUpperCase() === sym);
  if (COINS[sym]) return { symbol: sym, ...COINS[sym] };
  if (byName) return { symbol: byName[0], ...byName[1] };
  return null;
}

export function listCoins() {
  return Object.entries(COINS).map(([symbol, c]) => ({
    symbol,
    name: c.name,
    algorithm: c.algorithm,
    hashrate_unit: `${c.displayUnit}/s`,
    ...(c.notes ? { notes: c.notes } : {}),
  }));
}
