// Candles of the chart's active timeframe, read from Vest's chart (TradingView Charting Library, public API):
// activeChart().resolution() for the timeframe, activeChart().exportData() for the candles.
// Used for the countdown to the candle close and for the last swing high / low. Read-only: no orders.
const log = require('../diag/log');

const UNIT = { '': 60, S: 1, D: 86400, W: 604800, M: 2592000 }; // M = 30 days, only to size the request

/** Seconds of a resolution ("1", "15", "240", "30S", "D", "1D", "W", "1M"...), or null when not recognised. */
function resSec(res) {
  const txt = String(res ?? '').trim().toUpperCase();
  const last = txt.slice(-1);
  const unit = 'SDWM'.includes(last) && last !== '' ? last : '';
  const digits = unit ? txt.slice(0, -1) : txt;
  if (!txt || !/^\d*$/.test(digits)) return null;
  const n = digits === '' ? 1 : Number(digits);
  return n > 0 ? n * UNIT[unit] : null;
}

/**
 * Close of the candle in formation, in ms. From the time of the last candle when known (follows the chart's own
 * alignment); otherwise aligned to multiples of the timeframe from 00:00 UTC. Months by calendar.
 */
function nextClose(res, lastT, now) {
  const sec = resSec(res);
  if (!sec) return NaN;
  const month = /M$/i.test(String(res).trim());
  if (month && Number.isFinite(lastT)) {
    const n = Number(String(res).trim().slice(0, -1)) || 1;
    const d = new Date(lastT * 1000);
    let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1);
    while (t <= now) t = Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth() + n, 1);
    return t;
  }
  if (month) return NaN;
  const ms = sec * 1000;
  if (Number.isFinite(lastT)) {
    let t = lastT * 1000 + ms;
    if (t <= now) t += Math.ceil((now - t + 1) / ms) * ms; // no new candle yet (no trades): the next boundary
    return t;
  }
  return Math.floor(now / ms) * ms + ms;
}

/** "m:ss", "h:mm:ss" or "Nd hh:mm". */
function fmtLeft(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  const p2 = (v) => String(v).padStart(2, '0');
  if (s >= 86400) return `${Math.floor(s / 86400)}d ${p2(Math.floor((s % 86400) / 3600))}:${p2(Math.floor((s % 3600) / 60))}`;
  if (s >= 3600) return `${Math.floor(s / 3600)}:${p2(Math.floor((s % 3600) / 60))}:${p2(s % 60)}`;
  return `${Math.floor(s / 60)}:${p2(s % 60)}`;
}

/** exportData answer -> [{ t (s), h, l, c? }] sorted by time, or null when the shape is not the expected one. */
function parseExport(d) {
  if (!d || !Array.isArray(d.schema) || !Array.isArray(d.data)) return null;
  const idx = (fn) => d.schema.findIndex(fn);
  const ti = idx((f) => f && f.type === 'time');
  const plot = (name) => idx((f) => f && f.type === 'value' && f.sourceType === 'series' && String(f.plotTitle).toLowerCase() === name);
  const hi = plot('high'),
    li = plot('low'),
    ci = plot('close');
  if (ti < 0 || hi < 0 || li < 0) return null;
  const out = [];
  for (const r of d.data) {
    const t0 = Number(r[ti]),
      t = t0 > 1e12 ? t0 / 1000 : t0, // seconds; milliseconds tolerated
      h = Number(r[hi]),
      l = Number(r[li]);
    if (!(Number.isFinite(t) && Number.isFinite(h) && Number.isFinite(l) && h >= l)) continue;
    const b = { t, h, l };
    if (ci >= 0 && Number.isFinite(Number(r[ci]))) b.c = Number(r[ci]);
    out.push(b);
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/**
 * Last swing high and last swing low. A swing high is a candle whose high is above the k candles before it and not
 * below the k candles after it (the low the other way round). From that candle on the line follows the price: if a
 * later candle or the live price goes past it, the line moves with it until a new swing is confirmed.
 * Returns { h, l } (NaN for a side with no swing in the candles read) or null without candles.
 */
function swings(bars, k, mark) {
  if (!bars || !bars.length || !(k >= 1)) return null;
  const n = bars.length;
  const pivot = (i, f, above) => {
    for (let d = 1; d <= k; d++) {
      const a = bars[i - d][f],
        b = bars[i + d][f],
        v = bars[i][f];
      if (above ? !(a < v && b <= v) : !(a > v && b >= v)) return false;
    }
    return true;
  };
  let hi = -1,
    lo = -1;
  for (let i = n - 1 - k; i >= k && (hi < 0 || lo < 0); i--) {
    if (hi < 0 && pivot(i, 'h', true)) hi = i;
    if (lo < 0 && pivot(i, 'l', false)) lo = i;
  }
  let h = NaN,
    l = NaN;
  if (hi >= 0) {
    h = -Infinity;
    for (let j = hi; j < n; j++) h = Math.max(h, bars[j].h);
    if (Number.isFinite(mark)) h = Math.max(h, mark);
  }
  if (lo >= 0) {
    l = Infinity;
    for (let j = lo; j < n; j++) l = Math.min(l, bars[j].l);
    if (Number.isFinite(mark)) l = Math.min(l, mark);
  }
  return { h, l };
}

/** Short name of a timeframe for the card: "1m", "15m", "1h", "4h", "1D", "1W", "1M", "30s". '' when unknown. */
function tfLabel(res) {
  const sec = resSec(res);
  if (!sec) return '';
  const u = String(res).trim().toUpperCase().slice(-1);
  const n = Number(String(res).trim().replace(/[SDWM]$/i, '')) || 1;
  if (u === 'S') return n + 's';
  if (u === 'D' || u === 'W' || u === 'M') return n + u;
  return sec % 3600 === 0 ? sec / 3600 + 'h' : sec / 60 + 'm';
}

// ── volatility on several timeframes over the SAME span of time (ATR = average true range)
const MTF = [60, 30, 15, 5, 1]; // minutes, from the longest to the shortest

/** Candles of tfSec seconds built from shorter ones (buckets aligned to multiples of tfSec from 00:00 UTC). */
function aggregate(bars, tfSec) {
  const out = [];
  for (const b of bars) {
    const t = Math.floor(b.t / tfSec) * tfSec;
    const cur = out[out.length - 1];
    if (cur && cur.t === t) {
      if (b.h > cur.h) cur.h = b.h;
      if (b.l < cur.l) cur.l = b.l;
      if (b.c !== undefined) cur.c = b.c;
    } else out.push({ t, h: b.h, l: b.l, ...(b.c !== undefined ? { c: b.c } : {}) });
  }
  return out;
}

/** True ranges of a candle series: max(high - low, |high - previous close|, |low - previous close|). */
function trueRanges(bars) {
  const tr = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i],
      pc = bars[i - 1].c;
    tr.push(Number.isFinite(pc) ? Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc)) : b.h - b.l);
  }
  return tr;
}

const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

/**
 * ATR on 1h, 30m, 15m, 5m and 1m over the same span of hours, built from the chart's candles (baseSec = chart timeframe).
 * For each timeframe: atr = average true range of the candles in the last `hours` (closed candles only), recent = the same
 * on the last `recentN` closed candles, ratio = recent / atr (above 1: that timeframe is speeding up).
 * A timeframe shorter than the chart's, or not a multiple of it, has no data (ok: false).
 */
function atrMtf(bars, baseSec, hours, recentN) {
  return MTF.map((min) => {
    const tfSec = min * 60;
    const label = min >= 60 ? min / 60 + 'h' : min + 'm';
    if (!bars || !bars.length || !(baseSec > 0) || tfSec < baseSec || tfSec % baseSec) return { label, ok: false };
    const closed = aggregate(bars, tfSec).slice(0, -1); // the last one is still forming
    const tr = trueRanges(closed);
    const span = Math.round((hours * 3600) / tfSec);
    const win = tr.slice(-span),
      rec = tr.slice(-recentN);
    if (rec.length < recentN || win.length < Math.max(recentN + 1, span / 2)) return { label, ok: false };
    const atr = mean(win),
      recent = mean(rec);
    return { label, ok: true, atr, recent, ratio: atr > 0 ? recent / atr : NaN, full: win.length >= span };
  });
}

// ── PC clock against Vest's clock. The PC clock can be off by many seconds (Windows syncs it rarely), and the countdown
//    then disagrees with Vest's. When a NEW candle shows up, the server's time is at least that candle's open time:
//    each new candle gives a lower bound of (server - PC). The highest of the last ones is the estimate; it is tight
//    when trades come right after the open (often, on a busy market) and the chart is read 4 times a second around it.
const CLK = { samples: [], off: NaN };
const CLK_KEEP = 10,
  CLK_MAX_MS = 6 * 3600e3; // a bigger gap is not a clock error: ignored

/** Estimate of (server time - PC time) in ms from the lower bounds collected, NaN with none. */
function clockOffset(samples) {
  return samples && samples.length ? Math.max(...samples) : NaN;
}

function noteNewBar(openSec, pcNow) {
  const lb = openSec * 1000 - pcNow;
  if (!Number.isFinite(lb) || Math.abs(lb) > CLK_MAX_MS) return;
  CLK.samples.push(lb);
  if (CLK.samples.length > CLK_KEEP) CLK.samples.shift();
  const before = CLK.off;
  CLK.off = clockOffset(CLK.samples);
  if (!Number.isFinite(before) || Math.abs(CLK.off - before) >= 1000) {
    const s = Math.round(CLK.off / 1000);
    log.info(Math.abs(s) < 1 ? 'PC clock in step with Vest' : `PC clock ${Math.abs(s)} s ${s > 0 ? 'behind' : 'ahead of'} Vest: clock and countdown corrected (sync the Windows clock to fix it)`);
  }
}

/** Current time on Vest's clock (PC time until the first new candle has been seen). */
function serverNow() {
  return Date.now() + (Number.isFinite(CLK.off) ? CLK.off : 0);
}

// ── reading from the chart: one request per second (4 per second around the candle close), only the candles needed
const R = { key: '', bars: null, at: 0, busy: false, err: '', atrHours: 0 };
const POLL_MS = 1000,
  FAST_MS = 250,
  LOOKBACK = 300, // candles read: enough to find a swing on any timeframe
  HUNG_MS = 10000;

function refresh(chart, nMin) {
  const now = Date.now();
  if (R.busy && now - R.at < HUNG_MS) return;
  let res, sym;
  try {
    res = chart.resolution();
    sym = chart.symbol();
  } catch {
    return;
  }
  // faster around the close of the candle, to see the new one as soon as it appears
  const sec0 = resSec(res);
  const lastT = R.bars && R.bars.length ? R.bars[R.bars.length - 1].t : NaN;
  const left = sec0 && Number.isFinite(lastT) ? nextClose(res, lastT, serverNow()) - serverNow() : NaN;
  const fast = left < 1500 || left > sec0 * 1000 - 2500;
  if (now - R.at < (fast ? FAST_MS : POLL_MS)) return;
  const key = sym + '|' + res;
  if (key !== R.key) {
    R.key = key;
    R.bars = null;
  }
  R.at = now;
  if (typeof chart.exportData !== 'function') return fail('exportData missing on this chart');
  const sec = resSec(res) || 60;
  const n = Math.max(nMin, Math.ceil((((R.atrHours || 0) + 2) * 3600) / sec)); // ATR span + the current hour
  const from = Math.floor(now / 1000 - (Math.min(n, 5000) + 5) * sec);
  R.busy = true;
  let p;
  try {
    p = Promise.resolve(chart.exportData({ from, includeTime: true, includeSeries: true, includedStudies: [] }));
  } catch (e) {
    R.busy = false;
    return fail(e.message);
  }
  p.then(
    (d) => {
      if (R.key !== key) return;
      const bars = parseExport(d);
      if (!bars) return fail('unexpected candle data');
      const prev = R.bars && R.bars.length ? R.bars[R.bars.length - 1].t : NaN;
      const last = bars.length ? bars[bars.length - 1].t : NaN;
      if (Number.isFinite(prev) && last > prev) noteNewBar(last, Date.now()); // a new candle: clock sample
      R.bars = bars;
      R.err = '';
    },
    (e) => fail(e && e.message ? e.message : String(e)),
  ).finally(() => (R.busy = false));
}

function fail(msg) {
  if (R.err !== msg) log.warn('Chart candles: ' + msg + ' (no countdown alignment and no swing lines)');
  R.err = msg;
  R.bars = null;
}

// recomputed only when new candles arrive or the settings change (the overlay asks at every frame)
const M = { bars: null, key: '', out: null };
function mtfCached(baseSec, hours, recent) {
  const key = baseSec + '|' + hours + '|' + recent;
  if (M.bars !== R.bars || M.key !== key) {
    M.bars = R.bars;
    M.key = key;
    M.out = atrMtf(R.bars, baseSec, hours, recent);
  }
  return M.out;
}

/**
 * For the active chart: { left: countdown text, tf: timeframe name, hl: last swing { h, l } | null,
 * mtf: ATR per timeframe | null }. k = candles on each side of a swing; atr = { hours, recent } or null when off.
 */
function view(chart, k, mark, atr) {
  const K = Math.max(1, Math.min(50, Math.round(k) || 2));
  R.atrHours = atr ? atr.hours : 0;
  refresh(chart, LOOKBACK);
  let res = null;
  try {
    res = chart.resolution();
  } catch {
    /* no resolution: no countdown */
  }
  const now = serverNow();
  const last = R.bars && R.bars.length ? R.bars[R.bars.length - 1].t : NaN;
  const close = res != null ? nextClose(res, last, now) : NaN;
  const txt = fmtLeft(close - now);
  // "~" until the PC clock has been compared with Vest's (first new candle)
  return {
    left: txt && !Number.isFinite(CLK.off) ? '~' + txt : txt,
    tf: res != null ? tfLabel(res) : '',
    hl: swings(R.bars, K, mark),
    mtf: atr && R.bars ? mtfCached(resSec(res), atr.hours, atr.recent) : null,
  };
}

module.exports = { resSec, nextClose, fmtLeft, parseExport, swings, tfLabel, aggregate, trueRanges, atrMtf, clockOffset, serverNow, view };
