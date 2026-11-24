// Exit grid (column section, experimental): several SL and TP legs on the open position, from a nearest and a farthest
// distance, a number of levels in between and two distribution curves (distances and sizes). PURE: nothing is sent here.
// Gerry 2026-11-23. Distances in points from the average entry; sizes as shares of the position.
const { roundToTick, floorStep, decimalsOf } = require('./num');

// curves: equal = all the same; linear = growing step by step; invlin = shrinking step by step; hyper = grows fast at the far
// end; inv = big at the near end; custom (sizes) / manual (distances) = set by hand with the sliders
const SHAPES = ['equal', 'linear', 'invlin', 'hyper', 'inv', 'custom', 'manual'];
const MAX_LEVELS = 12; // per ladder (2 ends + up to 10 in between)

/** n weights (n >= 1) of a curve. 'custom' is handled by the caller. */
function shapeWeights(n, shape) {
  const w = [];
  for (let i = 1; i <= n; i++) w.push(shape === 'linear' ? i : shape === 'invlin' ? n + 1 - i : shape === 'hyper' ? 1 / (n + 1 - i) : shape === 'inv' ? 1 / i : 1);
  return w;
}

/**
 * Distances of the levels: first = near, last = far, gaps between them in proportion to the curve.
 * 'manual': man = "25, 60" = the levels in between, each as % of the way from near to far (wrong count = equal gaps).
 */
function distances(near, far, n, shape, man) {
  if (n <= 1) return [near];
  if (shape === 'manual') {
    const p = parsePct(man);
    if (p.length === n - 2 && p.every((x, i) => x > 0 && x < 100 && (i === 0 || x > p[i - 1]))) return [near, ...p.map((x) => near + ((far - near) * x) / 100), far];
  }
  const g = shapeWeights(n - 1, shape === 'custom' || shape === 'manual' ? 'equal' : shape);
  const sum = g.reduce((a, b) => a + b, 0);
  const out = [near];
  let d = near;
  for (let i = 0; i < g.length; i++) {
    d += ((far - near) * g[i]) / sum;
    out.push(d);
  }
  out[n - 1] = far; // no rounding drift on the far end
  return out;
}

/** "30, 30, 40" or "30 30 40" -> [30, 30, 40] (comma, semicolon or spaces; decimals with a dot). */
function parsePct(text) {
  return String(text || '')
    .split(/[;,\s]+/)
    .map((x) => parseFloat(x))
    .filter((x) => Number.isFinite(x) && x >= 0);
}

/** Size of each level: total qty split by the weights, each part rounded down to the step, the last one takes the rest. */
function sizes(total, weights, step) {
  const sum = weights.reduce((a, b) => a + b, 0);
  const out = [];
  let used = 0;
  for (let i = 0; i < weights.length; i++) {
    const q = i === weights.length - 1 ? floorStep(total - used, step) : floorStep((total * weights[i]) / sum, step);
    out.push(Math.max(0, q));
    used += Math.max(0, q);
  }
  return out;
}

/**
 * No level left at size 0 when the total is enough (Gerry 2026-11-23: a level merged into the next made the first line drawn
 * level 2, with Nearest showing the distance of an invisible level): each level with a weight > 0 and size 0 gets one step,
 * taken from the biggest level. Only when the total is below one step per level a level stays at 0 (then merged).
 */
function fillMin(q, weights, step) {
  const out = q.slice();
  const dec = decimalsOf(step);
  for (let i = 0; i < out.length; i++) {
    if (out[i] > 0 || !(weights[i] > 0)) continue;
    let k = -1;
    for (let j = 0; j < out.length; j++) if (out[j] >= 2 * step - step / 2 && (k < 0 || out[j] > out[k])) k = j;
    if (k < 0) break; // not enough to give one step to every level
    out[k] = +(out[k] - step).toFixed(dec);
    out[i] = +step.toFixed(dec);
  }
  return out;
}

const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};

/**
 * Distances of a ladder with the levels moved by hand on the chart: ov = "d2, d3, ..." = the levels BETWEEN nearest and farthest
 * (as many as there are), each one a distance in points. Wrong count or empty = the curve. Sorted from near to far.
 */
function withOv(d, ov) {
  const o = parsePct(ov);
  if (d.length < 3 || o.length !== d.length - 2 || !o.every((x) => x > 0)) return d;
  return [d[0], ...o, d[d.length - 1]].sort((a, b) => a - b);
}

/**
 * One ladder. cfg = { near, far, mid (levels in between), dist (curve), size (curve), pct (% of the position, TP only), custom }
 * -> { legs: [{ n, kind, dist, price, qty, pct, usd, all }], why, warn: [] }
 * all = the farthest leg of a ladder that covers 100 % of the position is sent WITHOUT a quantity: it closes whatever is left
 * (also after the other legs or a DCA changed the size).
 */
function ladder(kind, cfg, pos, m) {
  const warn = [];
  if (cfg.off) return { legs: [], why: '', warn };
  const near = num(cfg.near),
    far0 = num(cfg.far);
  if (!(near > 0)) return { legs: [], why: `${kind.toUpperCase()}: set the nearest distance`, warn };
  const far = far0 > 0 ? far0 : near;
  if (far < near) return { legs: [], why: `${kind.toUpperCase()}: the farthest distance is below the nearest`, warn };
  const mid = Math.max(0, Math.min(MAX_LEVELS - 2, Math.floor(num(cfg.mid) || 0)));
  const n = far > near ? mid + 2 : 1; // near = far: a single level
  const pct = kind === 'tp' ? Math.min(100, Math.max(0, Number.isFinite(num(cfg.pct)) ? num(cfg.pct) : 100)) : 100;
  if (!(pct > 0)) return { legs: [], why: '', warn };
  const d = withOv(distances(near, far, n, cfg.dist, cfg.man), cfg.ov);
  let w;
  if (cfg.size === 'custom') {
    const c = parsePct(cfg.custom);
    if (c.length !== n) return { legs: [], why: `${kind.toUpperCase()}: ${n} levels but ${c.length} custom % (e.g. ${Array(n).fill(Math.floor(100 / n)).join(', ')})`, warn };
    const s = c.reduce((a, b) => a + b, 0);
    if (!(s > 0)) return { legs: [], why: `${kind.toUpperCase()}: custom % all zero`, warn };
    if (Math.abs(s - 100) > 0.01) warn.push(`${kind.toUpperCase()} custom % add up to ${+s.toFixed(2)}: used in proportion`);
    w = c;
  } else w = shapeWeights(n, cfg.size);
  const total = floorStep((pos.qty * pct) / 100, m.step);
  if (!(total > 0)) return { legs: [], why: `${kind.toUpperCase()}: ${pct}% of the position is below the minimum size`, warn };
  const q = fillMin(sizes(total, w, m.step), w, m.step);
  const sgn = (pos.side === 'long' ? 1 : -1) * (kind === 'tp' ? 1 : -1);
  // reference of the distances: TP from tpRef (first entry to fill / position average), SL from slRef (farthest entry), else the average
  const ref = (kind === 'tp' ? pos.tpRef : pos.slRef) > 0 ? (kind === 'tp' ? pos.tpRef : pos.slRef) : pos.openPrice;
  const wSum = w.reduce((a, b) => a + b, 0);
  if (q.some((x, i) => Math.abs(x / total - w[i] / wSum) > 0.05))
    warn.push(`${kind.toUpperCase()}: size too small to follow the shares (each level is a multiple of ${m.step}): ${q.map((x) => Math.round((x / total) * 100) + '%').join(' / ')} instead of ${w.map((x) => Math.round((x / wSum) * 100) + '%').join(' / ')}`);
  const legs = [];
  let carry = 0;
  for (let i = 0; i < n; i++) {
    const qi = q[i] + carry;
    if (!(qi > 0)) {
      carry = qi;
      warn.push(`${kind.toUpperCase()} level ${i + 1}: below the minimum size, merged with the next one`);
      continue;
    }
    carry = 0;
    const price = roundToTick(ref + sgn * d[i], m.tick);
    legs.push({ kind, i, of: n, dist: d[i], price, qty: +qi.toFixed(decimalsOf(m.step)), pct: (qi / pos.qty) * 100, usd: (pos.side === 'long' ? 1 : -1) * (price - pos.openPrice) * qi });
  }
  // the same price twice (distances closer than a tick): merged
  for (let i = legs.length - 1; i > 0; i--)
    if (Math.abs(legs[i].price - legs[i - 1].price) < m.tick / 2) {
      legs[i - 1].qty = +(legs[i - 1].qty + legs[i].qty).toFixed(decimalsOf(m.step));
      legs[i - 1].pct += legs[i].pct;
      legs[i - 1].usd += legs[i].usd;
      legs.splice(i, 1);
      warn.push(`${kind.toUpperCase()}: two levels on the same price, merged`);
    }
  legs.forEach((l, i) => {
    l.n = i + 1;
    l.all = i === legs.length - 1 && pct >= 100;
  });
  return { legs, why: '', warn };
}

/**
 * grid({ pos: { side, qty, openPrice }, m: { step, tick }, mark, tp: cfg, sl: cfg })
 * -> { tp: [...legs], sl: [...legs], why: [], warn: [] }. Legs on the wrong side of the current price get bad: reason.
 */
function grid({ pos, m, mark, tp, sl }) {
  if (!pos || !(pos.qty > 0) || !(pos.openPrice > 0)) return { tp: [], sl: [], why: ['no open position on this market'], warn: [] };
  if (!(m && m.step > 0 && m.tick > 0)) return { tp: [], sl: [], why: ['market data not read yet'], warn: [] };
  const a = ladder('tp', tp || {}, pos, m),
    b = ladder('sl', sl || {}, pos, m);
  const long = pos.side === 'long';
  const gap = 2 * m.tick;
  for (const l of [...a.legs, ...b.legs]) {
    const ok = l.kind === 'tp' ? (long ? l.price >= mark + gap : l.price <= mark - gap) : long ? l.price <= mark - gap : l.price >= mark + gap;
    if (mark > 0 && !ok) l.bad = `${l.kind === 'tp' ? 'target' : 'stop'} on the wrong side of the current price`;
  }
  return { tp: a.legs, sl: b.legs, why: [a.why, b.why].filter(Boolean), warn: [...a.warn, ...b.warn] };
}

/**
 * Entry grid: LIMIT orders from the current price outwards (LONG below, SHORT above). Gerry 2026-11-23.
 * entries({ side, mark, total (qty for the whole grid), m: { step, tick }, cfg: { near, far, mid, dist, size, custom } })
 * -> { legs: [{ n, kind: 'en', side, dist, price, qty, pct }], avg (average price if all fill), qty, why, warn }
 */
function entries({ side, mark, total, m, cfg }) {
  const warn = [];
  const out = (why) => ({ legs: [], avg: NaN, qty: 0, why, warn });
  if (side !== 'long' && side !== 'short') return out('ENTRIES: side?');
  if (!(mark > 0)) return out('ENTRIES: price not read yet');
  if (!(m && m.step > 0 && m.tick > 0)) return out('ENTRIES: market data not read yet');
  const near = num(cfg.near),
    far0 = num(cfg.far);
  if (!(near > 0)) return out('ENTRIES: set the nearest distance');
  const far = far0 > 0 ? far0 : near;
  if (far < near) return out('ENTRIES: the farthest distance is below the nearest');
  if (side === 'long' && !(mark - far > 0)) return out('ENTRIES: the farthest level is below zero');
  if (near < 2 * m.tick) return out('ENTRIES: the nearest level is less than 2 ticks from the price');
  const mid = Math.max(0, Math.min(MAX_LEVELS - 2, Math.floor(num(cfg.mid) || 0)));
  const n = far > near ? mid + 2 : 1;
  if (!(total > 0)) return out('ENTRIES: total size below the minimum size');
  const d = withOv(distances(near, far, n, cfg.dist, cfg.man), cfg.ov);
  let w;
  if (cfg.size === 'custom') {
    const c = parsePct(cfg.custom);
    if (c.length !== n) return out(`ENTRIES: ${n} levels but ${c.length} custom %`);
    if (!(c.reduce((a, b) => a + b, 0) > 0)) return out('ENTRIES: custom % all zero');
    w = c;
  } else w = shapeWeights(n, cfg.size);
  const q = fillMin(sizes(total, w, m.step), w, m.step);
  const sgn = side === 'long' ? -1 : 1;
  const legs = [];
  let carry = 0;
  for (let i = 0; i < n; i++) {
    const qi = q[i] + carry;
    if (!(qi > 0)) {
      carry = qi;
      warn.push(`ENTRY level ${i + 1}: below the minimum size, merged with the next one`);
      continue;
    }
    carry = 0;
    legs.push({ kind: 'en', i, of: n, side, dist: d[i], price: roundToTick(mark + sgn * d[i], m.tick, side === 'long' ? 'down' : 'up'), qty: +qi.toFixed(decimalsOf(m.step)) });
  }
  for (let i = legs.length - 1; i > 0; i--)
    if (Math.abs(legs[i].price - legs[i - 1].price) < m.tick / 2) {
      legs[i - 1].qty = +(legs[i - 1].qty + legs[i].qty).toFixed(decimalsOf(m.step));
      legs.splice(i, 1);
      warn.push('ENTRIES: two levels on the same price, merged');
    }
  const tq = legs.reduce((a, l) => a + l.qty, 0);
  legs.forEach((l, i) => {
    l.n = i + 1;
    l.pct = (l.qty / tq) * 100;
  });
  const avg = tq > 0 ? legs.reduce((a, l) => a + l.price * l.qty, 0) / tq : NaN;
  return { legs, avg, qty: +tq.toFixed(decimalsOf(m.step)), why: '', warn };
}

module.exports = { SHAPES, MAX_LEVELS, shapeWeights, distances, withOv, parsePct, sizes, fillMin, ladder, grid, entries };
