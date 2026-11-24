// SAFE RUNNER engine. PURE (no window, no Date): called at every live price (realtime) and at every closed 1m candle.
//
// Idea (from Gerry's brief + NQ 1m statistics in research/):
//  - before the profit reaches `act` points nothing changes: the user's stop stays.
//  - after that the position is split into tranches, each with its own stop, all at or above the FLOOR (entry + lock):
//      t1 tight   = top - r1 x (current leg)      current leg = from the last pause low to the top
//      t2 middle  = top - r2 x (current leg)
//      t3 deep    = top - r3 x (current leg)      r3 ~ 1 = the pause low: below it the "opposite trade" is right
//      run runner = top - rRun x (whole move)     whole move = from the origin of the trade to the top
//    each tranche exits when its stop is touched; stops only move forward (never widened).
//  - a climax candle at the top (range >= climaxAtr ATR) tightens the leg stops (x climaxK): NQ 1m data say that after a
//    climax bar the run continues much less often (about 30% against 50%).
//  - weight of each tranche = fraction of the size (w1..w3, wRun).
// Everything is computed for a LONG; shorts are mirrored (prices negated) in and out.

const TA = require('./ta');

const DEFAULTS = {
  act: 10, // points of profit (best price) before the engine takes over
  lock: 1, // points of profit the floor keeps (entry + lock)
  // per tranche: stop = top - min(r x base, m x ATR); base = current leg (t1 t2 t3) or whole move (runner).
  // r = structure (fraction of the impulse), m = adaptive trailing (ATR multiple); null = not used
  tr: [
    { r: 0.38, m: 0.75 },
    { r: 0.62, m: 1.5 },
    { r: 1.0, m: 2.5 },
    { r: 0.5, m: 4 },
  ],
  w: [0.25, 0.25, 0.25, 0.25], // fractions of the size: t1 t2 t3 runner
  buf: 0.2, // ATR beyond the pause low (when r >= 1)
  climaxAtr: 2.5,
  climaxK: 0.6,
  pivotK: 2, // a pause low = low lower than the pivotK candles before and after
  waitAtStart: true, // on the activation candle no stop already past the close (measured from the close)
  htfGate: true, // runner wide only with the 1h trend guide in favour (EMA20 above EMA50 for a long)
};
const KEYS = ['t1', 't2', 't3', 'run'];

const cfgOf = (c) => ({ ...DEFAULTS, ...(c || {}) });

/**
 * input: { side, entry, bars (1m closed, ascending), iEntry (index of the candle of the entry), mark? (live price),
 *          prev (previous result or null), cfg }
 * returns { active, best, top, iTop, origin, legLo, atr, climax, stops: { t1, t2, t3, run } (prices, real side) | null,
 *           floor, why? }
 */
function evaluate({ side, entry, bars, iEntry, mark, prev, cfg, atr: atr0, htf }) {
  const c = cfgOf(cfg);
  const d = side === 'short' ? -1 : 1;
  const B = d > 0 ? bars : bars.map(TA.mirrorBar);
  const E = d * entry;
  const P = prev ? { ...prev, best: d * prev.best, top: d * prev.top, origin: d * prev.origin, stops: prev.stops && mir(prev.stops, d) } : null;
  const n = B.length;
  if (!(iEntry >= 0) || iEntry >= n + 1) return { active: false, why: 'entry candle not in the bars' };
  // best: highs of the candles AFTER the entry candle (inside the entry candle the order of high / low is unknown) + live
  let best = P ? P.best : E,
    iTop = P && P.iTop != null ? P.iTop : iEntry;
  for (let i = Math.max(iEntry + 1, 0); i < n; i++) if (B[i].h > best) (best = B[i].h), (iTop = i);
  if (Number.isFinite(mark) && d * mark > best) best = d * mark;
  const atr = Number.isFinite(atr0) && atr0 > 0 ? atr0 : TA.atrSeries(B, 14)[n - 1]; // atr0: already computed by the caller
  const out = { active: !!(P && P.active), best: d * best, iTop, atr };
  if (!out.active && best - E < c.act) return { ...out, why: `waiting for ${c.act} pt of profit` };
  out.active = true;
  // origin of the trade: lowest low from 2 candles before the entry to the top
  let origin = P && P.active && Number.isFinite(P.origin) ? P.origin : Infinity;
  if (!Number.isFinite(origin)) for (let i = Math.max(0, iEntry - 2); i <= Math.min(n - 1, iTop); i++) origin = Math.min(origin, B[i].l);
  if (!Number.isFinite(origin)) origin = E;
  const top = Math.max(best, P && Number.isFinite(P.top) ? P.top : -Infinity);
  // last pause low before the top: pivot low after the origin, confirmed by pivotK candles on both sides;
  // none yet = the lowest low after the entry candle (the leg starts in the trade, not before it)
  let legLo = Infinity;
  for (let i = iEntry + 1; i <= Math.min(iTop, n - 1); i++) legLo = Math.min(legLo, B[i].l);
  if (!Number.isFinite(legLo)) legLo = Math.min(E, origin);
  const k = c.pivotK;
  for (let i = Math.min(iTop, n - 1) - 1; i > Math.max(iEntry - 2, k - 1); i--) {
    let ok = i + k <= n - 1;
    for (let j = 1; ok && j <= k; j++) if (!(B[i].l < B[i - j].l && B[i].l <= B[i + j].l)) ok = false;
    if (ok && B[i].l > origin && i > iEntry) {
      legLo = B[i].l;
      break;
    }
  }
  const leg = Math.max(top - legLo, 1e-9),
    move = Math.max(top - origin, 1e-9);
  // climax: a big candle at the top (the top candle or the one after)
  const climax = iTop >= n - 2 && iTop >= 0 && iTop < n && atr > 0 && B[iTop].h - B[iTop].l >= c.climaxAtr * atr;
  const f = climax ? c.climaxK : 1;
  const floor = E + c.lock;
  const buf = (atr > 0 ? atr : 0) * c.buf;
  const A = atr > 0 ? atr : 0;
  const dist = (t, base, isLeg) => {
    const ds = [];
    if (t && t.r != null) ds.push(t.r * (isLeg ? f : 1) * base + (t.r >= 1 ? buf : 0));
    if (t && t.m != null && A > 0) ds.push(t.m * (isLeg ? f : 1) * A);
    return ds.length ? Math.min(...ds) : Infinity;
  };
  let T = c.tr || DEFAULTS.tr;
  // trend guide gate: without the higher timeframe trend in favour, the runner is managed like t1 (no wide stop)
  const gated = c.htfGate && !(htf && htf.aligned);
  if (gated) T = [T[0], T[1], T[2], T[0]];
  const raw = {
    t1: top - dist(T[0], leg, true),
    t2: top - dist(T[1], leg, true),
    t3: top - dist(T[2], leg, true),
    run: top - dist(T[3], move, false),
  };
  if (!gated) raw.run = Math.min(raw.run, raw.t3); // the runner is the last one out
  // start without exits (Gerry 2026-11-20): on the candle where the engine takes over, a stop that is already past the
  // close is put at the same distance from the close instead of from the top (no tranche thrown out at once)
  const startNow = !(P && P.active) && c.waitAtStart !== false;
  // realtime (Gerry 2026-11-20): with a live price the "close" is that price, not the last closed candle
  const close = Number.isFinite(mark) ? d * mark : B[n - 1].c;
  if (startNow) for (const key of KEYS) if (raw[key] >= close) raw[key] = close - (top - raw[key]);
  const stops = {};
  for (const key of KEYS) {
    let v = Math.max(raw[key], floor);
    if (P && P.stops && Number.isFinite(P.stops[key])) v = Math.max(v, P.stops[key]); // never widened
    stops[key] = v;
  }
  return { ...out, best: d * best, top: d * top, origin: d * origin, legLo: d * legLo, climax, gated, floor: d * floor, stops: mir(stops, d) };
}

function mir(stops, d) {
  const o = {};
  for (const key of KEYS) o[key] = stops[key] == null ? stops[key] : d * stops[key];
  return o;
}

/** Quantities of the tranches for a size (rounded down to step; what is left over goes to the runner). */
function split(qty, w, step) {
  const ws = w && w.length === 4 ? w : DEFAULTS.w;
  const tot = ws.reduce((s, x) => s + Math.max(0, x), 0) || 1;
  const q = {};
  let used = 0;
  KEYS.forEach((key, i) => {
    if (key === 'run') return;
    const v = step > 0 ? Math.floor(((qty * Math.max(0, ws[i])) / tot) / step + 1e-9) * step : (qty * Math.max(0, ws[i])) / tot;
    q[key] = +v.toFixed(10);
    used += q[key];
  });
  q.run = +(qty - used).toFixed(10);
  return q;
}

module.exports = { evaluate, split, DEFAULTS, KEYS };
