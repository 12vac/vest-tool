// Vest trading day: it starts at 20:00 New York time. PURE.
// US daylight saving time is handled by Intl, not by hand.

const NY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});
const DAY_START_HOUR = 20;

/** New York wall clock at instant ms: { year, month (1-12), day, hour, minute, second }. */
function nyClock(ms) {
  const out = {};
  for (const part of NY.formatToParts(new Date(ms))) if (part.type !== 'literal') out[part.type] = Number(part.value);
  return out;
}

/** Offset of New York from UTC at instant ms (negative: behind UTC). */
function nyOffset(ms) {
  const c = nyClock(ms);
  const asUtc = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second);
  return asUtc - (ms - (((ms % 1000) + 1000) % 1000));
}

/** UTC instant of a New York wall-clock time (day may be 0 or negative: Date.UTC rolls it back). */
function nyToUtc(year, month, day, hour) {
  const naive = Date.UTC(year, month - 1, day, hour);
  let t = naive - nyOffset(naive);
  t = naive - nyOffset(t); // second pass: right offset when the guess fell across a DST change
  return t;
}

/** Instant (ms) at which the Vest day containing "now" began. */
function vestDayStart(now) {
  const c = nyClock(now);
  const dayOfStart = c.hour >= DAY_START_HOUR ? c.day : c.day - 1;
  return nyToUtc(c.year, c.month, dayOfStart, DAY_START_HOUR);
}

/**
 * Opening equity of the day per account, from the performance series: the earliest point of each account.
 * items = response of /v3/trading-performance/series from vestDayStart to now. Returns { accountId: equity }.
 */
function dayStartEquity(items) {
  const earliest = new Map();
  for (const point of items || []) {
    const equity = Number.parseFloat(point.equity_value);
    if (!point.account_id || Number.isNaN(equity) || !Number.isFinite(equity)) continue;
    const ts = Number(point.ts) || 0;
    const seen = earliest.get(point.account_id);
    if (seen === undefined || ts < seen.ts) earliest.set(point.account_id, { ts, equity });
  }
  const out = {};
  for (const [id, p] of earliest) out[id] = p.equity;
  return out;
}

module.exports = { vestDayStart, dayStartEquity, etOffset: (d) => nyOffset(+d) };
