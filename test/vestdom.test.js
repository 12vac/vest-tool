const test = require('node:test');
const assert = require('node:assert/strict');

// minimal DOM: only what vestdom uses
const kids = [];
global.document = {
  head: { appendChild: (el) => kids.push(el) },
  createElement: () => ({ textContent: '', remove() { kids.splice(kids.indexOf(this), 1); } }),
};
const vd = require('../src/chart/vestdom');

test('Vest TP/SL buttons: CSS rule on chart-chip only, added and removed once', () => {
  assert.match(vd.RULE, /data-testid\^="chart-chip-"/);
  vd.setHidden(true);
  vd.setHidden(true);
  assert.equal(kids.length, 1); // never duplicated
  vd.setHidden(false);
  assert.equal(kids.length, 0);
});
