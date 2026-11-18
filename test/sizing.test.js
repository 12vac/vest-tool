const test = require('node:test');
const assert = require('node:assert/strict');
const Z = require('../src/domain/sizing');

const margin = {
  initMarginRatio: 0.02, // 50x
  capitalInitMarginRatio: undefined,
  fundedInitMarginRatio: 0.04, // 25x
  capitalPlans: [{ accountType: 3, planId: 'INST', initMarginRatio: 0.0667 }], // 14x
};

test('maximum leverage: plan, then funded, then market', () => {
  assert.equal(Z.maxLeverageFor(margin, { accountType: 3, planId: 'INST' }), 14);
  assert.equal(Z.maxLeverageFor(margin, { accountType: 2, planId: 'X' }), 25);
  assert.equal(Z.maxLeverageFor(margin, null), 50);
  assert.equal(Z.maxLeverageFor({ initMarginRatio: 0.02, capitalInitMarginRatio: null, fundedInitMarginRatio: null }, { maxLeverage: 20 }), 20);
});

test('order leverage: the saved one if within the maximum, otherwise the maximum', () => {
  assert.equal(Z.orderLeverage(10, 14), 10);
  assert.equal(Z.orderLeverage(50, 14), 14);
  assert.equal(Z.orderLeverage(null, 14), 14);
});

test('size: buying power, maximum and percentage rounded down to the step', () => {
  const power = Z.tradingPower({ free: 500, upnl: 0, leverage: 50, takerFee: 0.00025 });
  // 500*50 / (1+50*0.00025) / 1.001
  assert.ok(Math.abs(power - 500 * 50 / 1.0125 / 1.001) < 1e-6);
  const max = Z.maxQty(power, 20000, 0.0001);
  assert.equal(max, 1.2333);
  assert.equal(Z.qtyForPct(max, 5, 0.0001), 0.0616);
  assert.equal(Z.qtyForPct(max, 0, 0.0001), 0);
  assert.equal(Z.qtyForPct(max, 150, 0.0001), max); // never above 100%
  // an open loss reduces the buying power, a profit does not
  assert.ok(Z.tradingPower({ free: 500, upnl: -100, leverage: 50 }) < Z.tradingPower({ free: 500, upnl: 100, leverage: 50 }));
});

test('side from the drop point: LIMIT below buys, STOP above buys', () => {
  assert.equal(Z.entrySide('lm', 19990, 20000), 'long');
  assert.equal(Z.entrySide('lm', 20010, 20000), 'short');
  assert.equal(Z.entrySide('st', 20010, 20000), 'long');
  assert.equal(Z.entrySide('st', 19990, 20000), 'short');
  assert.equal(Z.entrySide('lm', 20000, 20000), null);
  assert.equal(Z.tooClose(20000.25, 20000, 0.25), true);
  assert.equal(Z.tooClose(20000.5, 20000, 0.25), false);
});

test('local stop: triggers only from the right side', () => {
  assert.equal(Z.stopHit('long', 20010, 20009.75), false);
  assert.equal(Z.stopHit('long', 20010, 20010), true);
  assert.equal(Z.stopHit('short', 19990, 19990.25), false);
  assert.equal(Z.stopHit('short', 19990, 19989), true);
});

test('bodies: open limit/market, append, reduce (strings, as the ticket)', () => {
  const lim = Z.openOrder({ symbol: 'NDX-USD-PERP', side: 'long', qty: 0.0616, leverage: 50, step: 0.0001, tick: 0.25, type: 'limit', price: 19990 });
  assert.deepEqual(lim.body, { orderType: 'limit', leverage: '50', side: 'long', symbol: 'NDX-USD-PERP', quantity: '0.0616', timeInForce: 'GTC', takeProfits: [], stopLosses: [], price: '19990.00' });
  const mkt = Z.openOrder({ symbol: 'S', side: 'short', qty: 1, leverage: 5, step: 0.0001, tick: 0.25, type: 'market' });
  assert.equal(mkt.body.timeInForce, 'IOC');
  assert.ok(!('price' in mkt.body));
  const pos = { id: 'P1', symbol: 'S', side: 'short', qty: 2 };
  assert.deepEqual(Z.appendOrder({ pos, qty: 0.5, leverage: 5, step: 0.0001, tick: 0.25, type: 'market' }).body, { symbol: 'S', positionId: 'P1', orderType: 'market', quantity: '0.5000', leverage: '5', isBuy: false, timeInForce: 'IOC' });
  assert.deepEqual(Z.reduceOrder({ pos, qty: 1, leverage: 5, step: 0.0001 }), {
    method: 'POST',
    path: '/v3/positions/reduce',
    body: { positionId: 'P1', orderType: 'market', leverage: '5', quantity: '1.0000', timeInForce: 'IOC', reduceOnly: true, symbol: 'S' },
  });
});
