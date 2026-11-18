const test = require('node:test');
const assert = require('node:assert/strict');
const { pnlUsd, priceForUsd, tickValueUsd } = require('../src/domain/money');
const { roundToTick, floorStep, decimalsOf } = require('../src/domain/num');

test('grid: tick and step', () => {
  assert.equal(decimalsOf(0.25), 2);
  assert.equal(decimalsOf(0.0001), 4);
  assert.equal(decimalsOf(1e-7), 7);
  assert.equal(roundToTick(21000.13, 0.25), 21000.25);
  assert.equal(roundToTick(21000.01, 0.25, 'up'), 21000.25);
  assert.equal(roundToTick(21000.24, 0.25, 'down'), 21000);
  assert.equal(roundToTick(21000.25, 0.25, 'up'), 21000.25); // already on the tick: stays
  assert.equal(floorStep(0.12349, 0.0001), 0.1234);
  assert.equal(floorStep(0.3, 0.1), 0.3); // no 0.29999
});

test('P&L in dollars, linear', () => {
  assert.equal(pnlUsd('long', 2, 20000, 20010), 20);
  assert.equal(pnlUsd('short', 2, 20000, 20010), -20);
  assert.equal(tickValueUsd(2, 0.25), 0.5);
});

test('$100 long SL with 2 units: 50 points below', () => {
  const r = priceForUsd({ kind: 'sl', side: 'long', qty: 2, entry: 20000, usd: 100, tick: 0.25 });
  assert.equal(r.price, 19950);
  assert.equal(r.usd, -100);
});

test('SL: risk never above the amount (rounds toward the entry)', () => {
  // 100 / 3 = 33.333 points -> long: 19966.667 -> up to 19966.75 -> risk 99.75
  const l = priceForUsd({ kind: 'sl', side: 'long', qty: 3, entry: 20000, usd: 100, tick: 0.25 });
  assert.equal(l.price, 19966.75);
  assert.ok(-l.usd <= 100 && -l.usd > 99);
  const s = priceForUsd({ kind: 'sl', side: 'short', qty: 3, entry: 20000, usd: 100, tick: 0.25 });
  assert.equal(s.price, 20033.25);
  assert.ok(-s.usd <= 100);
});

test('TP: nearest tick, on the right side', () => {
  const l = priceForUsd({ kind: 'tp', side: 'long', qty: 3, entry: 20000, usd: 100, tick: 0.25 });
  assert.equal(l.price, 20033.25);
  const s = priceForUsd({ kind: 'tp', side: 'short', qty: 3, entry: 20000, usd: 100, tick: 0.25 });
  assert.equal(s.price, 19966.75);
  assert.ok(s.usd > 0);
});

test('amounts below one tick or invalid input: error, never a made-up price', () => {
  assert.throws(() => priceForUsd({ kind: 'sl', side: 'long', qty: 0.01, entry: 20000, usd: 0.001, tick: 0.25 }));
  assert.throws(() => priceForUsd({ kind: 'sl', side: 'long', qty: 0, entry: 20000, usd: 100, tick: 0.25 }));
  assert.throws(() => priceForUsd({ kind: 'sl', side: 'long', qty: 1, entry: 20000, usd: -5, tick: 0.25 }));
  assert.throws(() => priceForUsd({ kind: 'sl', side: 'flat', qty: 1, entry: 20000, usd: 5, tick: 0.25 }));
  assert.throws(() => priceForUsd({ kind: 'sl', side: 'long', qty: 1, entry: 50, usd: 100, tick: 0.25 })); // price <= 0
});
