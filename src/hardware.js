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

  // ---- GPUs: every RTX 50 and 40 series card ----
  // [model, extra aliases, PRL TH/s, PRL W, RVN MH/s, RVN W, ERG MH/s, ERG W]
  ...[
    ['5090', [], 400, 525, 100.5, 460, 575, 295],
    ['5080', [], 215, 260, 62.5, 250, 315, 175],
    ['5070 Ti', ['5070ti'], 179, 210, 55.5, 235, 265.5, 155],
    ['5070', [], 124, 160, 45.5, 190, 225.5, 115],
    ['5060 Ti', ['5060ti', '5060ti16gb', '5060ti8gb'], 91, 110, 32, 130, 125.5, 70],
    ['5060', [], 76, 100, 22.5, 110, 113, 70],
    ['5050', [], 58, 95, 20.2, 110, 78.5, 75],
    ['4090', [], 293, 450, 65, 330, 265, 240],
    ['4080 Super', ['4080super', '4080s'], 203, 270, 52, 260, 180, 180],
    ['4080', [], 187, 270, 46, 260, 170, 180],
    ['4070 Ti Super', ['4070tisuper', '4070tis'], 167, 220, 45, 200, 161.5, 190],
    ['4070 Ti', ['4070ti'], 153, 200, 32, 170, 133, 90],
    ['4070 Super', ['4070super', '4070s'], 125, 195, 35.2, 200, 140, 190],
    ['4070', [], 113, 160, 30, 150, 132, 110],
    ['4060 Ti', ['4060ti', '4060ti16gb', '4060ti8gb'], 86, 125, 19, 110, 88, 70],
    ['4060', [], 65, 110, 17.9, 91, 73.9, 76],
  ].map(([model, extra, prl, prlW, rvn, rvnW, erg, ergW]) => {
    const slug = model.toLowerCase().replace(/\s+/g, '-');
    const compact = model.toLowerCase().replace(/\s+/g, '');
    return {
      id: `rtx-${slug}`,
      name: `NVIDIA GeForce RTX ${model}`,
      type: 'gpu',
      maker: 'NVIDIA',
      series: model.startsWith('5') ? 'RTX 50' : 'RTX 40',
      aliases: [compact, `rtx${compact}`, ...extra],
      coins: {
        PRL: { hashrate: `${prl}TH`, watts: prlW },
        RVN: { hashrate: `${rvn}MH`, watts: rvnW },
        ERG: { hashrate: `${erg}MH`, watts: ergW },
      },
      source: KRYPTEX,
    };
  }),
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
    ...(h.series ? { series: h.series } : {}),
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
