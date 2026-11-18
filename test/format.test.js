const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../src/ui/format');

test('dollars: sign, US separators, small amounts', () => {
  assert.equal(F.usd(-0.12, true), '−$0.12');
  assert.equal(F.usd(1234.5, true), '+$1,234.50');
  assert.equal(F.usdFine(0.00225), '$0.0023'); // 1 tick on 0.009 NQ: not "$0.00"
  assert.equal(F.usdFine(0.5), '$0.50');
  assert.equal(F.usdFine(12), '$12.00');
  assert.equal(F.usd(NaN), '—');
});
