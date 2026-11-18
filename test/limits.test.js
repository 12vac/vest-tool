const test = require('node:test');
const assert = require('node:assert');
const { limitsOf, parseCapitalAccount } = require('../src/domain/account');

// real account fields: Vest shows Max. Daily Loss $0.00 / $196.36, Max. Drawdown $38.61 / $300
const real = parseCapitalAccount({
  id: 'R', initial_capital: '5000.00000000', max_drawdown_limit: '4700.00000000', daily_reset_balance: '4908.943943000000000',
  daily_reset_equity: '4924.805092793600000', daily_reset_base_limit: '196.3577577200000000', daily_loss_floor: '4712.586185280000000',
  max_daily_loss_pct: '0.040000',
});

test('real account: same numbers as the Vest page', () => {
  const L = limitsOf(real, { equity: 4961.39 });
  assert.strictEqual(L.dayLimit.toFixed(2), '196.36');
  assert.strictEqual(L.dayUsed, 0);
  assert.strictEqual(L.maxLimit, 300);
  assert.strictEqual(L.maxUsed.toFixed(2), '38.61');
});

test('daily: used = limit - room above the floor; without the field pct x balance at reset', () => {
  assert.strictEqual(limitsOf(real, { equity: 4850 }).dayUsed.toFixed(2), '58.94');
  const L = limitsOf({ ...real, dailyLimit: null }, { equity: 4850 });
  assert.strictEqual(L.dayLimit.toFixed(2), '196.36');
});

test('account without target and without daily limit', () => {
  const L = limitsOf({ initial: 100000, floor: 96000, dailyFloor: null, target: null }, { equity: 99000 });
  assert.ok(Number.isNaN(L.dayLimit));
  assert.ok(Number.isNaN(L.goal));
  assert.strictEqual(L.maxUsed, 1000);
});

test('room: daily = limit + P&L of the day, max = equity - total limit', () => {
  // Vest: daily limit 196.36 on the balance at reset 4908.94; equity 4961.39 -> P&L of the day +52.45, 248.81 left
  const L = limitsOf(real, { equity: 4961.39 });
  assert.strictEqual(L.dayPl.toFixed(2), '52.45');
  assert.strictEqual(L.dayLeft.toFixed(2), '248.80');
  assert.strictEqual((L.dayLimit + L.dayPl).toFixed(2), L.dayLeft.toFixed(2));
  assert.strictEqual(L.maxLeft.toFixed(2), '261.39');
  // down 150 on the day: ~46 left
  assert.strictEqual(limitsOf(real, { equity: 4758.94 }).dayLeft.toFixed(2), '46.35');
});
