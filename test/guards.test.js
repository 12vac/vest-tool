const test = require('node:test');
const assert = require('node:assert');
const G = require('../src/domain/guards');

test('guards: values from risk and limits', () => {
  const v = G.values({ risk: { marginPos: 0.25, marginAll: 0.5 }, limits: { dayPl: -3, dayLeft: 10, maxLeft: 12, pl: 7 }, openLoss: 2, openProfit: 0 });
  assert.deepStrictEqual(v, { dg: -3, dl: 3, cp: 0, rk: 2, dd: 10, dm: 12, tg: 7 });
});

test('guards: up rows fire at or above, down rows at or below, level 0 never', () => {
  assert.ok(G.reached('rk', 80, 80));
  assert.ok(!G.reached('rk', 79.9, 80));
  assert.ok(!G.reached('m1', 99, 80)); // margins: bars only, never fire
  assert.ok(G.reached('dd', 3, 3));
  assert.ok(G.reached('dd', 2.5, 3));
  assert.ok(!G.reached('dd', 3.1, 3));
  assert.ok(!G.reached('dm', 0, 0));
  assert.ok(!G.reached('dg', NaN, 5));
});

test('guards: only rows switched ON fire', () => {
  const vals = { dg: 6, rk: 4, dd: 1, dm: 20, tg: 1 };
  const f = G.firing(vals, { rk: true, dd: false, dg: true }, { rk: 3, dd: 2, dg: 5, dm: 3 });
  assert.deepStrictEqual(f.map((x) => x.k), ['dg', 'rk']);
});

test('guards: caps, level in force, automatic target', () => {
  const c = G.caps({ risk: { used: 0, left: 13.61 }, limits: { dayLimit: 13.61, maxLimit: 10, goal: NaN } });
  assert.strictEqual(c.rk, 13.61);
  assert.strictEqual(c.dd, 13.61);
  assert.strictEqual(c.dm, 10);
  assert.ok(Number.isNaN(c.dg));
  assert.strictEqual(G.levelOf('dm', '30', c.dm), 0); // "$ left" at or above the limit: not set (it would fire at once)
  assert.strictEqual(G.levelOf('dm', '10', c.dm), 0);
  assert.strictEqual(G.levelOf('dm', '4', c.dm), 4);
  assert.ok(G.tooHigh('dd', '20', 13.61) && !G.tooHigh('dd', '5', 13.61) && !G.tooHigh('rk', '20', 13.61));
  assert.strictEqual(G.levelOf('dl', '30', c.dl), 13.61); // the others: capped
  assert.strictEqual(G.levelOf('dd', '3', c.dd), 3);
  assert.strictEqual(G.levelOf('dg', '5', c.dg), 5);
  assert.strictEqual(G.levelOf('tg', '', 500), 500); // empty: Vest target
  assert.strictEqual(G.levelOf('tg', '', NaN), 0);
  assert.strictEqual(G.levelOf('rk', '', c.rk), 0);
  assert.strictEqual(G.stepOf('rk', 13.61), 0.05);
});

test('guards: level text', () => {
  assert.strictEqual(G.levelText('rk', 80), 'FLAT ≥ $80.00');
  assert.strictEqual(G.levelText('dd', 3), 'FLAT ≤ $3.00');
  assert.strictEqual(G.levelText('tg', 0), 'no target: set one');
  assert.strictEqual(G.levelText('tg', 500, true), 'FLAT ≥ $500.00 (Vest target)');
});

test('guards: price where a $ row fires (USER line)', () => {
  const base = { dayPl: -2, upnl: 1, dayLeft: 11, maxLeft: 20, pl: 5 };
  const long = { side: 'long', qty: 0.5 },
    short = { side: 'short', qty: 0.5 };
  assert.strictEqual(G.priceOf('rk', 3, base, long, 100), 92); // upnl 1 -> -3: -4 $ / 0.5 = -8 pt
  assert.strictEqual(G.priceOf('rk', 3, base, short, 100), 108);
  assert.strictEqual(G.priceOf('cp', 4, base, long, 100), 106); // upnl 1 -> 4
  assert.strictEqual(G.priceOf('dl', 5, base, long, 100), 94); // dayPl -2 -> -5
  assert.strictEqual(G.priceOf('dg', 3, base, long, 100), 110); // dayPl -2 -> +3
  assert.strictEqual(G.priceOf('dd', 6, base, long, 100), 90); // left 11 -> 6
  assert.strictEqual(G.priceOf('tg', 10, base, long, 100), 110); // pl 5 -> 10
  assert.ok(Number.isNaN(G.priceOf('rk', 3, base, null, 100))); // no position: no line
  assert.ok(Number.isNaN(G.priceOf('rk', 300, base, long, 100))); // below 0: no line
});

test('guards: current profit range = what is missing to the account target', () => {
  const c = G.caps({ risk: { used: 0, left: 13.69 }, limits: { dayLimit: 13.69, maxLimit: 10, goal: 50, pl: 20 } });
  assert.strictEqual(c.cp, 30);
  assert.strictEqual(c.dl, 13.69);
  const c2 = G.caps({ risk: { used: 0, left: 13.69 }, limits: { dayLimit: 13.69, goal: NaN } });
  assert.strictEqual(c2.cp, 13.69); // no target: same range as the current loss
});
