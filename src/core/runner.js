// SAFE RUNNER (experimental) on the selected account's positions. Engine in domain/runner.js, research in research/.
// Modes: off / view (lines and status only, no orders) / live (orders). Live is never restored after a reload.
// How it works in live:
//  - before the profit reaches "start after" nothing is touched: the user's stop stays.
//  - then the size is split into tranches (tight / pause low / runner); at every live price (realtime since v0.20.12) each
//    tranche gets a stop from the engine (only forward); pause lows, ATR and climax from the closed 1m candles. The LOWEST of them (long) is the NATIVE stop on Vest, for the whole remaining
//    size: with the tab closed that one still protects (at entry + lock or better). The tranches above it are LOCAL:
//    when the price touches one, that tranche is reduced at market (this tab must be open).
//  - the runner keeps a wide stop only when the 1h trend guide is in favour (EMA20 above EMA50 for a long).
// Known limits: as trailing (tab open, Orders ON, mark every 0.5 s); one stop only on the position; if the size or the
// entry changes by hand the runner starts again from zero; candles from Vest's chart endpoint (1m refreshed at every
// close, 1h every 5 min).

const store = require('./store');
const orders = require('./orders');
const klines = require('./klines');
const O = require('../domain/orders');
const R = require('../domain/runner');
const TA = require('../domain/ta');
const Z = require('../domain/sizing');
const { roundToTick } = require('../domain/num');
const log = require('../diag/log');

const { S } = store;
const STALE_MS = 3000;
const MIN_GAP_MS = 1000;
const FAIL_WAIT_MS = 5000;
const SENT_HOLD_MS = 4000;
const st = new Map(); // positionId -> state
let cfgOf = () => ({});

const pnum = (v, def) => (v === '' || v == null || !Number.isFinite(+v) ? def : +v);
/** Panel settings -> engine settings. */
function engineCfg(c) {
  const run = Math.min(100, Math.max(0, pnum(c.srRunPct, 33))) / 100,
    pause = Math.min(100, Math.max(0, pnum(c.srPausePct, 0))) / 100;
  const tight = Math.max(0.05, pnum(c.srTight, 0.3));
  return {
    act: Math.max(0, pnum(c.srAct, 10)),
    lock: Math.max(0, pnum(c.srLock, 1)),
    tr: [{ r: null, m: tight }, { r: 1, m: null }, { r: null, m: tight }, { r: null, m: Math.max(0.1, pnum(c.srRunAtr, 3)) }],
    w: [Math.max(0, 1 - run - pause), pause, 0, run],
    htfGate: c.srGate !== false,
    climaxAtr: c.srClimax ? 2.5 : 99,
    climaxK: 0.6,
    buf: 0.2,
    pivotK: 2,
  };
}
const mode = () => {
  const m = cfgOf().srMode;
  return m === 'view' || m === 'live' ? m : 'off';
};
const NAMES = { t1: 'TIGHT', t2: 'PAUSE LOW', t3: 'TIGHT 2', run: 'RUNNER' };

function positions() {
  return ((S.state[S.selected] || {}).positions || []).filter((p) => p.qty > 0);
}

/** 1h trend guide in the direction of the side: EMA20 above EMA50 (long) on the last closed 1h candle. */
function htfOf(symbol, side) {
  const h = klines.get(symbol, '1h');
  if (h.length < 60) return { aligned: false, why: '1h candles not loaded yet' };
  const e20 = TA.emaSeries(h, 20),
    e50 = TA.emaSeries(h, 50);
  const a = e20[h.length - 1],
    b = e50[h.length - 1];
  return { aligned: side === 'long' ? a > b : a < b, e20: a, e50: b };
}

/** Engine on the closed candles (recomputed when a new candle closes). Returns the state s. */
function update(pos, s, c) {
  const bars = klines.get(pos.symbol, '1m');
  if (!bars.length) return (s.why = 'loading 1m candles'), s;
  const lastT = bars[bars.length - 1].t;
  const h1 = klines.get(pos.symbol, '1h');
  const h1T = h1.length ? h1[h1.length - 1].t : 0;
  // realtime (Gerry 2026-11-20 "non aspettando la chiusura candela"): the live price counts too, so the start and the stops
  // follow the price at once; pause lows, ATR and climax still come from the closed 1m candles
  const mk = S.marks[pos.symbol];
  const mark = mk && Date.now() - mk.at <= STALE_MS && Number.isFinite(mk.px) ? mk.px : undefined;
  if (s.lastBarT === lastT && s.h1T === h1T && s.res && s.mark === mark) return s; // recomputed at every new candle or price
  const entryMs = s.entryMs;
  let iEntry = 0;
  for (let i = 0; i < bars.length; i++) if (bars[i].t * 1000 <= entryMs) iEntry = i;
  if (bars[0].t * 1000 > entryMs) iEntry = 0; // entry older than the candles read: best from what is there
  const prev = s.res ? { ...s.res, iTop: s.topT != null ? bars.findIndex((b) => b.t === s.topT) : null } : null;
  if (prev && !(prev.iTop >= 0)) prev.iTop = null;
  if (h1.length < 60) return (s.why = 'loading 1h candles (trend guide)'), s;
  // trend guide read once, when the engine takes over (as in the tests): a later change does not widen the runner
  const htf = s.htfFixed || htfOf(pos.symbol, pos.side);
  const res = R.evaluate({ side: pos.side, entry: pos.openPrice, bars, iEntry, mark, prev, cfg: engineCfg(c), htf });
  s.mark = mark;
  if (res.active && !s.htfFixed) s.htfFixed = htf;
  s.res = res;
  s.htf = htf;
  s.topT = res.iTop >= 0 && bars[res.iTop] ? bars[res.iTop].t : s.topT;
  s.lastBarT = lastT;
  s.h1T = h1T;
  s.why = res.why || '';
  return s;
}

function fire(pos, order, label, s, now) {
  s.next = now + MIN_GAP_MS;
  return orders.send(S.selected, order, label, pos.id).catch((e) => {
    s.next = Date.now() + FAIL_WAIT_MS;
    log.error(`${label}: ${e.message}`);
  });
}

/** At every price. */
function check() {
  const c = cfgOf();
  const md = mode();
  const live = positions();
  for (const id of [...st.keys()]) if (!live.some((p) => p.id === id)) st.delete(id);
  if (md === 'off') return;
  const now = Date.now();
  for (const pos of live) {
    const sym = S.symbols[pos.symbol] || {};
    const tick = sym.tick,
      step = sym.step;
    let s = st.get(pos.id);
    // same entry / same size compared with a tolerance: REST gives the average entry rounded (26149.06) and the feed
    // in full (26149.0625); compared as text they looked like an add and the runner restarted at every update (seen on
    // Vest 2026-11-20, tranches thrown out again and again)
    const eqQ = (a, b) => Math.abs(a - b) < (step > 0 ? step / 2 : 1e-9);
    const eqPx = (a, b) => Math.abs(a - b) < (tick > 0 ? tick / 2 : 1e-6);
    let fresh = false;
    if (s) {
      if (eqPx(pos.openPrice, s.px) && eqQ(pos.qty, s.qty)) s.px = pos.openPrice;
      else if (s.expect && eqPx(pos.openPrice, s.px) && eqQ(pos.qty, s.expect.qty)) Object.assign(s, { qty: pos.qty, px: pos.openPrice, expect: null }); // our tranche out
      else if (eqPx(pos.openPrice, s.px) && pos.qty < s.qty) {
        // closed in part by hand: same trade, the open tranches shrink in proportion (what is left over goes to the last one)
        if (s.q) {
          const open = R.KEYS.filter((k) => !s.done.has(k));
          let used = 0;
          for (const k of open) {
            const v = step > 0 ? Math.floor(((s.q[k] * pos.qty) / s.qty) / step + 1e-9) * step : (s.q[k] * pos.qty) / s.qty;
            s.q[k] = +v.toFixed(10);
            used += s.q[k];
          }
          if (open.length) s.q[open[open.length - 1]] = +(s.q[open[open.length - 1]] + pos.qty - used).toFixed(10);
          for (const k of open) if (!(s.q[k] > 0)) s.done.add(k);
        }
        log.info(`SAFE RUNNER ${pos.symbol}: reduced by hand ${s.qty} -> ${pos.qty}, tranches resized`);
        Object.assign(s, { qty: pos.qty, px: pos.openPrice, expect: null });
      } else {
        // an add (or a new entry): a NEW trade from now on. The profit is counted from this moment, never from prices
        // seen before the add (seen on Vest: an add to a losing short took over at once on the old best price)
        log.info(`SAFE RUNNER ${pos.symbol}: size or entry changed (${s.qty} @ ${s.px} -> ${pos.qty} @ ${pos.openPrice}): starting again, profit counted from now`);
        s = null;
        fresh = true;
      }
    }
    if (!s) {
      const entryMs = !fresh && Number.isFinite(pos.openedAt) ? pos.openedAt : now;
      st.set(pos.id, (s = { qty: pos.qty, px: pos.openPrice, entryMs, q: null, done: new Set(), next: 0 }));
    }
    update(pos, s, c);
    const res = s.res;
    if (!res || !res.active || !res.stops || !(tick > 0)) continue;
    const d = pos.side === 'long' ? 1 : -1;
    // tranches fixed at the activation, on the size at that moment
    if (!s.q) {
      s.q = R.split(pos.qty, engineCfg(c).w, step);
      for (const k of R.KEYS) if (!(s.q[k] > 0)) s.done.add(k);
      log.warn(`SAFE RUNNER ${pos.symbol} ${pos.side.toUpperCase()} active: ` + R.KEYS.filter((k) => !s.done.has(k)).map((k) => `${NAMES[k]} ${s.q[k]}`).join(', ') + (s.htf && s.htf.aligned ? ' (1h trend in favour: runner wide)' : ' (1h trend NOT in favour: runner tight)'));
    }
    const open = R.KEYS.filter((k) => !s.done.has(k));
    if (!open.length) continue;
    const px = (k) => roundToTick(res.stops[k], tick, d > 0 ? 'down' : 'up');
    // native stop = the lowest (long) of the open tranches
    const nativeKey = open.reduce((a, k) => (d * (px(k) - px(a)) < 0 ? k : a), open[0]);
    const target = px(nativeKey);
    s.view = { open: open.map((k) => ({ k, price: px(k), qty: s.q[k], native: k === nativeKey })), native: target };
    if (md !== 'live' || !orders.enabled()) continue;
    if (c.trOn || c.beAuto) {
      s.why = 'switch off trailing and auto BE: they move the same stop';
      continue;
    }
    const mk = S.marks[pos.symbol];
    if (!mk || now - mk.at > STALE_MS || orders.busyOn(pos.id) || now < s.next) continue;
    const sls = pos.triggers.filter((t) => t.kind === 'sl');
    if (sls.length > 1) {
      s.why = 'more than one stop on the position: paused';
      continue;
    }
    const sl = sls[0] || null;
    let slPx = sl ? sl.price : null;
    if (s.sent != null && now - s.sentAt < SENT_HOLD_MS && (slPx == null || d * (s.sent - slPx) > 0)) slPx = s.sent;
    // 1) local tranches above the native stop: touched -> reduce that tranche at market
    for (const k of open) {
      if (k === nativeKey || d * (px(k) - target) < tick - 1e-9) continue;
      if (d * (mk.px - px(k)) > 0) continue;
      const left = +(pos.qty - s.q[k]).toFixed(10);
      if (!(left > 0)) break; // it would be all of it: the native stop / the close below handle it
      s.done.add(k);
      s.expect = { qty: left };
      fire(pos, Z.reduceOrder({ pos, qty: s.q[k], leverage: pos.leverage > 0 ? pos.leverage : O.DEFAULT_LEVERAGE, step }), `SAFE RUNNER: ${NAMES[k]} out, ${s.q[k]} at market (stop ${px(k)})`, s, now);
      s.next = now + SENT_HOLD_MS;
      break;
    }
    if (now < s.next) continue;
    // 2) native stop forward to the target
    if (slPx != null && d * (slPx - target) >= 0) continue; // already there or beyond
    if (d * (mk.px - target) <= 0) {
      // the price is already past the target: out at market, only while the price is in profit (as trailing)
      if (d * (mk.px - pos.openPrice) < tick - 1e-9) continue;
      log.warn(`SAFE RUNNER ${pos.symbol}: price ${mk.px} past the stop ${target}: closing at market`);
      fire(pos, O.closeOrder(pos), `SAFE RUNNER: close ${pos.side.toUpperCase()} ${pos.qty} ${pos.symbol}`, s, now);
      s.next = now + SENT_HOLD_MS;
      continue;
    }
    if (O.checkLeg({ kind: 'sl', side: pos.side, price: target, mark: mk.px, tick })) continue; // too close: next round
    // Vest checks the stop against the best ask (short) / best bid (long), not the mark: keep a margin for the spread
    // (seen on Vest 2026-11-20: "Stop loss trigger must be above best ask for a short position" with the mark 2 ticks away)
    const room = Math.max(4 * tick, 0.1 * (res.atr > 0 ? res.atr : 0));
    if (d * (mk.px - target) < room) continue;
    Object.assign(s, { sent: target, sentAt: now });
    fire(pos, O.legOrder(pos, 'sl', target, tick, sl), `SAFE RUNNER: stop ${sl ? sl.price + ' -> ' : 'at '}${target} (${NAMES[nativeKey]})`, s, now);
  }
}

/**
 * Lines for the chart: [{ key, price, text, color, dashed, length }] for the positions on the given market.
 * Kept away from the overlay labels (Gerry 2026-11-20: "si sovrappone tutto"): no line for the stop that is already the SL on
 * Vest (its SL label shows it), tranches at the same price merged into one line, labels further left (line 45% long).
 */
function lineSpecs(isChartSym) {
  if (mode() === 'off') return [];
  const out = [];
  const c = cfgOf();
  for (const pos of positions()) {
    if (!isChartSym(pos.symbol)) continue;
    const s = st.get(pos.id);
    if (!s || !s.res) continue;
    if (!s.res.active) {
      const tick = (S.symbols[pos.symbol] || {}).tick || 0.01;
      const a = roundToTick(pos.openPrice + (pos.side === 'long' ? 1 : -1) * engineCfg(c).act, tick, 'nearest');
      out.push({ key: 'sr:start:' + pos.id, price: a, text: 'SR start', qty: '', color: '#94a3b8', dashed: true, length: 45 });
      continue;
    }
    const v = s.view;
    if (!v) continue;
    const byPx = new Map();
    for (const t of v.open) {
      if (mode() === 'live' && t.price === v.native) continue; // that one is the SL on Vest
      if (!byPx.has(t.price)) byPx.set(t.price, []);
      byPx.get(t.price).push(t);
    }
    for (const [price, ts] of byPx) {
      const run = ts.some((t) => t.k === 'run');
      const col = run && ts.length === 1 ? (s.htf && s.htf.aligned ? '#a78bfa' : '#64748b') : ts.some((t) => t.k === 't2') ? '#f59e0b' : '#22d3ee';
      const qty = +ts.reduce((a, t) => a + t.qty, 0).toFixed(10);
      out.push({ key: `sr:${price}:${pos.id}`, price, text: 'SR ' + ts.map((t) => NAMES[t.k].toLowerCase()).join(' + '), qty: String(qty), color: col, dashed: true, length: 45 });
    }
  }
  return out;
}

/**
 * 1h trend guide of a market BEFORE any trade (Gerry 2026-11-20): which side would have the runner held wide.
 * -> { dir: 'up' | 'down' | null, text }. Reads the 1h candles (cached, refreshed every 5 min).
 */
function trend(symbol) {
  if (!symbol) return { dir: null, text: '' };
  const h = klines.get(symbol, '1h');
  if (h.length < 60) return { dir: null, text: '1h trend: loading candles' };
  const e20 = TA.emaSeries(h, 20),
    e50 = TA.emaSeries(h, 50);
  const a = e20[h.length - 1],
    b = e50[h.length - 1];
  const dir = a > b ? 'up' : 'down';
  const fav = dir === 'up' ? 'LONG' : 'SHORT';
  const gate = cfgOf().srGate !== false;
  return {
    dir,
    text: `1h trend ${dir === 'up' ? 'UP' : 'DOWN'} (EMA20 ${a.toFixed(2)} ${dir === 'up' ? '>' : '<'} EMA50 ${b.toFixed(2)}): in favour of ${fav}` +
      (gate ? `, runner wide only on a ${fav}` : ' (filter off: runner always wide)'),
  };
}

function status() {
  const md = mode();
  if (md === 'off') return null;
  const live = positions();
  if (!live.length) return `${md === 'live' ? 'LIVE' : 'VIEW'}: waiting for a position`;
  return live
    .map((p) => {
      const s = st.get(p.id);
      if (!s || !s.res) return `${p.symbol}: ${s && s.why ? s.why : 'starting'}`;
      if (md === 'live' && !orders.enabled()) return `${p.symbol}: Orders OFF (lines only)`;
      const noSl = !p.triggers.some((t) => t.kind === 'sl') ? ' · NO STOP on the position: the runner places one only after start, when the price allows' : '';
      if (noSl && !s.res.active) return `${p.symbol}: ${s.why || 'waiting'}${noSl}`;
      if (!s.res.active) return `${p.symbol}: ${s.why || 'waiting'}`;
      const parts = ((s.view && s.view.open) || []).map((t) => `${NAMES[t.k]} ${t.qty} @ ${t.price}${t.native ? ' (Vest)' : ''}`);
      return `${p.symbol}: ${parts.join(', ')}; 1h trend ${s.htf && s.htf.aligned ? 'in favour' : 'not in favour'}${s.why ? ' · ' + s.why : ''}${noSl}`;
    })
    .join(' · ');
}

module.exports = {
  check,
  status,
  trend,
  lineSpecs,
  engineCfg,
  setConfig: (fn) => (cfgOf = fn),
  wants: () => mode() !== 'off' && positions().length > 0,
};
