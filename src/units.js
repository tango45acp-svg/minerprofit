// Hashrate parsing/formatting. Everything internal is in H/s.

export const UNITS = {
  H: 1,
  KH: 1e3,
  MH: 1e6,
  GH: 1e9,
  TH: 1e12,
  PH: 1e15,
  EH: 1e18,
};

const PATTERN = /^\s*([0-9]*\.?[0-9]+(?:e[+-]?\d+)?)\s*([kmgtpe]?h)?(?:\/s)?\s*$/i;

/**
 * Parse "10TH", "10 TH/s", "440gh", "1.5e12", or a number (already H/s).
 * @param {string|number} input
 * @param {string} [defaultUnit="H"] unit to assume when none is given
 * @returns {number} hashrate in H/s
 */
export function parseHashrate(input, defaultUnit = 'H') {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input <= 0) throw new Error('hashrate must be a positive number');
    return input * UNITS[defaultUnit.toUpperCase()];
  }
  if (typeof input !== 'string') throw new Error('hashrate is required');
  const m = input.match(PATTERN);
  if (!m) throw new Error(`could not parse hashrate "${input}" — use a form like 10TH, 440GH/s or 65MH`);
  const value = Number(m[1]);
  const unit = (m[2] || defaultUnit).toUpperCase();
  const mult = UNITS[unit];
  if (!mult) throw new Error(`unknown hashrate unit "${m[2]}"`);
  if (!(value > 0)) throw new Error('hashrate must be greater than zero');
  return value * mult;
}

/** Format H/s in the most readable unit, e.g. 4.4e11 -> "440 GH/s". */
export function formatHashrate(hs) {
  if (!Number.isFinite(hs)) return null;
  const order = ['EH', 'PH', 'TH', 'GH', 'MH', 'KH'];
  for (const u of order) {
    if (hs >= UNITS[u]) return `${round(hs / UNITS[u], 3)} ${u}/s`;
  }
  return `${round(hs, 3)} H/s`;
}

export function round(n, digits = 2) {
  if (!Number.isFinite(n)) return n;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** Round money/coin values sensibly: small values keep more precision. */
export function smartRound(n) {
  if (!Number.isFinite(n)) return n;
  const a = Math.abs(n);
  if (a === 0) return 0;
  if (a >= 100) return round(n, 2);
  if (a >= 1) return round(n, 4);
  return Number(n.toPrecision(4));
}
