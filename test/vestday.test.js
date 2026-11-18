const test = require('node:test');
const assert = require('node:assert/strict');
const { vestDayStart, dayStartEquity } = require('../src/domain/vestday');

test('Vest day: 20:00 New York, daylight time (EDT, UTC-4)', () => {
  // 16 October 2026 09:30 UTC = 05:30 New York -> the day began on the 15th at 20:00 NY = 16th 00:00 UTC
  assert.equal(new Date(vestDayStart(Date.UTC(2026, 9, 16, 9, 30))).toISOString(), '2026-10-16T00:00:00.000Z');
  // 16 October 21:00 NY = 17th 01:00 UTC -> day began on the 16th at 20:00 NY
  assert.equal(new Date(vestDayStart(Date.UTC(2026, 9, 17, 1, 0))).toISOString(), '2026-10-17T00:00:00.000Z');
});

test('Vest day: standard time (EST, UTC-5)', () => {
  // 15 January 2026 15:00 UTC = 10:00 NY -> began on the 14th at 20:00 NY = 15th 01:00 UTC
  assert.equal(new Date(vestDayStart(Date.UTC(2026, 0, 15, 15, 0))).toISOString(), '2026-01-15T01:00:00.000Z');
});

test('Vest day: the new day starts exactly at 20:00 NY', () => {
  const t = Date.UTC(2026, 9, 17, 0, 0); // 16 October 20:00 NY
  assert.equal(vestDayStart(t), t);
});

test('opening equity: first point per account, order of the points irrelevant', () => {
  const r = dayStartEquity([
    { account_id: 'A', ts: 300, equity_value: '510' },
    { account_id: 'A', ts: 100, equity_value: '500' },
    { account_id: 'B', ts: 200, equity_value: '1000' },
    { account_id: 'C', ts: 50, equity_value: 'x' },
  ]);
  assert.deepEqual(r, { A: 500, B: 1000 });
});

test('Vest day: across DST changes (US, March and November 2026)', () => {
  // 8 March 2026 (DST starts 02:00 NY): at 10:00 NY = 14:00 UTC the day began on 7 March 20:00 EST = 8 March 01:00 UTC
  assert.equal(new Date(vestDayStart(Date.UTC(2026, 2, 8, 14, 0))).toISOString(), '2026-03-08T01:00:00.000Z');
  // 8 March 21:00 EDT = 9 March 01:00 UTC -> began 8 March 20:00 EDT = 9 March 00:00 UTC
  assert.equal(new Date(vestDayStart(Date.UTC(2026, 2, 9, 1, 0))).toISOString(), '2026-03-09T00:00:00.000Z');
  // 1 November 2026 (DST ends 02:00 NY): 10:00 EST = 15:00 UTC -> began 31 Oct 20:00 EDT = 1 Nov 00:00 UTC
  assert.equal(new Date(vestDayStart(Date.UTC(2026, 10, 1, 15, 0))).toISOString(), '2026-11-01T00:00:00.000Z');
  // first of the month before 20:00: the day began on the last day of the previous month
  assert.equal(new Date(vestDayStart(Date.UTC(2026, 6, 1, 12, 0))).toISOString(), '2026-07-01T00:00:00.000Z');
});
