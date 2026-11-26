const test = require('node:test');
const assert = require('node:assert/strict');
const { check, crossings, textOf, sideOf } = require('../src/domain/selfmatch');

const SYM = 'NDX-USD-PERP';
const TICK = 0.25;
const acc = (label, orders = [], positions = [], known = true) => ({ label, known, orders, positions });
const rest = (id, side, price, qty = 0.0001, symbol = SYM) => ({ id, symbol, side, price, qty });
const open = (side, type, price) => ({ method: 'POST', path: '/v3/positions/open', body: { symbol: SYM, side, orderType: type, ...(price ? { price: String(price) } : {}) } });
const run = (order, accounts, accountId = 'A', skip) => check({ order, accountId, accounts, tick: TICK, skip });

test('buy LIMIT vs a resting SELL of another account: crosses at or above, not below', () => {
  const accounts = { A: acc('19'), B: acc('20', [rest('OB', 'short', 26000)]) };
  assert.equal(run(open('long', 'limit', 26010), accounts).hits.length, 1);
  assert.equal(run(open('long', 'limit', 26000), accounts).hits.length, 1, 'equal price crosses');
  assert.equal(run(open('long', 'limit', 25999.75), accounts).hits.length, 0);
});

test('sell LIMIT vs a resting BUY of another account: crosses at or below, not above', () => {
  const accounts = { A: acc('19'), B: acc('20', [rest('OB', 'long', 25990)]) };
  const r = run(open('short', 'limit', 25980), accounts);
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].accountId, 'B');
  assert.equal(r.hits[0].orderId, 'OB');
  assert.equal(run(open('short', 'limit', 25990), accounts).hits.length, 1, 'equal price crosses');
  assert.equal(run(open('short', 'limit', 25990.25), accounts).hits.length, 0);
});

test('market orders cross any opposite resting order, at any price', () => {
  const accounts = { A: acc('19'), B: acc('20', [rest('OB', 'short', 99999)]) };
  assert.equal(run(open('long', 'market'), accounts).hits.length, 1);
  assert.equal(run(open('short', 'market'), accounts).hits.length, 0, 'same side never trades');
});

test('the same account does not count (Vest itself refuses an opposite order on the same account)', () => {
  const accounts = { A: acc('19', [rest('OA', 'long', 25990)]), B: acc('20', [], [], false) };
  const r = run(open('short', 'limit', 25980), accounts);
  assert.equal(r.hits.length, 0);
  assert.deepEqual(r.unknown, ['20'], 'only other accounts can be unknown');
  assert.deepEqual(run(open('short', 'limit', 25980), { A: acc('19', [rest('OA', 'long', 25990)], [], false) }).unknown, []);
});

test('another market, no price or zero size: not a resting order', () => {
  const accounts = {
    A: acc('19'),
    B: acc('20', [rest('O1', 'short', 26000, 0.0001, 'ETH-USD-PERP'), { id: 'O2', symbol: SYM, side: 'short', price: 0, qty: 1 }, rest('O3', 'short', 26000, 0)]),
  };
  assert.equal(run(open('long', 'market'), accounts).hits.length, 0);
});

test('orders already being cancelled (skip) are ignored', () => {
  const accounts = { A: acc('19'), B: acc('20', [rest('OB', 'short', 26000)]) };
  assert.equal(run(open('long', 'market'), accounts, 'A', new Set(['OB'])).hits.length, 0);
});

test('exits: reduce / close of a LONG = SELL, marked as exit', () => {
  const accounts = { A: acc('19', [], [{ id: 'PA', symbol: SYM, side: 'long' }]), B: acc('20', [rest('OB', 'long', 25990)]) };
  const r = run({ method: 'POST', path: '/v3/positions/close', body: { positionId: 'PA' } }, accounts);
  assert.ok(r.exit && !r.leg && r.hits.length === 1);
  const r2 = run({ method: 'POST', path: '/v3/positions/reduce', body: { positionId: 'PA', orderType: 'market' } }, accounts);
  assert.ok(r2.exit && r2.hits.length === 1);
});

test('SL / TP legs: checked as a market exit, marked as leg; DELETE and cancel are not checked', () => {
  const accounts = { A: acc('19', [], [{ id: 'PA', symbol: SYM, side: 'long' }]), B: acc('20', [rest('OB', 'long', 25990)]) };
  const r = run({ method: 'POST', path: '/v3/positions/stop-loss', body: { positionId: 'PA', triggerPrice: '25900' } }, accounts);
  assert.ok(r.leg && r.exit && r.hits.length === 1);
  assert.equal(run({ method: 'DELETE', path: '/v3/positions/stop-loss', body: { positionId: 'PA' } }, accounts), null);
  assert.equal(run({ method: 'POST', path: '/v3/positions/cancel-order', body: { orderId: 'OB' } }, accounts), null);
});

test('append without isBuy takes the side of the position', () => {
  const pos = [{ id: 'PA', symbol: SYM, side: 'short' }];
  const o = sideOf({ path: '/v3/positions/append', body: { positionId: 'PA', orderType: 'market' } }, (id) => pos.find((p) => p.id === id));
  assert.equal(o.side, 'sell');
  assert.equal(o.exit, false);
});

test('unknown orders of an account are reported, never assumed empty', () => {
  const accounts = { A: acc('19'), B: acc('20', [], [], false) };
  const r = run(open('long', 'market'), accounts);
  assert.deepEqual(r.unknown, ['20']);
  assert.equal(r.hits.length, 0);
  assert.match(textOf(r, true), /BLOCKED.*20 are not read yet/);
});

test('crossings: resting orders that already cross across accounts', () => {
  const accounts = { A: acc('19', [rest('OA', 'long', 26000)]), B: acc('20', [rest('OB', 'short', 26000), rest('OC', 'short', 26100)]) };
  const c = crossings(accounts, () => TICK);
  assert.equal(c.length, 1);
  assert.match(c[0].buy, /^19 BUY/);
  assert.match(c[0].sell, /^20 SELL .* @ 26000$/);
  assert.equal(crossings({ A: acc('19', [rest('OA', 'long', 25000)]), B: acc('20', [rest('OB', 'short', 26000)]) }).length, 0);
  assert.equal(crossings({ A: acc('19', [rest('OA', 'long', 26000), rest('OA2', 'short', 25900)]) }).length, 0, 'same account: not reported');
});

test('exitPlan: the master commands (copier ON)', () => {
  const { exitPlan } = require('../src/domain/selfmatch');
  const roles = { master: 'M', followers: ['C1', 'C2'] };
  const h = (accountId) => ({ accountId, orderId: 'o' + accountId, text: accountId });
  // master's manual exit: copies' orders cancelled by themselves; an account outside the copier gets the button
  let p = exitPlan({ hits: [h('C1'), h('X')], accountId: 'M', roles, auto: false });
  assert.deepEqual(p.cancel.map((x) => x.accountId), ['C1']);
  assert.deepEqual(p.ask.map((x) => x.accountId), ['X']);
  // a copy's exit that could hit the master's order: blocked, nothing cancelled
  p = exitPlan({ hits: [h('M'), h('C2')], accountId: 'C1', roles, auto: true });
  assert.deepEqual(p.block.map((x) => x.accountId), ['M']);
  // a copy's automatic exit vs another copy: cancelled by itself
  p = exitPlan({ hits: [h('C2')], accountId: 'C1', roles, auto: true });
  assert.deepEqual(p.cancel.map((x) => x.accountId), ['C2']);
  // copier OFF: manual = button, automatic = cancel
  assert.deepEqual(exitPlan({ hits: [h('C1')], accountId: 'M', roles: null, auto: false }).ask.length, 1);
  assert.deepEqual(exitPlan({ hits: [h('C1')], accountId: 'M', roles: null, auto: true }).cancel.length, 1);
});
