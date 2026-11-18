const test = require('node:test');
const assert = require('node:assert/strict');
const { toPts, trailStep, autoBe } = require('../src/domain/trail');
const { breakevenPlan, breakevenPrice } = require('../src/domain/orders');

const L = { side: 'long', qty: 2, entry: 20000, tick: 0.25, act: 20, dist: 15, step: 2, unit: 'pt' };

test('toPts: points, and dollars divided by the size', () => {
  assert.equal(toPts(10, 'pt', 3), 10);
  assert.equal(toPts(30, '$', 3), 10);
  assert.ok(Number.isNaN(toPts('', 'pt', 1)));
  assert.ok(Number.isNaN(toPts(10, '$', 0)));
});

test('trailing: does not start before the threshold', () => {
  const r = trailStep({ ...L, mark: 20019, best: null, active: false, sl: null });
  assert.equal(r.active, false);
  assert.equal(r.action, undefined);
  assert.equal(r.best, 20019);
});

test('trailing: starts at the threshold and puts the stop at dist from the best', () => {
  const r = trailStep({ ...L, mark: 20020, best: 20010, active: false, sl: null });
  assert.equal(r.active, true);
  assert.deepEqual(r.action, { type: 'sl', price: 20005 });
});

test('trailing: moves forward only and by at least one step', () => {
  assert.equal(trailStep({ ...L, mark: 20021, best: 20020, active: true, sl: 20005 }).action, undefined); // +1 < step 2
  assert.deepEqual(trailStep({ ...L, mark: 20022, best: 20020, active: true, sl: 20005 }).action, { type: 'sl', price: 20007 });
  // the price comes back: the best stays, the stop does not widen
  const r = trailStep({ ...L, mark: 20010, best: 20030, active: true, sl: 20015 });
  assert.equal(r.best, 20030);
  assert.equal(r.action, undefined);
});

test('trailing: a stop ahead of the level is not touched', () => {
  assert.equal(trailStep({ ...L, mark: 20030, best: 20030, active: true, sl: 20020 }).action, undefined);
});

test('trailing: price beyond the level without a stop -> close', () => {
  const r = trailStep({ ...L, mark: 20004, best: 20025, active: true, sl: null });
  assert.equal(r.level, 20010);
  assert.deepEqual(r.action, { type: 'close' });
  // stop behind by less than one step: no close, the native stop triggers
  assert.equal(trailStep({ ...L, mark: 20006, best: 20031, active: true, sl: 20015 }).action, undefined);
  // stop behind by one step or more (move rejected): closes
  assert.deepEqual(trailStep({ ...L, mark: 20006, best: 20031, active: true, sl: 20014 }).action, { type: 'close' });
});

test('trailing: profit only (retracement > start: no stop below the entry)', () => {
  // start 20, retracement 30: at +20 the level would be 19990, at a loss
  const r = trailStep({ ...L, dist: 30, mark: 20020, best: null, active: false, sl: null });
  assert.equal(r.active, true);
  assert.equal(r.waitProfit, true);
  assert.equal(r.action, undefined);
  // price back below the losing level: no close
  assert.equal(trailStep({ ...L, dist: 30, mark: 19985, best: 20020, active: true, sl: null }).action, undefined);
  // level exactly at the entry: not a profit
  assert.equal(trailStep({ ...L, dist: 30, mark: 20030, best: 20030, active: true, sl: null }).action, undefined);
  // at +32 the level is 20002: stop
  assert.deepEqual(trailStep({ ...L, dist: 30, mark: 20032, best: 20032, active: true, sl: null }).action, { type: 'sl', price: 20002 });
  // short: level above the entry = loss
  assert.equal(trailStep({ ...L, side: 'short', dist: 30, mark: 19980, best: 19980, active: true, sl: null }).action, undefined);
});

test('trailing: no close if the current price is not in profit (short DCA, real account)', () => {
  // short: best 19950 with the old entry; after the DCA entry 20040, price 20045 (at a loss), level 19965 in "profit" but the price is not
  const r = trailStep({ ...L, side: 'short', entry: 20040, dist: 15, mark: 20045, best: 19950, active: true, sl: null });
  assert.equal(r.action, undefined);
  // price still in profit but beyond the level: closes
  assert.deepEqual(trailStep({ ...L, side: 'short', entry: 20040, dist: 15, mark: 19970, best: 19950, active: true, sl: null }).action, { type: 'close' });
});

test('trailing: too close to the price (2 ticks) -> waits', () => {
  assert.equal(trailStep({ ...L, dist: 0.25, act: 0, mark: 20020, best: 20020, active: true, sl: null }).action, undefined);
});

test('trailing short in dollars', () => {
  // 2 contracts: $40 = 20 pt start, $30 = 15 pt retracement
  const S = { side: 'short', qty: 2, entry: 20000, tick: 0.25, act: 40, dist: 30, step: 4, unit: '$' };
  assert.equal(trailStep({ ...S, mark: 19981, best: null, active: false, sl: null }).active, false);
  assert.deepEqual(trailStep({ ...S, mark: 19980, best: null, active: false, sl: null }).action, { type: 'sl', price: 19995 });
  assert.deepEqual(trailStep({ ...S, mark: 19990.5, best: 19975, active: true, sl: null }).action, { type: 'close' });
});

test('trailing: retracement rounded away from the price (never less than dist)', () => {
  const r = trailStep({ ...L, dist: 15.1, mark: 20030, best: 20030, active: true, sl: null });
  assert.equal(r.level, 20014.75);
});

test('BE+: price and plan with profit', () => {
  assert.equal(breakevenPrice('long', 20000.1, 0.25, 2), 20002.25);
  assert.equal(breakevenPrice('short', 20000, 0.25, 2), 19998);
  assert.equal(breakevenPrice('long', 20000, 0.25), 20000);
  const pos = { side: 'long', openPrice: 20000, triggers: [] };
  assert.equal(breakevenPlan(pos, 20010, 0.25, 4).price, 20004);
  assert.match(breakevenPlan(pos, 20004.25, 0.25, 4).why, /BE\+/);
  assert.match(breakevenPlan({ ...pos, triggers: [{ kind: 'sl', price: 20005 }] }, 20010, 0.25, 4).why, /already/);
});

test('auto BE: at the threshold, once, never backwards', () => {
  const B = { side: 'long', qty: 2, entry: 20000, tick: 0.25, at: 10, off: 2, unit: 'pt' };
  assert.equal(autoBe({ ...B, mark: 20009, sl: null }), null);
  assert.equal(autoBe({ ...B, mark: 20010, sl: 19990 }), 20002);
  assert.equal(autoBe({ ...B, mark: 20010, sl: 20003 }), null);
  assert.equal(autoBe({ ...B, at: '', mark: 20050, sl: null }), null);
  assert.equal(autoBe({ ...B, unit: '$', at: 20, off: 4, mark: 20010, sl: null }), 20002); // $4 / 2 = 2 pt
});

test('trailView: levels to draw', () => {
  const { trailView } = require('../src/domain/trail');
  // before the start: threshold 20020 (start after 20), stop 20005 (retr. 15), next step 20022 (step 2)
  assert.deepEqual(trailView({ ...L, mark: 20010, best: null, active: false, sl: 19950 }), { active: false, act: 20020, stop: 20005, next: 20022 });
  // retracement 30 > start 20: the actual threshold is 20030.25 (first stop one tick in profit)
  assert.deepEqual(trailView({ ...L, dist: 30, mark: 20010, best: null, active: false, sl: null }), { active: false, act: 20030.25, stop: 20000.25, next: 20032.25 });
  // active with stop at 20015: the stop advances when the price reaches 20015 + 15 + 2
  assert.deepEqual(trailView({ ...L, mark: 20028, best: 20030, active: true, sl: 20015 }), { active: true, act: null, stop: 20015, next: 20032 });
  // short
  assert.deepEqual(trailView({ ...L, side: 'short', mark: 19990, best: null, active: false, sl: null }), { active: false, act: 19980, stop: 19995, next: 19978 });
});
