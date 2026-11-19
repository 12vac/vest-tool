const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../src/domain/account');
const { describe, missing, redact } = require('../src/domain/shapes');

const acc = A.parseCapitalAccount({
  id: 'ACC_A',
  initial_capital: '50000',
  max_drawdown_limit: '47500',
  daily_loss_floor: '48000',
  max_daily_loss_pct: '0.02',
  account_type: 2,
  attempt_index: 0,
});

test('account: fixed data', () => {
  assert.equal(acc.label, '1 ACC_A'); // number + last 6 digits of the id
  assert.equal(acc.type, 'Evaluation');
  assert.equal(acc.initial, 50000);
  assert.equal(acc.dailyFloor, 48000);
});

test('feed: discards old or repeated events', () => {
  let { state } = A.applyFeedState(null, { account_seq: 5, final_balance: { amount: '49000', balance_version: 3 } }, 1);
  assert.equal(state.free, 49000);
  const r = A.applyFeedState(state, { account_seq: 5, final_balance: { amount: '1', balance_version: 9 } }, 2);
  assert.equal(r.applied, false);
  assert.equal(r.state.free, 49000);
  const r2 = A.applyFeedState(state, { account_seq: 4 }, 3);
  assert.equal(r2.applied, false);
});

test('feed: opens, adds a stop, closes', () => {
  let s = A.applyFeedState(null, {
    account_seq: 1,
    positions: [{ position_id: 'P1', status: 'opened', symbol: 'NDX-USD-PERP', side: 'long', quantity: '2', open_price: '20000', collateral: '400' }],
    order_intents: [{ id: 'S1', position_id: 'P1', kind: 'stop_loss', state: 'active', trigger_price: '19950' }],
    final_balance: { amount: '49600', balance_version: 1 },
  }, 1).state;
  assert.equal(s.positions.length, 1);
  assert.deepEqual(s.positions[0].triggers, [{ id: 'S1', kind: 'sl', price: 19950, qty: null }]);
  s = A.applyFeedState(s, { account_seq: 2, positions: [{ position_id: 'P1', status: 'closed', event_type: 'POSITION_EVENT_TYPE_CLOSED' }] }, 2).state;
  assert.equal(s.positions.length, 0);
});

test('feed: an older balance_version does not overwrite', () => {
  let s = A.applyFeedState(null, { account_seq: 1, final_balance: { amount: '100', balance_version: 5 } }, 1).state;
  s = A.applyFeedState(s, { account_seq: 2, final_balance: { amount: '90', balance_version: 4 } }, 2).state;
  assert.equal(s.free, 100);
});

test('$ values: balance, equity, total P&L, distance from the limit', () => {
  const st = {
    free: 49600,
    ordersCollateral: 0,
    positions: [{ symbol: 'NDX-USD-PERP', side: 'long', qty: 2, openPrice: 20000, collateral: 400 }],
  };
  const v = A.valuesOf(acc, st, { 'NDX-USD-PERP': 20010 }, null);
  assert.equal(v.balance, 50000);
  assert.equal(v.upnl, 20);
  assert.equal(v.equity, 50020);
  assert.equal(v.totalPnl, 20);
  assert.equal(v.toFloor, 50020 - 48000); // the daily limit is nearer
  assert.equal(v.source, 'live');
});

test('$ values: without a mark falls back on the series, never on made-up numbers', () => {
  const st = { free: 49600, ordersCollateral: 0, positions: [{ symbol: 'X', side: 'long', qty: 1, openPrice: 1, collateral: 0 }] };
  const v = A.valuesOf(acc, st, {}, { equity: 49900, upnl: -50 });
  assert.equal(v.source, 'series');
  assert.equal(v.equity, 49900);
  const none = A.valuesOf(acc, st, {}, null);
  assert.ok(Number.isNaN(none.equity));
  assert.equal(none.source, null);
});

test('REST positions: discards size 0 (limit placeholders)', () => {
  const p = A.parseRestPositions({
    positions: [
      { positionId: 'P1', symbol: 'S', side: 'short', quantity: '1', openPrice: '10', stopLosses: [{ id: 'L', triggerPrice: '11' }] },
      { positionId: 'P2', symbol: 'S', side: 'long', quantity: '0', openPrice: '0' },
    ],
  });
  assert.equal(p.length, 1);
  assert.equal(p[0].triggers[0].kind, 'sl');
});

test('session: base at the first value of the day, new one when the date changes', () => {
  let r = A.sessionBaseline(null, '2026-10-16', 'A', 100);
  r = A.sessionBaseline(r, '2026-10-16', 'A', 150);
  assert.equal(r.start.A, 100);
  r = A.sessionBaseline(r, '2026-10-17', 'A', 150);
  assert.equal(r.start.A, 150);
});

test('shapes: names and types only, never values', () => {
  const d = describe({ token: 'topsecret', n: 1, list: [{ a: 'x' }] });
  assert.deepEqual(d, { list: [{ a: 'string' }], n: 'number', token: 'string' });
  assert.ok(!JSON.stringify(d).includes('topsecret'));
  assert.deepEqual(missing({ a: 1 }, ['a', 'b']), ['b']);
  assert.equal(redact('Authorization: Bearer abc.def'), 'Authorization: Bearer [X]');
  assert.equal(redact('x eyJhbGciOi.eyJzdWIi.sig y'), 'x [JWT] y');
});

test('account_seq as a string above 2^53: a new event is not discarded', () => {
  const big = '9007199254740993'; // parseInt rounds it to ...992
  let s = A.applyFeedState(null, { account_seq: '9007199254740992', final_balance: { amount: '1', balance_version: 1 } }, 1).state;
  const r = A.applyFeedState(s, { account_seq: big, final_balance: { amount: '2', balance_version: 2 } }, 2);
  assert.equal(r.applied, true);
  assert.equal(r.state.free, 2);
  assert.equal(A.applyFeedState(r.state, { account_seq: big }, 3).applied, false);
});

test('P&L of the Vest day: equity minus opening equity; without a base it stays unknown', () => {
  const a = A.parseCapitalAccount({ id: 'X', initial_capital: '50000', max_drawdown_limit: '47500', account_type: 2 });
  const st = { free: 50000, ordersCollateral: 0, positions: [] };
  assert.equal(A.valuesOf(a, st, {}, null, 50100).dayPnl, -100);
  assert.ok(Number.isNaN(A.valuesOf(a, st, {}, null, NaN).dayPnl));
});

test('daily fields: classified without values', () => {
  const a = A.parseCapitalAccount({ id: 'X', initial_capital: '500', max_drawdown_limit: '490', daily_reset_equity: '0', daily_reset_balance: '', account_type: 3 });
  assert.equal(a.dailyInfo.daily_reset_equity, 'zero');
  assert.equal(a.dailyInfo.daily_reset_balance, 'empty');
  assert.equal(a.dailyInfo.daily_loss_floor, 'missing');
  assert.equal(a.dailyResetEquity, null); // zero is not a valid base: "Today" stays "—", not a made-up number
  assert.ok(!JSON.stringify(a.dailyInfo).includes('500'));
});

test('pending orders: REST and feed (snake_case), in and out by state', () => {
  const rest = A.parseRestOrders({ orders: [{ orderId: 'O1', symbol: 'S', orderType: 'limit', side: 'long', price: '100', quantity: '1', collateral: '5' }] });
  assert.equal(rest.orders[0].side, 'long');
  assert.equal(rest.ordersCollateral, 5);
  let s = { positions: [], orders: rest.orders, free: 10, balVer: 1, seq: '1' };
  s = A.applyFeedState(s, { account_seq: '2', orders: [{ order_id: 'O2', symbol: 'S', order_type: 'limit', is_buy: false, price: '110', quantity: '2', status: 'accepted' }] }, 1).state;
  assert.deepEqual(s.orders.map((o) => o.id + ':' + o.side), ['O1:long', 'O2:short']);
  s = A.applyFeedState(s, { account_seq: '3', orders: [{ order_id: 'O1', status: 'cancelled', quantity: '1' }] }, 2).state;
  assert.deepEqual(s.orders.map((o) => o.id), ['O2']);
  s = A.applyFeedState(s, { account_seq: '4', orders: [{ order_id: 'O2', status: 'filled', quantity: '2', executed_quantity: '2' }] }, 3).state;
  assert.equal(s.orders.length, 0);
});

test('posAt only for messages that touch positions or orders', () => {
  const A2 = require('../src/domain/account');
  const s0 = { positions: [], ordersCollateral: 0, free: NaN, balVer: -1, seq: null };
  const a = A2.applyFeedState(s0, { final_balance: { amount: '500', balance_version: 1 } }, 1000);
  assert.strictEqual(a.state.posAt, undefined);
  const b = A2.applyFeedState(a.state, { positions: [{ position_id: 'P', status: 'opened', symbol: 'X', side: 'long', quantity: '1' }] }, 2000);
  assert.strictEqual(b.state.posAt, 2000);
  assert.strictEqual(b.state.feedAt, 2000);
});


test('placeholder of a pending LIMIT: legs Vest keeps on it, null when Vest sends no list', () => {
  const [ph] = A.parseRestPlaceholders({
    positions: [{ positionId: 'P1', symbol: 'BTC', side: 'long', quantity: '0', takeProfits: [{ id: 't1', triggerPrice: '110', quantity: '0.5' }], stopLosses: [{ id: 's1', triggerPrice: '90' }] }],
  });
  assert.deepEqual(ph.triggers, [
    { id: 't1', kind: 'tp', price: 110, qty: 0.5 },
    { id: 's1', kind: 'sl', price: 90, qty: null },
  ]);
  assert.equal(A.parseRestPlaceholders({ positions: [{ positionId: 'P2', symbol: 'ETH', quantity: '0' }] })[0].triggers, null);
});
