const test = require('node:test');
const assert = require('node:assert');
const { follow } = require('../src/domain/bracket');

const L = (id, kind, price) => ({ id, kind, price, qty: null });

test('bracket follow: long add lowers the average -> SL and TP move to the same distances', () => {
  const r = follow({ side: 'long', avg: 19990.13, oldAvg: 20000, sl: 25, tp: 40, legs: [L('s', 'sl', 19975), L('t', 'tp', 20040)], tick: 0.25 });
  assert.deepStrictEqual(r.moves.map((m) => [m.kind, m.leg.id, m.price]), [['sl', 's', 19965], ['tp', 't', 20030.25]]);
});

test('bracket follow: short, SL above, TP below; missing TP added only with a distance', () => {
  const r = follow({ side: 'short', avg: 20010, oldAvg: 20000, sl: 25, tp: NaN, legs: [L('s', 'sl', 20025)], tick: 0.25 });
  assert.deepStrictEqual(r.moves.map((m) => [m.kind, m.price]), [['sl', 20035]]);
  const r2 = follow({ side: 'short', avg: 20010, oldAvg: 20000, sl: 25, tp: 30, legs: [], tick: 0.25 });
  assert.deepStrictEqual(r2.moves.map((m) => [m.kind, m.leg, m.price]), [['sl', null, 20035], ['tp', null, 19980]]);
});

test('bracket follow: SL at breakeven / in profit of the old entry stays; several legs stay', () => {
  const r = follow({ side: 'long', avg: 19990, oldAvg: 20000, sl: 25, tp: 40, legs: [L('s', 'sl', 20001), L('a', 'tp', 20030), L('b', 'tp', 20060)], tick: 0.25 });
  assert.strictEqual(r.moves.length, 0);
  assert.strictEqual(r.skip.length, 2);
});

test('AVG ALL: SL beyond the farthest LIMIT when avg - SL reaches it (Gerry 2026-11-23, option 3)', () => {
  // Gerry's picture: LIMITs 26467 and 26255.75, AVG ALL 26361.38, SL 80 TP 100
  const r = follow({ side: 'long', avg: 26361.375, oldAvg: 26467, sl: 80, tp: 100, legs: [L('s', 'sl', 26387), L('t', 'tp', 26567)], tick: 0.25, far: 26255.75 });
  assert.deepEqual(r.moves.map((m) => [m.kind, m.price]), [['sl', 26175.75], ['tp', 26461.5]]);
  // LIMIT close to the average: the SL stays at AVG ALL - 80
  const r2 = follow({ side: 'long', avg: 20000, oldAvg: 20010, sl: 80, tp: NaN, legs: [L('s', 'sl', 19930)], tick: 0.25, far: 19990 });
  assert.deepEqual(r2.moves.map((m) => [m.kind, m.price]), [['sl', 19920]]);
  // short side
  const r3 = follow({ side: 'short', avg: 20050, oldAvg: 20000, sl: 80, tp: NaN, legs: [], tick: 0.25, far: 20140 });
  assert.deepEqual(r3.moves.map((m) => [m.kind, m.price]), [['sl', 20220]]);
});
