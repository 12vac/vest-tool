const test = require('node:test');
const assert = require('node:assert/strict');
const { ladder, ddHalf } = require('../src/domain/ladder');

test('AVG NEXT: position + only the next limit', () => {
  const r = ladder({
    pos: { side: 'short', qty: 1, openPrice: 100 },
    orders: [{ id: 'a', side: 'short', price: 110, qty: 1 }, { id: 'b', side: 'short', price: 104, qty: 3 }, { id: 'c', side: 'short', price: 120, qty: 1 }],
  });
  assert.strictEqual(r.next.id, 'b');
  assert.strictEqual(r.next.qty, 4);
  assert.strictEqual(r.next.avg, 103);
  assert.strictEqual(ladder({ pos: { side: 'long', qty: 1, openPrice: 100 }, orders: [{ id: 'a', side: 'long', price: 90, qty: 1 }] }).next, undefined);
});

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('long with two limits below: average, P&L at the last one, drawdown left', () => {
  const r = ladder({
    pos: { side: 'long', qty: 2, openPrice: 20000 },
    orders: [
      { id: 'a', side: 'long', price: 19950, qty: 1 },
      { id: 'b', side: 'long', price: 19900, qty: 1 },
    ],
    equity: 50020, // with +20 open
    mark: 20010,
    floors: { total: 47500, daily: 0 },
    sl: 19850,
  });
  assert.equal(r.lastId, 'b');
  assert.equal(r.qty, 4);
  near(r.avg, 19962.5);
  near(r.pnl, -250); // 4 x (19900 - 19962.5)
  near(r.equityAt, 50000 - 250);
  near(r.ddLeft, 49750 - 47500);
  assert.equal(r.floorKind, 'total');
  near(r.slPnl, -450);
});

test('short from flat: last = the highest; daily floor nearer', () => {
  const r = ladder({
    pos: null,
    orders: [
      { id: 'x', side: 'short', price: 3010, qty: 2 },
      { id: 'y', side: 'short', price: 3030, qty: 2 },
    ],
    equity: 10000,
    mark: 3000,
    floors: { total: 9000, daily: 9500 },
  });
  assert.equal(r.lastId, 'y');
  near(r.avg, 3020);
  near(r.pnl, -40);
  near(r.ddLeft, 9960 - 9500);
  assert.equal(r.floorKind, 'daily');
  assert.equal(r.slPnl, undefined);
});

test('limits on the opposite side of the position or no limits: null', () => {
  assert.equal(ladder({ pos: { side: 'long', qty: 1, openPrice: 10 }, orders: [{ id: 1, side: 'short', price: 12, qty: 1 }], equity: 100, mark: 10 }), null);
  assert.equal(ladder({ pos: null, orders: [], equity: 100, mark: 10 }), null);
});

const { knockout } = require('../src/domain/ladder');

test('fail price: long position only', () => {
  // base 50000, 2 NQ at 20000, floor 49000 -> loses 1000 with 2 NQ: 20000 - 500
  const k = knockout({ pos: { side: 'long', qty: 2, openPrice: 20000 }, orders: [], equity: 50020, mark: 20010, floors: { total: 49000 } });
  near(k.price, 19500);
  assert.equal(k.filled, 0);
  near(k.loss, -1020);
});

test('fail price: limits above it fill and bring it closer; those beyond do not', () => {
  const k = knockout({
    pos: { side: 'long', qty: 2, openPrice: 20000 },
    orders: [
      { id: 'a', side: 'long', price: 19900, qty: 2 }, // fills: 4 NQ, cost 79800
      { id: 'b', side: 'long', price: 19000, qty: 5 }, // beyond the fail price: does not count
    ],
    equity: 50000,
    mark: 20000,
    floors: { total: 49000 },
  });
  // 4p - 79800 = -1000 -> p = 19700
  near(k.price, 19700);
  assert.equal(k.filled, 1);
  assert.equal(k.qty, 4);
});

test('fail price: short from flat with limits, daily floor', () => {
  const k = knockout({ pos: null, orders: [{ id: 'x', side: 'short', price: 3010, qty: 2 }], equity: 10000, mark: 3000, floors: { total: 9000, daily: 9500 } });
  // -2*(p - 3010) = -500 -> p = 3260
  near(k.price, 3260);
  assert.equal(k.floorKind, 'daily');
});

test('fail price: no floor or equity already below -> null', () => {
  assert.equal(knockout({ pos: { side: 'long', qty: 1, openPrice: 10 }, orders: [], equity: 100, mark: 10, floors: {} }), null);
  assert.equal(knockout({ pos: { side: 'long', qty: 1, openPrice: 10 }, orders: [], equity: 100, mark: 10, floors: { total: 120 } }), null);
});

test('50% drawdown = half fail price: counts the entry limits that fill first', () => {
  const pos = { side: 'short', qty: 1, openPrice: 100 };
  const floors = { total: 980 };
  const base = { pos, equity: 1000, balance: 1000, mark: 100, floors, initial: 990, tick: 0.25 };
  // without limits: half of 20 = 10 -> 10 points above
  const a = ddHalf({ ...base, orders: [] });
  assert.strictEqual(a.price, 110);
  assert.strictEqual(a.loss, -10);
  assert.strictEqual(a.avail, 20);
  assert.ok(Math.abs(a.ddInit - 10) < 1e-9 && Math.abs(a.pl - 10) < 1e-9);
  // SELL limit at 104: size 2, entry 102 -> loss 10 at 107; the fail price (loss 20) is at 112, after
  const orders = [{ id: 'l', side: 'short', price: 104, qty: 1 }];
  const b = ddHalf({ ...base, orders });
  assert.strictEqual(b.price, 107);
  assert.strictEqual(b.qty, 2);
  assert.strictEqual(b.filled, 1);
  assert.strictEqual(b.loss, -10);
  assert.strictEqual(b.afterKo, false);
  const ko = knockout({ pos, orders, equity: 1000, mark: 100, floors });
  assert.strictEqual(ko.price, 112);
  assert.ok(b.price < ko.price);
  // the level stays put if the price moves (base = equity without open P&L)
  const c = ddHalf({ ...base, orders, equity: 997, mark: 103 });
  assert.strictEqual(c.price, 107);
  assert.strictEqual(c.fromNow, -7);
  // daily floor above the level: flagged
  assert.strictEqual(ddHalf({ ...base, orders, floors: { total: 980, daily: 995 } }).afterKo, true);
  // rounded toward the current price (loss <= half)
  const d = ddHalf({ ...base, pos: { side: 'long', qty: 3, openPrice: 100 }, orders: [] });
  assert.strictEqual(d.price, 96.75); // 100 - 10/3 = 96.667 -> 96.75
  assert.ok(-d.loss <= 10);
  assert.strictEqual(ddHalf({ ...base, balance: 975, orders: [] }), null); // below the floor
  assert.strictEqual(ddHalf({ ...base, pos: null, orders: [] }), null);
});

test('parts: entries averaged (AVG ALL only from 2)', () => {
  const one = { id: 'a', side: 'long', price: 90, qty: 1 },
    two = { id: 'b', side: 'long', price: 80, qty: 1 };
  assert.strictEqual(ladder({ pos: null, orders: [one] }).parts, 1); // a single LIMIT: no AVG ALL
  assert.strictEqual(ladder({ pos: null, orders: [one, two] }).parts, 2);
  assert.strictEqual(ladder({ pos: { side: 'long', qty: 1, openPrice: 100 }, orders: [one] }).parts, 2);
  assert.strictEqual(ladder({ pos: { side: 'long', qty: 0, openPrice: 0 }, orders: [one] }).parts, 1); // size-0 placeholder
});
