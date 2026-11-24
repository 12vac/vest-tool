// Technical analysis helpers for the safe runner. PURE. Bars = [{ t (s), o, h, l, c }] ascending.

/** Wilder ATR series (same length as bars; NaN until n bars). */
function atrSeries(bars, n = 14) {
  const out = new Array(bars.length).fill(NaN);
  let a = NaN;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i],
      pc = i ? bars[i - 1].c : b.c;
    const tr = Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
    if (i < n) {
      a = i === 0 ? tr : (a * i + tr) / (i + 1);
      if (i === n - 1) out[i] = a;
    } else {
      a = (a * (n - 1) + tr) / n;
      out[i] = a;
    }
  }
  return out;
}

/** EMA series of the closes. */
function emaSeries(bars, n) {
  const k = 2 / (n + 1),
    out = new Array(bars.length);
  let e = NaN;
  for (let i = 0; i < bars.length; i++) {
    e = i === 0 ? bars[i].c : bars[i].c * k + e * (1 - k);
    out[i] = i >= n - 1 ? e : NaN;
  }
  return out;
}

/** Slow stochastic %K (n, smoothed by s) series, 0..100. */
function stochSeries(bars, n = 14, s = 3) {
  const raw = bars.map((b, i) => {
    if (i < n - 1) return NaN;
    let hh = -Infinity,
      ll = Infinity;
    for (let j = i - n + 1; j <= i; j++) {
      if (bars[j].h > hh) hh = bars[j].h;
      if (bars[j].l < ll) ll = bars[j].l;
    }
    return hh > ll ? (100 * (b.c - ll)) / (hh - ll) : 50;
  });
  return raw.map((v, i) => {
    if (i < n - 1 + s - 1) return NaN;
    let t = 0;
    for (let j = i - s + 1; j <= i; j++) t += raw[j];
    return t / s;
  });
}

/** Candles of tfSec seconds built from shorter ones (buckets aligned from 00:00 UTC). The last one may be partial. */
function aggregate(bars, tfSec) {
  const out = [];
  for (const b of bars) {
    const t = Math.floor(b.t / tfSec) * tfSec;
    const cur = out[out.length - 1];
    if (cur && cur.t === t) {
      if (b.h > cur.h) cur.h = b.h;
      if (b.l < cur.l) cur.l = b.l;
      cur.c = b.c;
    } else out.push({ t, o: b.o, h: b.h, l: b.l, c: b.c });
  }
  return out;
}

/** Kaufman efficiency ratio of the closes in [i0, i1]: 1 = straight line, 0 = pure noise. */
function efficiency(bars, i0, i1) {
  if (i1 <= i0) return 0;
  let path = 0;
  for (let i = i0 + 1; i <= i1; i++) path += Math.abs(bars[i].c - bars[i - 1].c);
  return path > 0 ? Math.abs(bars[i1].c - bars[i0].c) / path : 0;
}

/** Mirror of a bar for shorts: prices negated, high / low swapped (the engine then reasons as a long). */
const mirrorBar = (b) => ({ t: b.t, o: -b.o, h: -b.l, l: -b.h, c: -b.c });

module.exports = { atrSeries, emaSeries, stochSeries, aggregate, efficiency, mirrorBar };
