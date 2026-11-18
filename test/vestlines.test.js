const test = require('node:test');
const assert = require('node:assert/strict');
const vl = require('../src/chart/vestlines');

// fake lines with the methods on the prototype, like TradingView's
const SET = ['setPrice', 'setText', 'setQuantity', 'setLineColor', 'setBodyBorderColor', 'setLineLength'];
class Line { constructor() { this.p = {}; } remove() {} getPrice() { return this.p.setPrice && this.p.setPrice[0]; } }
for (const n of SET) Line.prototype[n] = function (...a) { this.p[n] = a; return this; };
const chart = { createOrderLine: () => new Line(), createPositionLine: () => new Line() };
vl.wrap(chart);
// rule as in main.js: position always, stop/target only if the price matches an overlay leg
const legs = [30084, 30039.5];
vl.setPolicy((cls, price) => cls === 'pnl' || (cls === 'leg' && legs.some((p) => Math.abs(p - price) <= 0.125)));

test('Vest lines: TP/SL recognised by text even with a length other than 20%', () => {
  const tp = chart.createOrderLine().setText('TP +$0.24').setLineLength(60, 'percentage').setPrice(30084).setLineColor('#0f0');
  const sl = chart.createOrderLine().setText('SL −$0.16').setPrice(30039.5).setLineColor('#f00');
  assert.equal(tp.p.setPrice[0], 0.01); // parked: the axis label disappears too
  assert.equal(tp.p.setLineColor[0], 'rgba(0,0,0,0)');
  assert.equal(sl.p.setPrice[0], 0.01);
});

test('Vest lines: position hidden, limit order at another price untouched, ours never', () => {
  const pnl = chart.createPositionLine().setText('PnL −$0.02').setPrice(30057.5);
  assert.equal(pnl.p.setPrice[0], 0.01);
  const lim = chart.createOrderLine().setText('Limit').setPrice(30000).setLineColor('#888');
  assert.equal(lim.p.setPrice[0], 30000);
  const ours = vl.own(() => chart.createOrderLine().setText('PnL ours').setPrice(30057.5));
  assert.equal(ours.p.setPrice[0], 30057.5);
});

test('Vest lines: restored at the real price when the overlay no longer replaces them', () => {
  const tp = chart.createOrderLine().setText('TP +$0.24').setPrice(30084).setLineColor('#0f0');
  tp.setPrice(30090); // Vest moves it while it is hidden
  vl.setPolicy(() => false);
  assert.equal(tp.p.setPrice[0], 30090);
  assert.equal(tp.p.setLineColor[0], '#0f0');
});

test('line diagnostics: counts per type and first word, without amounts', () => {
  const st = vl.stats();
  assert.ok(st.seen > 0);
  assert.ok(st.words.TP >= 1 && st.words.PnL >= 1);
  assert.ok(!JSON.stringify(st).includes('0.24')); // no amounts
});

test('tradingViewApi hook: a chart obtained later comes out already hooked', () => {
  const fresh = { createOrderLine: () => new Line(), createPositionLine: () => new Line() };
  const api = { activeChart: () => fresh };
  vl.wrapApi(api);
  vl.setPolicy((cls) => cls === 'pnl');
  const l = api.activeChart().createPositionLine().setText('PnL +$1').setPrice(100);
  assert.equal(l.p.setPrice[0], 0.01);
});

test('Vest lines: pending orders ("BUY LIMIT", "SELL LIMIT") recognised and hidden', () => {
  vl.setPolicy((cls) => cls === 'order');
  const lim = chart.createOrderLine().setText('BUY LIMIT').setQuantity('0.092').setPrice(19950).setLineColor('#0f0');
  const sell = chart.createOrderLine().setText('SELL LIMIT').setPrice(20100).setLineColor('#f00');
  const other = chart.createOrderLine().setText('Alert').setPrice(20000).setLineColor('#888');
  assert.equal(lim.p.setPrice[0], 0.01);
  assert.equal(sell.p.setPrice[0], 0.01);
  assert.equal(other.p.setPrice[0], 20000);
});
