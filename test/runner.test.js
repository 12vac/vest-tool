const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/domain/runner');
const TA = require('../src/domain/ta');

// 40 flat candles around 100 (ATR ~ 2), entry at the close of candle 39, then a run up
function bars(path) {
  const out = [];
  for (let i = 0; i < 40; i++) out.push({ t: i * 60, o: 100, h: 101, l: 99, c: 100 });
  let p = 100;
  path.forEach((c, j) => {
    const o = p;
    out.push({ t: (40 + j) * 60, o, h: Math.max(o, c) + 0.5, l: Math.min(o, c) - 0.5, c });
    p = c;
  });
  return out;
}
const cfg = { act: 5, lock: 1, tr: [{ r: null, m: 0.5 }, { r: 1, m: null }, { r: null, m: 0.5 }, { r: null, m: 3 }], w: [0.67, 0, 0, 0.33], htfGate: true, climaxAtr: 99 };

test('waits until the profit reaches act', () => {
  const r = R.evaluate({ side: 'long', entry: 100, bars: bars([101, 102]), iEntry: 39, cfg });
  assert.equal(r.active, false);
});

test('long: tight and runner stops, floor at entry + lock, runner tight without the 1h trend', () => {
  const B = bars([102, 104, 106, 108]);
  const off = R.evaluate({ side: 'long', entry: 100, bars: B, iEntry: 39, cfg, htf: { aligned: false } });
  const on = R.evaluate({ side: 'long', entry: 100, bars: B, iEntry: 39, cfg, htf: { aligned: true } });
  assert.equal(off.active, true);
  assert.ok(off.stops.t1 >= 101 && off.stops.t1 < 108.5);
  assert.equal(off.stops.run, off.stops.t1); // gated: runner like the tight tranche
  assert.ok(on.stops.run < on.stops.t1); // in favour: runner wider
  assert.ok(on.stops.run >= 101); // never below entry + lock
});

test('stops never move back', () => {
  const B = bars([102, 104, 106, 108]);
  const a = R.evaluate({ side: 'long', entry: 100, bars: B, iEntry: 39, cfg, htf: { aligned: true } });
  const B2 = B.concat([{ t: 44 * 60, o: 108, h: 108.2, l: 103, c: 104 }]); // pullback, bigger ATR
  const b = R.evaluate({ side: 'long', entry: 100, bars: B2, iEntry: 39, cfg, prev: a, htf: { aligned: true } });
  for (const k of R.KEYS) assert.ok(b.stops[k] >= a.stops[k] - 1e-9, k);
});

test('short is the mirror of long', () => {
  const B = bars([102, 104, 106, 108]);
  const M = B.map((b) => ({ t: b.t, o: 200 - b.o, h: 200 - b.l, l: 200 - b.h, c: 200 - b.c }));
  const L = R.evaluate({ side: 'long', entry: 100, bars: B, iEntry: 39, cfg, htf: { aligned: true } });
  const S = R.evaluate({ side: 'short', entry: 100, bars: M, iEntry: 39, cfg, htf: { aligned: true } });
  for (const k of R.KEYS) assert.ok(Math.abs(S.stops[k] - (200 - L.stops[k])) < 1e-6, k);
});

test('split: tranches on the size step, the rest to the runner', () => {
  assert.deepEqual(R.split(0.003, [0.67, 0, 0, 0.33], 0.0001), { t1: 0.002, t2: 0, t3: 0, run: 0.001 });
  const q = R.split(1, [0.5, 0.25, 0, 0.25], 1);
  assert.equal(q.t1 + q.t2 + q.t3 + q.run, 1);
});

test('ta: ATR and aggregate', () => {
  const B = bars([]);
  assert.ok(Math.abs(TA.atrSeries(B, 14)[39] - 2) < 1e-9);
  assert.equal(TA.aggregate(B, 300).length, 8);
});

test('activation candle: a tranche stop already past the close is measured from the close (no exit at once)', () => {
  // run to 108.5, the activation candle closes back at 104: tight stop from the top (~107.5) would be above the close
  const B = bars([102, 104, 106]).concat([{ t: 43 * 60, o: 106, h: 108.5, l: 103.5, c: 104 }]);
  const r = R.evaluate({ side: 'long', entry: 100, bars: B, iEntry: 39, cfg, htf: { aligned: true } });
  assert.equal(r.active, true);
  for (const k of R.KEYS) assert.ok(r.stops[k] < 104, k + ' ' + r.stops[k]);
  const old = R.evaluate({ side: 'long', entry: 100, bars: B, iEntry: 39, cfg: { ...cfg, waitAtStart: false }, htf: { aligned: true } });
  assert.ok(old.stops.t1 >= 104); // the old behaviour: out at once
});

test('realtime: the live price starts the engine and moves the stops before the candle closes', () => {
  const B = bars([101, 102]); // closed candles: best 102.5, below act 5
  assert.equal(R.evaluate({ side: 'long', entry: 100, bars: B, iEntry: 39, cfg, htf: { aligned: true } }).active, false);
  const a = R.evaluate({ side: 'long', entry: 100, bars: B, iEntry: 39, mark: 106, cfg, htf: { aligned: true } });
  assert.equal(a.active, true);
  assert.equal(a.best, 106);
  for (const k of R.KEYS) assert.ok(a.stops[k] < 106, k); // measured from the live price at the start: nothing out at once
  const b = R.evaluate({ side: 'long', entry: 100, bars: B, iEntry: 39, mark: 108, prev: a, cfg, htf: { aligned: true } });
  assert.ok(b.stops.t1 > a.stops.t1); // same candles, higher price: tight stop forward
  const c = R.evaluate({ side: 'long', entry: 100, bars: B, iEntry: 39, mark: 104, prev: b, cfg, htf: { aligned: true } });
  assert.equal(c.best, 108); // the best is kept
  for (const k of R.KEYS) assert.ok(c.stops[k] >= b.stops[k] - 1e-9, k); // never back
  const s = R.evaluate({ side: 'short', entry: 100, bars: B.map((x) => ({ t: x.t, o: 200 - x.o, h: 200 - x.l, l: 200 - x.h, c: 200 - x.c })), iEntry: 39, mark: 94, cfg, htf: { aligned: true } });
  assert.equal(s.active, true);
  for (const k of R.KEYS) assert.ok(s.stops[k] > 94, k);
});
