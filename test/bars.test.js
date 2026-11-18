const test = require('node:test');
const assert = require('node:assert/strict');
const { resSec, nextClose, fmtLeft, parseExport, swings } = require('../src/chart/bars');

test('resolution -> seconds', () => {
  assert.equal(resSec('1'), 60);
  assert.equal(resSec('15'), 900);
  assert.equal(resSec('240'), 14400);
  assert.equal(resSec('30S'), 30);
  assert.equal(resSec('D'), 86400);
  assert.equal(resSec('1D'), 86400);
  assert.equal(resSec('W'), 604800);
  assert.equal(resSec(''), null);
  assert.equal(resSec('abc'), null);
  assert.equal(resSec('0'), null);
});

test('candle close: from the last candle, or aligned to UTC without candles', () => {
  const t0 = Date.UTC(2026, 10, 18, 10, 0, 0);
  // 5-minute candle opened at 10:00, now 10:03:20 -> closes 10:05
  assert.equal(nextClose('5', t0 / 1000, t0 + 200e3), t0 + 300e3);
  // last candle old (no trades since): next boundary after now
  assert.equal(nextClose('5', t0 / 1000, t0 + 610e3), t0 + 900e3);
  // no candles: aligned to multiples of 5 minutes
  assert.equal(nextClose('5', NaN, t0 + 61e3), t0 + 300e3);
  // monthly: first day of the next month
  assert.equal(nextClose('1M', Date.UTC(2026, 10, 1) / 1000, t0), Date.UTC(2026, 11, 1));
  assert.ok(Number.isNaN(nextClose('M', NaN, t0)));
  assert.ok(Number.isNaN(nextClose('x', NaN, t0)));
});

test('countdown text', () => {
  assert.equal(fmtLeft(65e3), '1:05');
  assert.equal(fmtLeft(3725e3), '1:02:05');
  assert.equal(fmtLeft(90000e3), '1d 01:00');
  assert.equal(fmtLeft(-1), '');
});

test('exportData: reads time, high and low of the series, ignores studies', () => {
  const d = {
    schema: [{ type: 'time' }, { type: 'value', sourceType: 'series', plotTitle: 'open' }, { type: 'value', sourceType: 'series', plotTitle: 'high' },
      { type: 'value', sourceType: 'series', plotTitle: 'low' }, { type: 'value', sourceType: 'study', plotTitle: 'high' }],
    data: [[120, 1, 5, 0.5, 99], [60, 1, 4, 1, 99], [180, 1, 3, 2, 99]],
  };
  assert.deepEqual(parseExport(d), [{ t: 60, h: 4, l: 1 }, { t: 120, h: 5, l: 0.5 }, { t: 180, h: 3, l: 2 }]);
  assert.equal(parseExport({ ...d, data: [[1.7e12, 1, 3, 2, 0]] })[0].t, 1.7e9); // milliseconds -> seconds
  assert.equal(parseExport({ schema: [{ type: 'time' }], data: [] }), null);
  assert.equal(parseExport(null), null);
});

test('last swing high / low: pivots with k candles on each side, then the price', () => {
  // rise to 15, pullback to 8, rise again (like a swing high followed by a swing low)
  const H = [10, 11, 12, 15, 13, 12, 11, 12, 13],
    L = [8, 9, 10, 12, 11, 9, 8, 10, 11];
  const b = H.map((h, i) => ({ t: i, h, l: L[i] }));
  assert.deepEqual(swings(b, 2, NaN), { h: 15, l: 8 });
  assert.deepEqual(swings(b, 2, 16), { h: 16, l: 8 }); // price above the swing high: the line follows it
  assert.deepEqual(swings(b, 2, 7), { h: 15, l: 7 });
  const k3 = swings(b, 3, NaN); // with 3 candles each side the low at 8 is not confirmed yet
  assert.equal(k3.h, 15);
  assert.ok(Number.isNaN(k3.l));
  assert.equal(swings([], 2, 9), null);
});

test('clock offset: highest lower bound from the new candles', () => {
  const { clockOffset } = require('../src/chart/bars');
  // PC 44 s behind: new candles seen 0.3 s, 2 s and 0.1 s after their open -> bounds 43.7, 42, 43.9 s
  assert.equal(clockOffset([43700, 42000, 43900]), 43900);
  assert.equal(clockOffset([-5200, -5050]), -5050); // PC ahead
  assert.ok(Number.isNaN(clockOffset([])));
});

test('timeframe names for the card', () => {
  const { tfLabel } = require('../src/chart/bars');
  assert.equal(tfLabel('1'), '1m');
  assert.equal(tfLabel('15'), '15m');
  assert.equal(tfLabel('60'), '1h');
  assert.equal(tfLabel('240'), '4h');
  assert.equal(tfLabel('D'), '1D');
  assert.equal(tfLabel('1W'), '1W');
  assert.equal(tfLabel('30S'), '30s');
  assert.equal(tfLabel('x'), '');
});

test('candles of a longer timeframe from shorter ones', () => {
  const { aggregate } = require('../src/chart/bars');
  const b = [
    { t: 0, h: 5, l: 3, c: 4 }, { t: 60, h: 7, l: 4, c: 6 }, { t: 120, h: 6, l: 2, c: 3 }, // 0-2 min
    { t: 300, h: 9, l: 8, c: 8.5 }, // next 5-minute bucket
  ];
  assert.deepEqual(aggregate(b, 300), [{ t: 0, h: 7, l: 2, c: 3 }, { t: 300, h: 9, l: 8, c: 8.5 }]);
});

test('true range uses the previous close (gaps count)', () => {
  const { trueRanges } = require('../src/chart/bars');
  const b = [{ t: 0, h: 10, l: 9, c: 10 }, { t: 1, h: 13, l: 12, c: 12 }, { t: 2, h: 12, l: 11, c: 11 }];
  assert.deepEqual(trueRanges(b), [3, 1]); // 13-10 (gap up), then high-low
});

test('ATR on 1h..1m over the same hours: ratio of the last candles to the whole span', () => {
  const { atrMtf } = require('../src/chart/bars');
  // 3 hours of 1-minute candles, range 1 point, with the last 5 minutes at 4 points (a burst), plus one forming candle
  const bars = [];
  for (let i = 0; i <= 180; i++) {
    const big = i >= 175 && i < 180;
    bars.push({ t: i * 60, h: 100 + (big ? 4 : 1), l: 100, c: 100 });
  }
  const out = atrMtf(bars, 60, 2, 3);
  const byTf = Object.fromEntries(out.map((c) => [c.label, c]));
  assert.equal(out.map((c) => c.label).join(','), '1h,30m,15m,5m,1m');
  assert.equal(byTf['1m'].ok, true);
  assert.ok(Math.abs(byTf['1m'].recent - 4) < 1e-9); // last 3 closed 1m candles: 4 points each
  assert.ok(byTf['1m'].ratio > 3); // the burst shows on 1m
  assert.ok(byTf['5m'].ratio > byTf['30m'].ratio); // and less and less on longer timeframes
  assert.equal(byTf['1h'].ok, false); // only 2 closed hours: not enough for 3 recent candles
  // chart on 5m: 1m cannot be built
  const five = atrMtf(bars.filter((b) => b.t % 300 === 0), 300, 2, 3);
  assert.equal(five.find((c) => c.label === '1m').ok, false);
});
