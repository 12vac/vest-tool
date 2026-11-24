// Closed candles of a market from Vest's public chart endpoint (GET /v2/klines, the same the chart uses; no token).
// Read-only. Used by the safe runner: 1m candles (stops recomputed at every close) and 1h candles (trend guide).
// The answer holds about 500 candles, newest first, the last one still forming: that one is dropped.

const transport = require('./transport');
const log = require('../diag/log');

const cache = new Map(); // symbol|interval -> { bars, at, busy }
const SEC = { '1m': 60, '1h': 3600 };

/** Vest rows [openMs, o, h, l, c, vol, closeMs, ...] -> closed candles [{ t (s), o, h, l, c }] ascending. */
function parse(rows, nowMs) {
  const out = [];
  for (const r of rows || []) {
    if (!Array.isArray(r) || r.length < 5) continue;
    const t = +r[0],
      close = r[6] != null ? +r[6] : NaN;
    const b = { t: t / 1000, o: +r[1], h: +r[2], l: +r[3], c: +r[4] };
    if (!(Number.isFinite(b.t) && b.h >= b.l && b.l > 0)) continue;
    if (Number.isFinite(close) ? close > nowMs : t + 60000 > nowMs) continue; // still forming
    out.push(b);
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/**
 * Closed candles, refreshed when a new candle should have closed (plus 2 s for Vest to publish it).
 * Returns the cached array at once (maybe empty / old) and refreshes in the background; onFresh() after a refresh.
 */
function get(symbol, interval, onFresh) {
  const key = symbol + '|' + interval;
  let c = cache.get(key);
  if (!c) cache.set(key, (c = { bars: [], at: 0, busy: false }));
  const step = (SEC[interval] || 60) * 1000;
  const now = Date.now();
  const last = c.bars.length ? c.bars[c.bars.length - 1].t * 1000 : 0;
  const due = !c.bars.length || now >= last + 2 * step + 2000; // the candle after the last one we have has closed
  const retry = now - c.at > (interval === '1h' ? 300000 : 15000); // also every 15 s (1h: 5 min) if nothing new came
  if ((due && now - c.at > 3000) || retry) {
    if (!c.busy) {
      c.busy = true;
      c.at = now;
      transport
        .request(`/v2/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}`)
        .then((res) => {
          const bars = parse(res && res.data, Date.now());
          if (bars.length) c.bars = bars;
          if (onFresh) onFresh(key);
        })
        .catch((e) => log.warn(`candles ${symbol} ${interval}: ${e.message}`))
        .finally(() => (c.busy = false));
    }
  }
  return c.bars;
}

module.exports = { get, parse };
