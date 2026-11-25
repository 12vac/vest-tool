const test = require('node:test');
const assert = require('node:assert/strict');
const { check } = require('../src/domain/selfmatch');

const SYM = 'NDX-USD-PERP';
const accounts = {
  A: { label: '19', orders: [], positions: [{ id: 'PA', symbol: SYM, side: 'long' }] },
  B: { label: '20', orders: [{ id: 'OB', symbol: SYM, side: 'long', price: 25990, qty: 0.0001 }], positions: [] },
};
const open = (side, type, price) => ({ path: '/v3/positions/open', body: { symbol: SYM, side, orderType: type, ...(price ? { price: String(price) } : {}) } });

test('market SELL near another account pending BUY: refused', () => {
  const r = check({ order: open('short', 'market'), accountId: 'A', accounts, mark: 25991, tick: 0.25 });
  assert.ok(r && !r.exit && /20 has a pending BUY/.test(r.text));
});

test('market SELL far from the pending BUY: allowed (cross-account opposite sides are allowed)', () => {
  assert.equal(check({ order: open('short', 'market'), accountId: 'A', accounts, mark: 26100, tick: 0.25 }), null);
});

test('limit SELL at or below the other BUY crosses; above it does not', () => {
  assert.ok(check({ order: open('short', 'limit', 25990), accountId: 'A', accounts, mark: 26000, tick: 0.25 }));
  assert.equal(check({ order: open('short', 'limit', 26010), accountId: 'A', accounts, mark: 26000, tick: 0.25 }), null);
});

test('same side and same account never count', () => {
  assert.equal(check({ order: open('long', 'market'), accountId: 'A', accounts, mark: 25991, tick: 0.25 }), null);
  assert.equal(check({ order: open('short', 'market'), accountId: 'B', accounts, mark: 25991, tick: 0.25 }), null);
});

test('exit of a LONG (reduce = SELL) near the other BUY: reported as exit (warning only)', () => {
  const r = check({ order: { path: '/v3/positions/reduce', body: { positionId: 'PA', orderType: 'market' } }, accountId: 'A', accounts, mark: 25991, tick: 0.25 });
  assert.ok(r && r.exit);
});

test('cancels and SL / TP are not checked', () => {
  assert.equal(check({ order: { path: '/v3/positions/cancel-order', body: {} }, accountId: 'A', accounts, mark: 25991, tick: 0.25 }), null);
});
