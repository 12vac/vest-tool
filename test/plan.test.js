const test = require('node:test');
const assert = require('node:assert');
const { plan, stopPrice, weights, splitQty, entryLegs } = require('../src/domain/plan');

const base = {
  side: 'long', entry: 100, step: 0.01, tick: 0.5, maxQty: 100, capPct: 50, fee: 0.001,
  sizeBy: 'risk', sizeVal: 10, fees: false, stopBy: 'dist', stopVal: 2, targets: [{ on: true, by: 'r', val: 1 }], split: 'even',
};

test('plan: size = risk / stop distance, SL and target on the right side', () => {
  const p = plan(base);
  assert.strictEqual(p.qty, 5);
  assert.strictEqual(p.sl, 98);
  assert.strictEqual(p.riskUsd, 10);
  assert.deepStrictEqual(p.targets.map((t) => [t.n, t.price, t.qty]), [[1, 102, 5]]);
  const s = plan({ ...base, side: 'short', targets: [{ on: true, by: 'r', val: 2 }] });
  assert.strictEqual(s.sl, 102);
  assert.strictEqual(s.targets[0].price, 96);
  assert.strictEqual(s.targets[0].reward, 20);
});

test('plan: with fees the size is smaller and the risk counts entry + exit fee', () => {
  const p = plan({ ...base, fees: true }); // loss per unit 2 + 0.001 x (100 + 98) = 2.198
  assert.strictEqual(p.qty, 4.54);
  assert.ok(Math.abs(p.riskUsd - 4.54 * 2.198) < 1e-9);
});

test('plan: size as % of the maximum or fixed quantity, never above the cap', () => {
  assert.strictEqual(plan({ ...base, sizeBy: 'pct', sizeVal: 5 }).qty, 5);
  assert.strictEqual(plan({ ...base, sizeBy: 'qty', sizeVal: 3.456 }).qty, 3.45);
  const c = plan({ ...base, sizeVal: 1000, capPct: 10 }); // 500 wanted, cap 10% of 100 = 10
  assert.strictEqual(c.qty, 10);
  assert.strictEqual(c.capped, true);
});

test('stop rules: price distance, ticks, last candle low/high ± ticks, ATR multiple', () => {
  const s = { side: 'long', entry: 100, tick: 0.5 };
  assert.strictEqual(stopPrice({ ...s, by: 'dist', val: 1.2 }).sl, 99); // 98.8 rounded to the tick
  assert.strictEqual(stopPrice({ ...s, by: 'ticks', val: 4 }).sl, 98);
  assert.strictEqual(stopPrice({ ...s, by: 'bar', val: 2, bar: { h: 101, l: 99 } }).sl, 98);
  assert.strictEqual(stopPrice({ ...s, side: 'short', by: 'bar', val: 0, bar: { h: 101, l: 99 } }).sl, 101);
  assert.match(stopPrice({ ...s, by: 'bar', val: 0, bar: { h: 102, l: 100.5 } }).why, /low is above/);
  assert.strictEqual(stopPrice({ ...s, by: 'atr', val: 1.5, atr: 2 }).sl, 97);
  assert.match(stopPrice({ ...s, by: 'atr', val: 1.5, atr: NaN }).why, /ATR/);
});

test('plan: missing inputs give a reason and no size', () => {
  assert.match(plan({ ...base, sizeVal: 0 }).why, /risk/);
  assert.match(plan({ ...base, stopVal: '' }).why, /stop value/);
  assert.match(plan({ ...base, entry: NaN }).why, /price/);
  assert.match(plan({ ...base, sizeVal: 0.001 }).why, /minimum/);
});

test('targets: types, split even / front / back, trailing part without TP', () => {
  assert.deepStrictEqual(weights(3, 'front'), [3, 2, 1]);
  assert.deepStrictEqual(weights(3, 'back'), [1, 2, 3]);
  assert.deepStrictEqual(splitQty(1, [1, 1, 1], 0.01), [0.33, 0.33, 0.34]);
  const t4 = [{ on: true, by: 'r', val: 1 }, { on: true, by: 'ticks', val: 8 }, { on: true, by: 'dist', val: 6 }, { on: true, by: 'trail' }];
  const p = plan({ ...base, sizeVal: 20, targets: t4, split: 'front' }); // size 10: 4/3/2/1
  assert.deepStrictEqual(p.targets.map((t) => t.qty), [4, 3, 2, 1]);
  assert.deepStrictEqual(p.targets.slice(0, 3).map((t) => t.price), [102, 104, 106]);
  assert.ok(Number.isNaN(p.targets[3].price)); // trailing: no TP price
  const a = plan({ ...base, atr: 3, targets: [{ on: true, by: 'atr', val: 2 }] });
  assert.strictEqual(a.targets[0].price, 106);
  assert.match(plan({ ...base, sizeVal: 0.04, targets: t4 }).why, /split/); // size 0.02: not enough for 4 targets
});

test('bars: last closed candle and ATR of the chart timeframe', () => {
  const { lastClosed, atrClosed } = require('../src/chart/bars');
  const b = [{ h: 10, l: 8, c: 9 }, { h: 11, l: 9, c: 10 }, { h: 12, l: 10, c: 11 }, { h: 99, l: 1, c: 50 }]; // last = forming
  assert.deepStrictEqual(lastClosed(b), { h: 12, l: 10 });
  assert.strictEqual(atrClosed(b, 2), 2);
  assert.ok(Number.isNaN(atrClosed(b, 3)));
});

test('entry legs: one whole TP and SL without size, partial TPs with size, trailing part only under the stop', () => {
  const g = { qty: 1, sl: 98, step: 0.01, tick: 0.25 };
  assert.deepStrictEqual(entryLegs({ ...g, targets: [{ price: 102, qty: 1 }] }), {
    takeProfits: [{ executionType: 'market', triggerPrice: '102.00' }],
    stopLosses: [{ executionType: 'market', triggerPrice: '98.00' }],
  });
  const p = entryLegs({ ...g, targets: [{ price: 102, qty: 0.5 }, { price: 104, qty: 0.3 }, { price: NaN, qty: 0.2 }] });
  assert.deepStrictEqual(p.takeProfits.map((l) => [l.triggerPrice, l.quantity]), [['102.00', '0.50'], ['104.00', '0.30']]);
  assert.deepStrictEqual(p.stopLosses, [{ executionType: 'market', triggerPrice: '98.00' }]);
  const e = entryLegs({ ...g, each: true, targets: [{ price: 102, qty: 0.6 }, { price: 104, qty: 0.4 }] });
  assert.deepStrictEqual(e.stopLosses.map((l) => l.quantity), ['0.60', '0.40']);
  assert.match(entryLegs({ ...g, targets: [{ price: 102, qty: 0 }] }).why, /too small/);
  assert.match(entryLegs({ ...g, sl: NaN, targets: [] }).why, /stop/);
});
