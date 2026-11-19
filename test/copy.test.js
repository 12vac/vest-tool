const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/domain/copy');

const step = 0.0001,
  tick = 0.25;
const mPos = { id: 'PM', symbol: 'NDX-USD-PERP', side: 'long', qty: 2, leverage: 50 };
const fPos = { id: 'PF', symbol: 'NDX-USD-PERP', side: 'long', qty: 1, leverage: 50 };

test('action from the path', () => {
  assert.strictEqual(C.actionOf('/v3/positions/open'), 'open');
  assert.strictEqual(C.actionOf('https://x/v3/positions/reduce?x=1'), 'reduce');
  assert.strictEqual(C.actionOf('/v3/positions/opened'), null);
});

test('Cap-to-fit only scales down', () => {
  assert.deepStrictEqual(C.capQty({ mode: '1:1', masterQty: '2', mEq: 50000, fEq: 5000, step }), { qty: 2, scaled: false });
  // copy 10 times smaller: 2 x 0.1 x 0.95 = 0.19
  assert.deepStrictEqual(C.capQty({ mode: 'cap', masterQty: '2', mEq: 50000, fEq: 5000, step }), { qty: 0.19, scaled: true });
  // larger copy: same size as the master (no scaling up)
  assert.deepStrictEqual(C.capQty({ mode: 'cap', masterQty: '2', mEq: 5000, fEq: 50000, step }), { qty: 2, scaled: false });
  // a few cents of difference: same size
  assert.deepStrictEqual(C.capQty({ mode: 'cap', masterQty: '2', mEq: 500.0, fEq: 499.99, step }), { qty: 2, scaled: false });
  assert.ok(C.capQty({ mode: 'cap', masterQty: '2', mEq: 50000, fEq: NaN, step }).skip);
});

test('market entry: open, or add if the copy is already on the same side', () => {
  const body = { orderType: 'market', side: 'long', symbol: 'NDX-USD-PERP', quantity: '2.0000', leverage: '50' };
  const a = C.planFollower({ action: 'open', body, mode: 'cap', mEq: 50000, fEq: 5000, step, tick });
  assert.strictEqual(a.order.path, '/v3/positions/open');
  assert.strictEqual(a.order.body.quantity, '0.1900');
  const b = C.planFollower({ action: 'open', body, fPos, mode: '1:1', step, tick });
  assert.strictEqual(b.order.path, '/v3/positions/append');
  assert.strictEqual(b.positionId, 'PF');
  const c = C.planFollower({ action: 'open', body, fPos: { ...fPos, side: 'short' }, mode: '1:1', step, tick });
  assert.ok(c.skip);
});

test('cancellations do not go through the plan (the copier does them with the map)', () => {
  assert.ok(C.planFollower({ action: 'cancel-order', body: {}, step, tick }).notCopied);
});

test('master SL/TP: added, moved and removed on the copy position', () => {
  const mB = { ...mPos, triggers: [{ id: 'MSL', kind: 'sl', price: 29300 }] };
  const fP = { ...fPos, triggers: [{ id: 'FSL', kind: 'sl', price: 29300 }, { id: 'FTP', kind: 'tp', price: 29600 }] };
  const add = C.planFollower({ action: 'take-profit', method: 'POST', body: { positionId: 'PM', executionType: 'market', triggerPrice: '29700.00' }, mBefore: mB, fPos: fP, step, tick });
  assert.deepStrictEqual(add.order, { method: 'POST', path: '/v3/positions/take-profit', body: { executionType: 'market', triggerPrice: '29700.00', positionId: 'PF' } });
  const mv = C.planFollower({ action: 'stop-loss', method: 'PUT', body: { positionId: 'PM', stopLossId: 'MSL', executionType: 'market', triggerPrice: '29350.00' }, mBefore: mB, fPos: fP, step, tick });
  assert.strictEqual(mv.order.method, 'PUT');
  assert.strictEqual(mv.order.body.stopLossId, 'FSL');
  assert.strictEqual(mv.order.body.triggerPrice, '29350.00');
  const del = C.planFollower({ action: 'stop-loss', method: 'DELETE', body: { positionId: 'PM', stopLossId: 'MSL' }, mBefore: mB, fPos: fP, step, tick });
  assert.deepStrictEqual(del.order, { method: 'DELETE', path: '/v3/positions/stop-loss', body: { positionId: 'PF', stopLossId: 'FSL' } });
  // partial leg: quantity in proportion (copy half of the master)
  const part = C.planFollower({ action: 'take-profit', method: 'POST', body: { positionId: 'PM', triggerPrice: '29700', quantity: '1' }, mBefore: mB, fPos: fP, step, tick });
  assert.strictEqual(part.order.body.quantity, '0.5000');
  // move without a leg on the copy: becomes an add
  const mv2 = C.planFollower({ action: 'stop-loss', method: 'PUT', body: { positionId: 'PM', stopLossId: 'MSL', triggerPrice: '29350' }, mBefore: mB, fPos: { ...fPos, triggers: [] }, step, tick });
  assert.strictEqual(mv2.order.method, 'POST');
  assert.ok(C.planFollower({ action: 'stop-loss', method: 'POST', body: { triggerPrice: '1' }, mBefore: mB, fPos: null, step, tick }).skip);
});

test('market entry from the ticket with attached SL/TP: copied', () => {
  const body = { orderType: 'market', side: 'long', symbol: 'NDX-USD-PERP', quantity: '1', leverage: '50', stopLosses: [{ executionType: 'market', triggerPrice: '29300' }], takeProfits: [] };
  const a = C.planFollower({ action: 'open', body, mode: '1:1', step, tick });
  assert.strictEqual(a.order.body.stopLosses.length, 1);
});

test('entry limit copied at the same price, open or append on the placeholder', () => {
  const body = { orderType: 'limit', side: 'long', symbol: 'NDX-USD-PERP', quantity: '2.0000', leverage: '50', price: '29400.00', timeInForce: 'GTC', takeProfits: [{ executionType: 'market', triggerPrice: '29500' }], stopLosses: [{ triggerPrice: '29300', quantity: '1' }] };
  const a = C.planFollower({ action: 'open', body, mode: 'cap', mEq: 50000, fEq: 5000, step, tick, fLev: 25 });
  assert.strictEqual(a.order.path, '/v3/positions/open');
  assert.strictEqual(a.order.body.price, '29400.00');
  assert.strictEqual(a.order.body.quantity, '0.1900');
  assert.strictEqual(a.order.body.leverage, '25');
  assert.strictEqual(a.order.body.timeInForce, 'GTC');
  assert.strictEqual(a.order.body.takeProfits.length, 1); // without quantity: copied
  assert.strictEqual(a.order.body.stopLosses.length, 0); // with quantity: not copied
  assert.ok(a.pending);
  const ph = { id: 'PH', symbol: 'NDX-USD-PERP', side: 'long', qty: 0 };
  const b = C.planFollower({ action: 'open', body, fPh: ph, mode: '1:1', step, tick });
  assert.strictEqual(b.order.path, '/v3/positions/append');
  assert.strictEqual(b.order.body.positionId, 'PH');
  assert.strictEqual(b.order.body.isBuy, true);
  assert.strictEqual(b.order.body.side, undefined);
  // ticket stop: type and trigger copied as they are
  const st = C.planFollower({ action: 'append', body: { orderType: 'stop', positionId: 'PM', quantity: '1', leverage: '50', isBuy: true, triggerPrice: '29600' }, mBefore: mPos, fPos, step, tick });
  assert.strictEqual(st.order.body.orderType, 'stop');
  assert.strictEqual(st.order.body.triggerPrice, '29600');
  assert.strictEqual(st.order.body.quantity, '0.5000');
  assert.strictEqual(st.order.body.positionId, 'PF');
});

test('LIMIT reduction copied as pending, not at market', () => {
  const r = C.planFollower({ action: 'reduce', body: { orderType: 'limit', positionId: 'PM', quantity: '1', leverage: '50', price: '29500.00', reduceOnly: true, timeInForce: 'GTC' }, mBefore: mPos, fPos, step, tick });
  assert.strictEqual(r.order.path, '/v3/positions/reduce');
  assert.strictEqual(r.order.body.orderType, 'limit');
  assert.strictEqual(r.order.body.price, '29500.00');
  assert.strictEqual(r.order.body.quantity, '0.5000');
  assert.strictEqual(r.order.body.positionId, 'PF');
  assert.ok(r.pending);
});

test('markets the master has left', () => {
  const r = C.exitedSymbols(new Set(['NQ', 'ES']), [{ symbol: 'NQ', qty: 1 }, { symbol: 'GC', qty: 0.5 }]);
  assert.deepStrictEqual(r.gone, ['ES']);
  assert.deepStrictEqual([...r.now].sort(), ['GC', 'NQ']);
  assert.deepStrictEqual(C.exitedSymbols(new Set(['NQ']), null).gone, ['NQ']);
  assert.deepStrictEqual(C.exitedSymbols(new Set(), [{ symbol: 'NQ', qty: 0 }]).gone, []);
});

test('order id from the response', () => {
  assert.strictEqual(C.orderIdOf({ orderId: 'O1' }), 'O1');
  assert.strictEqual(C.orderIdOf({ order_id: 'O2' }), 'O2');
  assert.strictEqual(C.orderIdOf(null), null);
});

test('add and reduce in proportion to the copy size', () => {
  const add = C.planFollower({ action: 'append', body: { orderType: 'market', positionId: 'PM', quantity: '1', leverage: '50' }, mBefore: mPos, fPos, step, tick });
  assert.strictEqual(add.order.body.quantity, '0.5000');
  const red = C.planFollower({ action: 'reduce', body: { positionId: 'PM', quantity: '1', leverage: '50' }, mBefore: mPos, fPos, step, tick });
  assert.strictEqual(red.order.path, '/v3/positions/reduce');
  assert.strictEqual(red.order.body.quantity, '0.5000');
  // the master reduces everything: the copy reduces its whole size
  const all = C.planFollower({ action: 'reduce', body: { positionId: 'PM', quantity: '2', leverage: '50' }, mBefore: mPos, fPos, step, tick });
  assert.strictEqual(all.order.body.quantity, '1.0000');
  // copy not in the trade: nothing
  assert.ok(C.planFollower({ action: 'append', body: { orderType: 'market', quantity: '1', leverage: '50' }, mBefore: mPos, fPos: null, step, tick }).skip);
});

test('close: /close of the copy position', () => {
  const c = C.planFollower({ action: 'close', body: { positionId: 'PM' }, mBefore: mPos, fPos, step, tick });
  assert.strictEqual(c.order.path, '/v3/positions/close');
  assert.strictEqual(c.order.body.positionId, 'PF');
  assert.ok(C.planFollower({ action: 'close', body: {}, mBefore: mPos, fPos: null, step, tick }).skip);
});

test('leftoverPh: empty placeholder left by a copy order just cancelled', () => {
  const jc = { symbol: 'NQ', ids: new Set(['O1']), at: 1000 };
  const ph = [{ id: 'P', symbol: 'NQ', qty: 0 }];
  assert.strictEqual(C.leftoverPh({ placeholders: ph, positions: [], orders: [] }, jc, 'NQ', 2000), true);
  assert.strictEqual(C.leftoverPh({ placeholders: ph, positions: [], orders: [{ id: 'O1', symbol: 'NQ' }] }, jc, 'NQ', 2000), true); // state not updated yet
  assert.strictEqual(C.leftoverPh({ placeholders: ph, positions: [], orders: [{ id: 'O2', symbol: 'NQ' }] }, jc, 'NQ', 2000), false); // another pending order: real placeholder
  assert.strictEqual(C.leftoverPh({ placeholders: ph, positions: [{ symbol: 'NQ', qty: 1 }], orders: [] }, jc, 'NQ', 2000), false);
  assert.strictEqual(C.leftoverPh({ placeholders: [], positions: [], orders: [] }, jc, 'NQ', 2000), false); // gone
  assert.strictEqual(C.leftoverPh({ placeholders: ph, positions: [], orders: [] }, jc, 'NQ', 12000), false); // too old
  assert.strictEqual(C.leftoverPh({ placeholders: ph, positions: [], orders: [] }, null, 'NQ', 2000), false); // nothing cancelled
});
