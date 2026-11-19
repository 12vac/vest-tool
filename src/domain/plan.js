// Risk & targets (column section): trade plan computed from the chosen size, stop and target rules.
// Calculation only: nothing here sends orders. Linear contracts: P&L = size x points.
const { roundToTick, floorStep, decimalsOf } = require('./num');

const SPLITS = ['even', 'front', 'back'];
const SIZE_BY = ['risk', 'pct', 'qty']; // risk in $ / % of the maximum size / fixed quantity
const STOP_BY = ['dist', 'ticks', 'bar', 'atr']; // price distance / ticks / last closed candle low-high ± ticks / ATR multiple
const TGT_BY = ['r', 'ticks', 'dist', 'atr', 'trail']; // multiple of the stop distance / ticks / price distance / ATR multiple / no TP (trailing)

/** Weights of the targets: even = equal parts, front = more on the first, back = more on the last. */
function weights(n, split) {
  const w = [];
  for (let i = 0; i < n; i++) w.push(split === 'front' ? n - i : split === 'back' ? i + 1 : 1);
  return w;
}

/** Splits qty among the weights, each part rounded down to the step; the last one takes what is left. */
function splitQty(qty, w, step) {
  const sum = w.reduce((a, b) => a + b, 0);
  const out = [];
  let used = 0;
  for (let i = 0; i < w.length; i++) {
    const q = i === w.length - 1 ? floorStep(qty - used, step) : floorStep((qty * w[i]) / sum, step);
    out.push(q);
    used += q;
  }
  return out;
}

/** Stop price for the rule, or { why }. bar = { h, l } of the last closed candle. */
function stopPrice({ side, entry, by, val, tick, bar, atr }) {
  const sgn = side === 'long' ? 1 : -1;
  let raw;
  if (by === 'dist') raw = val > 0 ? entry - sgn * val : NaN;
  else if (by === 'ticks') raw = val > 0 ? entry - sgn * val * tick : NaN;
  else if (by === 'atr') {
    if (!(atr > 0)) return { why: 'ATR not read yet' };
    raw = val > 0 ? entry - sgn * val * atr : NaN;
  } else if (by === 'bar') {
    if (!bar || !(bar.h > 0) || !(bar.l > 0)) return { why: 'last candle not read yet' };
    const off = val > 0 ? val * tick : 0;
    raw = side === 'long' ? bar.l - off : bar.h + off;
    if (sgn * (entry - raw) <= 0) return { why: `the last candle ${side === 'long' ? 'low is above' : 'high is below'} the price: no stop there` };
  } else return { why: 'stop rule?' };
  if (!Number.isFinite(raw)) return { why: 'set the stop value' };
  const sl = roundToTick(raw, tick);
  if (!(sgn * (entry - sl) > 0)) return { why: 'stop distance below one tick' };
  return { sl };
}

/**
 * plan({ side, entry, step, tick, maxQty, capPct, fee, sizeBy, sizeVal, fees, stopBy, stopVal, bar, atr, targets: [{ on, by, val }], split })
 * -> { qty, capped, capQty, sl, riskUsd, targets: [{ n, by, val, price|NaN, qty, reward }], why }
 * fee = taker fee rate; with fees on, the risk counts the entry and exit fee. why: reason there is no plan (qty 0) or a warning.
 */
function plan(o) {
  const { side, entry, step, tick, maxQty, capPct, fee } = o;
  const none = (why, extra) => ({ qty: 0, capped: false, sl: NaN, riskUsd: 0, targets: [], why, ...extra });
  if (side !== 'long' && side !== 'short') return none('side?');
  if (!(entry > 0)) return none('price not read yet');
  if (!(step > 0) || !(tick > 0)) return none('market not read yet');
  const sizeBy = SIZE_BY.includes(o.sizeBy) ? o.sizeBy : 'risk';
  const sizeVal = +o.sizeVal;
  if (!(sizeVal > 0)) return none(sizeBy === 'risk' ? 'set the risk in $' : sizeBy === 'pct' ? 'set the size in %' : 'set the quantity');
  const st = stopPrice({ side, entry, by: o.stopBy, val: +o.stopVal, tick, bar: o.bar, atr: o.atr });
  if (st.why) return none(st.why);
  const sl = st.sl;
  const d = Math.abs(entry - sl);
  const feeRate = o.fees && fee > 0 ? fee : 0;
  const lossPerUnit = d + feeRate * (entry + sl); // price distance plus entry and exit fee per unit
  let qty;
  if (sizeBy === 'risk') qty = floorStep(sizeVal / lossPerUnit, step);
  else if (sizeBy === 'pct') qty = maxQty > 0 ? floorStep((maxQty * Math.min(100, sizeVal)) / 100, step) : 0;
  else qty = floorStep(sizeVal, step);
  // never above the per-order cap of the panel (percentage of the maximum size)
  const capQty = maxQty > 0 && capPct > 0 ? floorStep((maxQty * Math.min(100, capPct)) / 100, step) : NaN;
  const capped = Number.isFinite(capQty) && qty > capQty;
  if (capped) qty = capQty;
  if (!(qty > 0)) return none(capped ? 'size cap is 0: no free margin?' : sizeBy === 'pct' && !(maxQty > 0) ? 'maximum size not read yet' : 'size below the minimum', { sl, capQty });
  const sgn = side === 'long' ? 1 : -1;
  const on = (o.targets || [])
    .map((t, i) => ({ n: i + 1, on: !!t.on, by: TGT_BY.includes(t.by) ? t.by : 'r', val: +t.val }))
    .filter((t) => t.on && (t.by === 'trail' || t.val > 0));
  const qs = on.length ? splitQty(qty, weights(on.length, SPLITS.includes(o.split) ? o.split : 'even'), step) : [];
  let why = null;
  const tg = on.map((t, i) => {
    let dist = NaN;
    if (t.by === 'r') dist = d * t.val;
    else if (t.by === 'ticks') dist = t.val * tick;
    else if (t.by === 'dist') dist = t.val;
    else if (t.by === 'atr') dist = o.atr > 0 ? t.val * o.atr : NaN;
    if (t.by === 'atr' && !(o.atr > 0)) why = why || 'ATR not read yet: ATR targets missing';
    const price = Number.isFinite(dist) ? roundToTick(entry + sgn * dist, tick) : NaN;
    const reward = Number.isFinite(price) ? qs[i] * Math.abs(price - entry) - qs[i] * feeRate * (entry + price) : NaN;
    return { n: t.n, by: t.by, val: t.val, price, qty: qs[i], reward };
  });
  if (tg.some((t) => !(t.qty > 0))) why = 'size too small to split among the targets';
  return { qty, capped, capQty, sl, riskUsd: qty * lossPerUnit, targets: tg, why };
}

/**
 * SL / TP legs attached to an entry order (Vest /open: takeProfits[] and stopLosses[], prices and sizes as strings).
 * A leg without quantity covers the whole position; partial legs carry their quantity (their sum must not exceed qty).
 * targets = [{ price, qty }] of the plan (a trailing part has no price: no TP, the stop still covers it).
 * each = one stop per target with that target's size, otherwise one stop for everything. -> { takeProfits, stopLosses } or { why }
 * NOTE: the format of partial legs comes from notes on Vest's fields, not yet seen on a real order.
 */
function entryLegs({ qty, sl, targets, each, step, tick }) {
  const pd = decimalsOf(tick),
    qd = decimalsOf(step);
  if (!(qty > 0)) return { why: 'no size' };
  if (!(sl > 0)) return { why: 'no stop price' };
  const all = (targets || []).filter((t) => t.qty > 0);
  if (all.length !== (targets || []).length) return { why: 'a target has no size (size too small to split)' };
  const tps = all.filter((t) => Number.isFinite(t.price) && t.price > 0);
  const sum = tps.reduce((a, t) => a + t.qty, 0);
  if (sum > qty + step / 2) return { why: 'targets larger than the size' };
  const leg = (price, q) => (q == null ? { executionType: 'market', triggerPrice: price.toFixed(pd) } : { executionType: 'market', triggerPrice: price.toFixed(pd), quantity: q.toFixed(qd) });
  const whole = (q) => Math.abs(q - qty) < step / 2;
  const takeProfits = tps.map((t) => leg(t.price, tps.length === 1 && whole(t.qty) ? null : t.qty));
  const stopLosses = each && all.length > 1 ? all.map((t) => leg(sl, t.qty)) : [leg(sl, null)];
  return { takeProfits, stopLosses };
}

module.exports = { plan, stopPrice, weights, splitQty, entryLegs, SPLITS, SIZE_BY, STOP_BY, TGT_BY };
