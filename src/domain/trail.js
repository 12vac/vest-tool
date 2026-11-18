// Trailing stop and auto BE. PURE. Trailing MOVES Vest's NATIVE STOP (PUT stop-loss): if the tab closes
// the stop stays where it got to. Forward only: a stop is never widened.
// Values in points or dollars: dollars are divided by the size (linear contracts, $1 per point per unit).

const { dirOf } = require('./money');
const { roundToTick } = require('./num');
const { checkLeg, breakevenPrice } = require('./orders');

/** Value in price points: 'pt' as it is, '$' divided by the size. NaN if it cannot be computed. */
const toPts = (v, unit, qty) => {
  const n = +v;
  if (!(n >= 0) || v === '' || v == null) return NaN;
  if (unit === '$') return qty > 0 ? n / qty : NaN;
  return n;
};

/**
 * One trailing step at every price.
 * best = best price seen so far (null at first), active = already started, sl = current stop price (null if none).
 * act / dist / step in unit ('pt' | '$'): starts after act of profit, stop at dist from the best, moved only if it
 * advances by at least step (fewer orders). Returns { best, active, level, action } with action:
 *   { type: 'sl', price }  to set / move
 *   { type: 'close' }      the price has already passed the level and the stop is missing or behind by at least one step
 *   undefined              nothing to do
 */
function trailStep({ side, qty, entry, mark, tick, best, active, sl, act, dist, step, unit }) {
  const d = dirOf(side);
  const nb = best == null ? mark : d > 0 ? Math.max(best, mark) : Math.min(best, mark);
  const actP = toPts(act, unit, qty),
    distP = toPts(dist, unit, qty),
    stepP = toPts(step === '' || step == null ? 0 : step, unit, qty);
  if (!(distP > 0) || !(actP >= 0)) return { best: nb, active: !!active, why: 'invalid trailing parameters' };
  const on = !!active || d * (nb - entry) >= actP;
  if (!on) return { best: nb, active: false };
  const level = roundToTick(nb - d * distP, tick, d > 0 ? 'down' : 'up'); // retracement never less than dist
  const out = { best: nb, active: true, level };
  // profit only (with retracement > start the stop ended up below the entry and triggered at a loss):
  // the level must be at least one tick beyond the entry, otherwise no stop and no close
  if (d * (level - entry) < tick - 1e-9) return { ...out, waitProfit: true };
  if (sl != null && d * (sl - level) >= 0) return out; // the stop is already there or further ahead
  const small = sl != null && d * (level - sl) < Math.max(stepP || 0, tick) - 1e-9; // behind by less than one step: fine as it is
  if (small) return out; // even if the price is beyond the level: the native stop handles it, shortly after
  if (d * (mark - level) <= 0) {
    // stop missing or left behind (rejected?): close at market only if the CURRENT PRICE is in profit, not just the level
    if (d * (mark - entry) < tick - 1e-9) return { ...out, waitProfit: true };
    return { ...out, action: { type: 'close' } };
  }
  if (checkLeg({ kind: 'sl', side, price: level, mark, tick })) return out; // too close to the price: next round
  return { ...out, action: { type: 'sl', price: level } };
}

/**
 * Auto BE: when the profit reaches `at`, stop at entry + `off` (BE+). Price to set or null.
 * Does not touch a stop already at that level or beyond.
 */
function autoBe({ side, qty, entry, mark, tick, sl, at, off, unit }) {
  const d = dirOf(side);
  const atP = toPts(at, unit, qty);
  if (!(atP > 0) || d * (mark - entry) < atP) return null;
  const offP = toPts(off === '' || off == null ? 0 : off, unit, qty);
  if (!(offP >= 0)) return null;
  const price = breakevenPrice(side, entry, tick, offP);
  if (sl != null && d * (sl - price) >= 0) return null;
  if (checkLeg({ kind: 'sl', side, price, mark, tick })) return null;
  return price;
}

/**
 * What to show on the chart (three segments between candles and labels). Prices already on the tick, null = do not show.
 *   stop: where the trailing stop is (or will be)
 *   act:  price at which trailing places the first stop (ACTUAL start level: with "profit only" it can be farther
 *         than "start after" if the retracement is larger); null once the stop is placed
 *   next: price the market must touch for the stop to advance by the next step
 */
function trailView({ side, qty, entry, mark, tick, best, active, sl, act, dist, step, unit }) {
  const d = dirOf(side);
  const actP = toPts(act, unit, qty),
    distP = toPts(dist, unit, qty),
    stepP = toPts(step === '' || step == null ? 0 : step, unit, qty);
  if (!(distP > 0) || !(actP >= 0) || !(tick > 0)) return null;
  const st = Math.max(stepP || 0, tick);
  const R = (p) => roundToTick(p, tick, 'nearest');
  const firstAt = entry + d * (tick + distP); // price from which the level is at least one tick in profit
  const r = trailStep({ side, qty, entry, mark, tick, best, active, sl, act, dist, step, unit });
  if (!r.active || r.waitProfit) {
    const a0 = entry + d * actP;
    const a = d * (firstAt - a0) > 0 ? firstAt : a0;
    return { active: !!r.active, act: R(a), stop: R(a - d * distP), next: R(a + d * st) };
  }
  const stop = sl != null && d * (sl - r.level) >= 0 ? sl : r.level;
  return { active: true, act: null, stop, next: R(stop + d * (distP + st)) };
}

module.exports = { toPts, trailStep, autoBe, trailView };
