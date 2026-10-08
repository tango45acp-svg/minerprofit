// Hardware database: stock hashrate + wall power per coin.
// ASIC numbers are manufacturer stock specs; GPU numbers are tuned figures
// published by Kryptex Pool. Real rigs vary ±10% — callers can always pass
// hashrate/watts directly to override.
import { parseHashrate, formatHashrate } from './units.js';

const KRYPTEX = 'Kryptex Pool device page (tuned)';
const MFR = 'manufacturer stock spec';

export const HARDWARE = [
  // ---- Kaspa ASICs ----
  { id: 'iceriver-ks0', name: 'IceRiver KS0', type: 'asic', maker: 'IceRiver', aliases: ['ks0'], coins: { KAS: { hashrate: '100GH', watts: 65 } }, source: MFR },
  { id: 'iceriver-ks0-pro', name: 'IceRiver KS0 Pro', type: 'asic', maker: 'IceRiver', aliases: ['ks0pro'], coins: { KAS: { hashrate: '200GH', watts: 100 } }, source: MFR },
  { id: 'iceriver-ks0-ultra', name: 'IceRiver KS0 Ultra', type: 'asic', maker: 'IceRiver', aliases: ['ks0ultra'], coins: { KAS: { hashrate: '400GH', watts: 100 } }, source: MFR },
  { id: 'iceriver-ks3m', name: 'IceRiver KS3M', type: 'asic', maker: 'IceRiver', aliases: ['ks3m'], coins: { KAS: { hashrate: '6TH', watts: 3400 } }, source: MFR },
  { id: 'iceriver-ks5l', name: 'IceRiver KS5L', type: 'asic', maker: 'IceRiver', aliases: ['ks5l'], coins: { KAS: { hashrate: '12TH', watts: 3400 } }, source: MFR },
  { id: 'iceriver-ks5m', name: 'IceRiver KS5M', type: 'asic', maker: 'IceRiver', aliases: ['ks5m'], coins: { KAS: { hashrate: '15TH', watts: 3400 } }, source: MFR },
  { id: 'antminer-ks5-pro', name: 'Bitmain Antminer KS5 Pro', type: 'asic', maker: 'Bitmain', aliases: ['ks5pro'], coins: { KAS: { hashrate: '21TH', watts: 3150 } }, source: MFR },

  // ---- Bitcoin ASICs ----
  { id: 'antminer-s21', name: 'Bitmain Antminer S21', type: 'asic', maker: 'Bitmain', aliases: ['s21'], coins: { BTC: { hashrate: '200TH', watts: 3500 } }, source: MFR },
  { id: 'antminer-s21-pro', name: 'Bitmain Antminer S21 Pro', type: 'asic', maker: 'Bitmain', aliases: ['s21pro'], coins: { BTC: { hashrate: '234TH', watts: 3510 } }, source: MFR },
  { id: 'antminer-s21-xp', name: 'Bitmain Antminer S21 XP', type: 'asic', maker: 'Bitmain', aliases: ['s21xp'], coins: { BTC: { hashrate: '270TH', watts: 3645 } }, source: MFR },

  // ---- GPUs ----
  {
    id: 'rtx-5090', name: 'NVIDIA GeForce RTX 5090', type: 'gpu', maker: 'NVIDIA', aliases: ['5090', 'rtx5090'],
    coins: { PRL: { hashrate: '400TH', watts: 525 } }, source: KRYPTEX,
  },
  {
    id: 'rtx-4090', name: 'NVIDIA GeForce RTX 4090', type: 'gpu', maker: 'NVIDIA', aliases: ['4090', 'rtx4090'],
    coins: {
      PRL: { hashrate: '293TH', watts: 450 },
      RVN: { hashrate: '65MH', watts: 330 },
      ERG: { hashrate: '265MH', watts: 240 },
    },
    source: KRYPTEX,
  },
  {
    id: 'rtx-5080', name: 'NVIDIA GeForce RTX 5080', type: 'gpu', maker: 'NVIDIA', aliases: ['5080', 'rtx5080'],
    coins: { PRL: { hashrate: '215TH', watts: 260 } }, source: KRYPTEX,
  },
  {
    id: 'rtx-4080-super', name: 'NVIDIA GeForce RTX 4080 Super', type: 'gpu', maker: 'NVIDIA', aliases: ['4080super', 'rtx4080super', '4080s'],
    coins: { PRL: { hashrate: '203TH', watts: 270 } }, source: KRYPTEX,
  },
  {
    id: 'rtx-5070', name: 'NVIDIA GeForce RTX 5070', type: 'gpu', maker: 'NVIDIA', aliases: ['5070', 'rtx5070'],
    coins: { PRL: { hashrate: '124TH', watts: 160 } }, source: KRYPTEX,
  },
];

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

const INDEX = new Map();
for (const h of HARDWARE) {
  for (const key of [h.id, h.name, ...(h.aliases || [])]) INDEX.set(norm(key), h);
}

export function findHardware(query) {
  if (!query) return null;
  return INDEX.get(norm(query)) || null;
}

/**
 * Parse a rig spec like "rtx-4090,rtx-4080-super" or "ks0-ultra:3, ks0-pro"
 * into [{ hw, count }]. Throws with a helpful message on unknown models.
 */
export function parseRig(spec) {
  const parts = String(spec).split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error('model is empty');
  return parts.map((p) => {
    const [name, countStr] = p.split(/[:*]/).map((s) => s.trim());
    const count = countStr === undefined ? 1 : Number(countStr);
    if (!Number.isInteger(count) || count < 1 || count > 100000) {
      throw new Error(`invalid count in "${p}" — use model:count, e.g. rtx-4090:2`);
    }
    const hw = findHardware(name);
    if (!hw) {
      const e = new Error(`unknown model "${name}"`);
      e.code = 'unknown_model';
      e.hint = 'GET /v1/hardware lists supported models; or pass hashrate and watts directly';
      throw e;
    }
    return { hw, count };
  });
}

/** Sum hashrate (H/s) and watts of a rig for one coin. Returns null if any device can't mine it. */
export function rigTotals(rig, coinSymbol) {
  let hashrate = 0;
  let watts = 0;
  for (const { hw, count } of rig) {
    const spec = hw.coins[coinSymbol];
    if (!spec) return null;
    hashrate += parseHashrate(spec.hashrate) * count;
    watts += spec.watts * count;
  }
  return { hashrate, watts };
}

export function coinsForRig(rig) {
  const sets = rig.map(({ hw }) => new Set(Object.keys(hw.coins)));
  return [...sets[0]].filter((c) => sets.every((s) => s.has(c)));
}

export function describeHardware(h) {
  return {
    id: h.id,
    name: h.name,
    type: h.type,
    maker: h.maker,
    coins: Object.fromEntries(
      Object.entries(h.coins).map(([sym, s]) => [
        sym,
        { hashrate: formatHashrate(parseHashrate(s.hashrate)), hashrate_hs: parseHashrate(s.hashrate), watts: s.watts },
      ]),
    ),
    spec_source: h.source,
  };
}

export function searchHardware({ q, coin, type } = {}) {
  const nq = q ? norm(q) : null;
  return HARDWARE.filter((h) => {
    if (type && h.type !== String(type).toLowerCase()) return false;
    if (coin && !h.coins[String(coin).toUpperCase()]) return false;
    if (nq && ![h.id, h.name, ...(h.aliases || [])].some((k) => norm(k).includes(nq))) return false;
    return true;
  }).map(describeHardware);
}
