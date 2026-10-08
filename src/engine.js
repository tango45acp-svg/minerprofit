// Pure profit math — no I/O, easy to test.
import { formatHashrate, smartRound, round } from './units.js';

/**
 * @param {object} p
 * @param {object} p.snapshot   from market.getSnapshot
 * @param {number} p.hashrate   H/s
 * @param {number} p.watts      wall power
 * @param {number} p.kwh        USD per kWh
 * @param {number} [p.poolFeePct=1]
 * @param {number} [p.hardwareCostUsd]
 */
export function calcProfit({ snapshot, hashrate, watts, kwh, poolFeePct = 1, hardwareCostUsd }) {
  const s = snapshot;
  const warnings = [];

  const share = hashrate / s.networkHashrate;
  if (share > 0.5) warnings.push('your hashrate is over half the network — check the unit you passed');
  const blocksPerDay = 86400 / s.blockTimeSec;
  const grossCoins = share * blocksPerDay * s.blockReward;
  const coinsPerDay = grossCoins * (1 - poolFeePct / 100);

  const revenue = coinsPerDay * s.priceUsd;
  const kwhPerDay = (watts / 1000) * 24;
  const powerCost = kwhPerDay * kwh;
  const profit = revenue - powerCost;
  const breakevenKwh = kwhPerDay > 0 ? revenue / kwhPerDay : null;

  if (s.stale) warnings.push('some upstream data is stale; numbers use the last good value');
  if (profit < 0) warnings.push('unprofitable at this electricity price');

  const out = {
    coin: s.symbol,
    coin_name: s.name,
    algorithm: s.algorithm,
    inputs: {
      hashrate: formatHashrate(hashrate),
      hashrate_hs: hashrate,
      watts,
      electricity_usd_per_kwh: kwh,
      pool_fee_pct: poolFeePct,
      ...(hardwareCostUsd ? { hardware_cost_usd: hardwareCostUsd } : {}),
    },
    market: {
      price_usd: smartRound(s.priceUsd),
      network_hashrate: formatHashrate(s.networkHashrate),
      block_reward: smartRound(s.blockReward),
      block_time_sec: s.blockTimeSec,
      sources: s.sources,
      as_of: s.asOf,
      stale: s.stale,
    },
    daily: {
      coins: smartRound(coinsPerDay),
      revenue_usd: round(revenue, 2),
      power_cost_usd: round(powerCost, 2),
      profit_usd: round(profit, 2),
    },
    weekly_profit_usd: round(profit * 7, 2),
    monthly_profit_usd: round(profit * 30, 2),
    breakeven_electricity_usd_per_kwh: breakevenKwh === null ? null : round(breakevenKwh, 4),
    margin_pct: revenue > 0 ? round((profit / revenue) * 100, 1) : null,
    network_share_pct: Number((share * 100).toPrecision(4)),
  };

  if (hardwareCostUsd) {
    out.roi_days = profit > 0 ? round(hardwareCostUsd / profit, 1) : null;
    if (profit <= 0) warnings.push('hardware never pays back at current conditions');
  }
  if (s.notes) warnings.push(s.notes);
  out.warnings = warnings;
  out.assumptions = [
    'constant price, network hashrate and block reward (real results drift)',
    'pool luck averages out (PPS-like payout)',
    'power is wall draw running 24h/day',
  ];
  return out;
}
