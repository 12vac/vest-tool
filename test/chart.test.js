const test = require('node:test');
const assert = require('node:assert/strict');
global.document = { querySelectorAll: () => [] }; // tv.js does not touch the DOM when loaded
const tv = require('../src/chart/tv');

test('chart symbol: exact match by name, never by similarity', () => {
  const symbols = { 'NDX-USD-PERP': { aliases: ['NDX-USD-PERP', 'NQ', 'NDX'] }, 'SPX-USD-PERP': { aliases: ['SPX-USD-PERP', 'ES'] } };
  assert.equal(tv.marketOfChart('NQ', symbols), 'NDX-USD-PERP');
  assert.equal(tv.marketOfChart('VEST:NQ', symbols), 'NDX-USD-PERP');
  assert.equal(tv.marketOfChart('ES', symbols), 'SPX-USD-PERP');
  assert.equal(tv.marketOfChart('NQH', symbols), null);
  assert.equal(tv.marketOfChart('N', symbols), null);
  assert.equal(tv.marketOfChart(null, symbols), null);
});
