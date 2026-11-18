const test = require('node:test');
const assert = require('node:assert');
const { microOf } = require('../src/domain/micro');

test('Vest size in CME micros', () => {
  assert.deepStrictEqual(microOf(0.8391, 'NQ'), { qty: 0.41955, name: 'MNQ' });
  assert.deepStrictEqual(microOf(1, null, 'NDX-USD-PERP'), { qty: 0.5, name: 'MNQ' });
  assert.strictEqual(microOf(1, 'ES').name, 'MES');
  assert.strictEqual(microOf(1, 'BTC'), null);
  assert.strictEqual(microOf(0, 'NQ'), null);
});
