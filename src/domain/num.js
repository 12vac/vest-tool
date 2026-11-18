// Numbers and price/size grids. PURE: no window, no Date.

const EPS = 1e-9;

/** Number from a Vest string/value; NaN if missing. */
const num = (v) => (v == null || v === '' ? NaN : typeof v === 'number' ? v : parseFloat(v));

/** Decimals of a step (0.25 -> 2, 0.0001 -> 4). */
function decimalsOf(step) {
  if (!(step > 0)) return 0;
  const s = String(step);
  if (s.includes('e-')) return parseInt(s.split('e-')[1], 10);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

/** Rounds to the tick. mode: 'nearest' | 'up' | 'down'. Result cleaned of float noise. */
function roundToTick(price, tick, mode = 'nearest') {
  if (!(tick > 0)) throw new Error('invalid tick');
  const n = price / tick;
  const k = mode === 'up' ? Math.ceil(n - EPS) : mode === 'down' ? Math.floor(n + EPS) : Math.round(n);
  return +(k * tick).toFixed(decimalsOf(tick));
}

/** Quantity rounded down to the step (never round a size up). */
function floorStep(qty, step) {
  if (!(step > 0)) throw new Error('invalid step');
  return +(Math.floor(qty / step + EPS) * step).toFixed(decimalsOf(step));
}

const fmtFixed = (v, dec) => (Number.isFinite(v) ? v.toFixed(dec) : '—');

/**
 * Comparison of integer counters received as STRINGS (account_seq): no parseInt, which loses precision above 2^53
 * and would discard new events as "repeated". Returns <0, 0, >0; NaN if either is not an integer.
 */
function cmpSeq(a, b) {
  const x = String(a).replace(/^0+(?=\d)/, ''),
    y = String(b).replace(/^0+(?=\d)/, '');
  if (!/^\d+$/.test(x) || !/^\d+$/.test(y)) return NaN;
  return x.length - y.length || (x < y ? -1 : x > y ? 1 : 0);
}

module.exports = { EPS, num, decimalsOf, roundToTick, floorStep, fmtFixed, cmpSeq };
