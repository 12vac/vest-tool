const test = require('node:test');
const assert = require('node:assert');
const { rowPoints, closedPoints, closedPointsAt, sumSince, sumPoints, msOf } = require('../src/domain/daypts');

const t = Date.UTC(2026, 9, 23, 12, 0);

test('points of closed positions, in their direction', () => {
  const rows = [
    { positionId: 'P1', side: 'long', openPrice: '29000', closePrice: '29012.5', closeDate: t }, // +12.5
    { positionId: 'P2', side: 'short', openPrice: '29100', closePrice: '29104', closeDate: new Date(t).toISOString() }, // -4
    { positionId: 'P3', side: 'long', openPrice: '29000', closePrice: '29001', closeDate: null }, // open: excluded
    { positionId: 'P4', side: 'long', openPrice: '28866.37', closePrice: '0.01', closeDate: t }, // anomalous: excluded
    { positionId: 'P5', side: 'long', openPrice: '0', closePrice: '29000', closeDate: t }, // no entry (placeholder): excluded
  ];
  const m = closedPoints(rows);
  assert.deepStrictEqual(Object.keys(m).sort(), ['P1', 'P2']);
  assert.ok(Math.abs(sumPoints(m) - 8.5) < 1e-9);
  assert.strictEqual(rowPoints(null), null);
});

test('points of the day: only those closed from t0 on', () => {
  const rows = [
    { positionId: 'P1', side: 'long', openPrice: '29000', closePrice: '29012.5', closeDate: t }, // +12.5 today
    { positionId: 'P2', side: 'short', openPrice: '29100', closePrice: '29104', closeDate: t - 86400000 }, // -4 yesterday
  ];
  const m = closedPointsAt(rows);
  assert.deepStrictEqual(m.P1, { pts: 12.5, at: t });
  assert.deepStrictEqual(sumSince(m, t - 3600e3), { pts: 12.5, n: 1 });
  assert.deepStrictEqual(sumSince(m, 0), { pts: 8.5, n: 2 });
});

test('dates in seconds, ms or text', () => {
  assert.strictEqual(msOf(1761177600), 1761177600000);
  assert.strictEqual(msOf(1761177600000), 1761177600000);
  assert.ok(Number.isNaN(msOf(null)));
});
