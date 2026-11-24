const test = require('node:test');
const assert = require('node:assert');
const G = require('../src/domain/grid');

const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} vs ${b}`);

test('grid: curves', () => {
  assert.deepStrictEqual(G.shapeWeights(3, 'equal'), [1, 1, 1]);
  assert.deepStrictEqual(G.shapeWeights(3, 'linear'), [1, 2, 3]);
  assert.deepStrictEqual(G.shapeWeights(3, 'hyper'), [1 / 3, 1 / 2, 1]); // grows fast at the far end
  assert.deepStrictEqual(G.shapeWeights(3, 'inv'), [1, 1 / 2, 1 / 3]); // big at the near end
});

test('grid: distances from near to far', () => {
  assert.deepStrictEqual(G.distances(10, 40, 4, 'equal'), [10, 20, 30, 40]);
  const l = G.distances(10, 70, 4, 'linear'); // gaps 1:2:3 of 60 -> 10, 20, 30
  [10, 20, 40, 70].forEach((v, i) => near(l[i], v));
  const h = G.distances(0, 100, 4, 'hyper');
  assert.ok(h[1] - h[0] < h[3] - h[2]); // accelerates at the far end
  const v = G.distances(0, 100, 4, 'inv');
  assert.ok(v[1] - v[0] > v[3] - v[2]); // accelerates at the near end
  assert.deepStrictEqual(G.distances(25, 25, 1, 'linear'), [25]);
});

test('grid: custom % and sizes', () => {
  assert.deepStrictEqual(G.parsePct('30, 30, 40'), [30, 30, 40]);
  assert.deepStrictEqual(G.parsePct('50 25;25'), [50, 25, 25]);
  assert.deepStrictEqual(G.sizes(1, [1, 1, 1], 0.01), [0.33, 0.33, 0.34]);
});

const pos = { side: 'long', qty: 0.03, openPrice: 20000 };
const m = { step: 0.001, tick: 0.25 };

test('grid: long, TP and SL ladders', () => {
  const g = G.grid({ pos, m, mark: 20005, tp: { near: 20, far: 60, mid: 1, dist: 'equal', size: 'equal', pct: 100 }, sl: { near: 30, far: 60, mid: 0, dist: 'equal', size: 'inv' } });
  assert.deepStrictEqual(g.why, []);
  assert.deepStrictEqual(g.tp.map((l) => l.price), [20020, 20040, 20060]);
  assert.deepStrictEqual(g.tp.map((l) => l.qty), [0.01, 0.01, 0.01]);
  assert.deepStrictEqual(g.tp.map((l) => l.all), [false, false, true]); // the farthest closes whatever is left
  assert.deepStrictEqual(g.sl.map((l) => l.price), [19970, 19940]);
  assert.deepStrictEqual(g.sl.map((l) => l.qty), [0.02, 0.01]); // inv: more on the nearest stop
  near(g.tp[0].usd, 0.2);
  assert.ok(g.sl[0].usd < 0);
});

test('grid: short mirrors, partial TP share, wrong side marked', () => {
  const g = G.grid({ pos: { side: 'short', qty: 1, openPrice: 100 }, m: { step: 0.1, tick: 0.5 }, mark: 101, tp: { near: 2, far: 4, mid: 0, dist: 'equal', size: 'equal', pct: 50 }, sl: { near: 0.5, far: 0.5, mid: 0 } });
  assert.deepStrictEqual(g.tp.map((l) => l.price), [98, 96]);
  assert.deepStrictEqual(g.tp.map((l) => l.qty), [0.2, 0.3]);
  assert.ok(!g.tp[1].all); // 50 %: no leg covers the rest
  assert.deepStrictEqual(g.sl.map((l) => l.price), [100.5]);
  assert.ok(g.sl[0].bad); // price already above the short's stop
});

test('grid: below the minimum size merged, errors', () => {
  const g = G.grid({ pos: { side: 'long', qty: 0.002, openPrice: 100 }, m: { step: 0.001, tick: 0.01 }, mark: 100, tp: { near: 1, far: 3, mid: 1, size: 'equal' }, sl: { near: 1 } });
  assert.strictEqual(g.tp.reduce((s, l) => s + l.qty, 0), 0.002);
  assert.ok(g.warn.some((w) => /merged/.test(w)));
  assert.ok(G.grid({ pos, m, mark: 1, tp: { near: 50, far: 10 }, sl: { near: 5 } }).why[0].includes('below the nearest'));
  assert.ok(G.grid({ pos, m, mark: 1, tp: { near: 10, far: 30, mid: 1, size: 'custom', custom: '50, 50' }, sl: { near: 5 } }).why[0].includes('3 levels but 2'));
  assert.deepStrictEqual(G.grid({ pos: null, m, mark: 1 }).why, ['no open position on this market']);
});

test('grid: entry limits', () => {
  const e = G.entries({ side: 'long', mark: 20000, total: 0.03, m: { step: 0.001, tick: 0.25 }, cfg: { near: 10, far: 50, mid: 1, dist: 'equal', size: 'linear' } });
  assert.strictEqual(e.why, '');
  assert.deepStrictEqual(e.legs.map((l) => l.price), [19990, 19970, 19950]);
  assert.deepStrictEqual(e.legs.map((l) => l.qty), [0.005, 0.01, 0.015]); // linear: more on the farthest
  near(e.avg, (19990 * 0.005 + 19970 * 0.01 + 19950 * 0.015) / 0.03);
  const s = G.entries({ side: 'short', mark: 100, total: 1, m: { step: 0.1, tick: 0.5 }, cfg: { near: 1, far: 3, mid: 0, size: 'custom', custom: '70 30' } });
  assert.deepStrictEqual(s.legs.map((l) => [l.price, l.qty]), [[101, 0.7], [103, 0.3]]);
  assert.ok(G.entries({ side: 'long', mark: 100, total: 1, m: { step: 0.1, tick: 0.5 }, cfg: { near: 0.5 } }).why.includes('2 ticks'));
});

test('grid: levels moved by hand, ladder off', () => {
  assert.deepStrictEqual(G.withOv([10, 20, 30, 40], '35, 12'), [10, 12, 35, 40]);
  assert.deepStrictEqual(G.withOv([10, 20, 30, 40], '35'), [10, 20, 30, 40]); // wrong count: the curve
  const g = G.grid({ pos, m, mark: 20005, tp: { near: 20, far: 60, mid: 1, ov: '30', size: 'equal' }, sl: { off: true } });
  assert.deepStrictEqual(g.tp.map((l) => l.price), [20020, 20030, 20060]);
  assert.deepStrictEqual(g.tp.map((l) => [l.i, l.of]), [[0, 3], [1, 3], [2, 3]]);
  assert.deepStrictEqual(g.sl, []);
  assert.deepStrictEqual(g.why, []);
});

test('grid: inverse linear, manual distances', () => {
  assert.deepStrictEqual(G.shapeWeights(3, 'invlin'), [3, 2, 1]);
  assert.deepStrictEqual(G.distances(10, 50, 4, 'manual', '25, 50'), [10, 20, 30, 50]);
  assert.deepStrictEqual(G.distances(10, 40, 4, 'manual', '60, 20'), [10, 20, 30, 40]); // not increasing: equal gaps
  const g = G.grid({ pos, m, mark: 20005, tp: { near: 20, far: 60, mid: 1, dist: 'manual', man: '75', size: 'custom', custom: '50, 25, 25' }, sl: { off: true } });
  assert.deepStrictEqual(g.tp.map((l) => l.price), [20020, 20050, 20060]);
  assert.deepStrictEqual(g.tp.map((l) => l.qty), [0.015, 0.007, 0.008]);
});

test('grid: TP from the first entry, SL beyond the farthest entry', () => {
  const g = G.grid({ pos: { side: 'long', qty: 0.03, openPrice: 19950, tpRef: 20000, slRef: 19900 }, m, mark: 20010, tp: { near: 20 }, sl: { near: 30 } });
  assert.deepStrictEqual(g.tp.map((l) => l.price), [20020]);
  assert.deepStrictEqual(g.sl.map((l) => l.price), [19870]);
  const r = G.grid({ pos: { side: 'long', qty: 0.0009, openPrice: 100 }, m: { step: 0.0001, tick: 0.5 }, mark: 100, tp: { near: 1, far: 3, mid: 1, size: 'custom', custom: '10, 10, 80' }, sl: { off: true } });
  // v0.20.63: the two small levels get one step each instead of being merged into the last one
  assert.deepStrictEqual(r.tp.map((l) => l.qty), [0.0001, 0.0001, 0.0007]);
});

test('fillMin: no level at size 0 when the total allows one step each (Gerry 2026-11-23, BUY1 was level 2)', () => {
  const { sizes, fillMin, shapeWeights, entries } = require('../src/domain/grid');
  const w = shapeWeights(5, 'linear');
  assert.deepEqual(fillMin(sizes(0.0009, w, 0.0001), w, 0.0001), [0.0001, 0.0001, 0.0001, 0.0002, 0.0004]);
  // Gerry's grid: price 26713.87, nearest 72.63, farthest 288.62, 3 between, linear sizes, total 0.0009
  const r = entries({ side: 'long', mark: 26713.87, total: 0.0009, m: { step: 0.0001, tick: 0.25 }, cfg: { near: 72.63, far: 288.62, mid: 3, dist: 'equal', size: 'linear' } });
  assert.equal(r.legs.length, 5);
  assert.equal(r.legs[0].i, 0);
  assert.equal(r.legs[4].i, 4);
  // below one step per level: still merged
  assert.deepEqual(fillMin([0, 0, 0.0002], [1, 2, 3], 0.0001), [0.0001, 0, 0.0001]);
});
