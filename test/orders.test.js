const test = require('node:test');
const assert = require('node:assert/strict');
const O = require('../src/domain/orders');
const G = require('../src/domain/geometry');

const short = { id: 'P1', symbol: 'NDX-USD-PERP', side: 'short', qty: 0.009, openPrice: 30118.37, leverage: 50, triggers: [] };
const long = { ...short, side: 'long', openPrice: 20000.1 };

test('FLAT: market close with the position leverage (string)', () => {
  assert.deepEqual(O.closeOrder(short), {
    method: 'POST',
    path: '/v3/positions/close',
    body: { symbol: 'NDX-USD-PERP', positionId: 'P1', orderType: 'market', leverage: '50' },
  });
  assert.equal(O.closeOrder({ ...short, leverage: null }).body.leverage, '50'); // fallback when the leverage is unknown
});

test('SL/TP: POST if new, PUT with id if it exists, leg quantity kept', () => {
  const n = O.legOrder(short, 'sl', 30130, 0.25, null);
  assert.equal(n.method, 'POST');
  assert.deepEqual(n.body, { positionId: 'P1', executionType: 'market', triggerPrice: '30130.00' });
  const m = O.legOrder(short, 'tp', 30100.5, 0.25, { id: 'T9', qty: 0.004 });
  assert.equal(m.method, 'PUT');
  assert.equal(m.path, '/v3/positions/take-profit');
  assert.deepEqual(m.body, { positionId: 'P1', executionType: 'market', triggerPrice: '30100.50', takeProfitId: 'T9', quantity: '0.004' });
});

test('SL/TP removal: DELETE with positionId and leg id', () => {
  assert.deepEqual(O.legDeleteOrder(short, { id: 'S1', kind: 'sl', price: 30130 }), {
    method: 'DELETE',
    path: '/v3/positions/stop-loss',
    body: { positionId: 'P1', stopLossId: 'S1' },
  });
  assert.deepEqual(O.legDeleteOrder(short, { id: 'T1', kind: 'tp', price: 30100 }).body, { positionId: 'P1', takeProfitId: 'T1' });
});

test('level check: right side of the price, with a 2-tick margin', () => {
  const c = (kind, side, price) => O.checkLeg({ kind, side, price, mark: 30000, tick: 0.25 });
  assert.equal(c('sl', 'long', 29990), null);
  assert.ok(c('sl', 'long', 30010)); // above the price: would trigger at once
  assert.ok(c('sl', 'long', 29999.75)); // 1 tick away: too close
  assert.equal(c('tp', 'long', 30010), null);
  assert.ok(c('tp', 'long', 29990));
  assert.equal(c('sl', 'short', 30010), null);
  assert.equal(c('tp', 'short', 29990), null);
  assert.ok(c('tp', 'short', 30010));
});

test('breakeven: entry rounded on the profit side', () => {
  assert.equal(O.breakevenPrice('short', 30118.37, 0.25), 30118.25);
  assert.equal(O.breakevenPrice('long', 20000.1, 0.25), 20000.25);
});

test('breakeven: only if the price is beyond; moves the existing stop', () => {
  assert.ok(O.breakevenPlan(short, 30120, 0.25).why); // short at a loss: no
  const ok = O.breakevenPlan(short, 30100, 0.25);
  assert.equal(ok.price, 30118.25);
  assert.equal(ok.existing, null);
  const withSl = { ...short, triggers: [{ id: 'S1', kind: 'sl', price: 30140, qty: null }] };
  assert.equal(O.breakevenPlan(withSl, 30100, 0.25).existing.id, 'S1');
  const already = { ...short, triggers: [{ id: 'S1', kind: 'sl', price: 30110, qty: null }] };
  assert.match(O.breakevenPlan(already, 30100, 0.25).why, /already/);
});

test('geometry: price<->pixel round trip, linear and log', () => {
  const vr = { from: 30000, to: 30200, log: false };
  assert.equal(G.priceToY(30100, vr, 400), 200);
  assert.equal(G.yToPrice(200, vr, 400), 30100);
  const lg = { from: 100, to: 400, log: true };
  assert.ok(Math.abs(G.priceToY(200, lg, 200) - 100) < 1e-9); // half height = geometric mean
  assert.ok(Math.abs(G.yToPrice(G.priceToY(321, lg, 777), lg, 777) - 321) < 1e-9);
  assert.equal(G.roomBars(190, 6), 33);
});
