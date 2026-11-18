// Vest's lines on the chart: intercepted (createOrderLine/createPositionLine on the chart object) to HIDE the position line
// and the SL/TP lines that our overlay replaces. Hiding = transparent colours + price "parked" off scale (the axis label
// disappears too). Always reversible.
// Limit: lines Vest creates BEFORE we hook the chart cannot be found (we do not look inside React).

const log = require('../diag/log');

const GHOST = 'rgba(0,0,0,0)';
const PARK = 0.01;
const REEVALUATE = new Set(['setText', 'setPrice', 'setQuantity']);
const recs = new Set(); // { line, type, args: {setter: [args]}, orig: {setter: fn}, ghosted, dead }
let ownDepth = 0; // >0 while we create OUR lines: they must not be registered
let wrapped = new WeakSet();
let wantGhost = () => false; // set by overlay: decides which Vest lines to hide

const get = (line, name) => {
  try {
    return typeof line[name] === 'function' ? line[name]() : undefined;
  } catch {
    return undefined;
  }
};

function patch(rec) {
  const line = rec.line;
  const names = new Set();
  for (let o = line, i = 0; o && o !== Object.prototype && i < 5; i++, o = Object.getPrototypeOf(o)) {
    try {
      Object.getOwnPropertyNames(o).forEach((n) => names.add(n));
    } catch {
      /* nothing */
    }
  }
  for (const n of names) {
    if (!/^(set[A-Z]|remove$)/.test(n)) continue;
    const f = line[n];
    if (typeof f !== 'function') continue;
    rec.orig[n] = f;
    const swallow = /^set.*Color$/.test(n) || n === 'setPrice';
    const replacement = (...callArgs) => {
      rec.args[n] = callArgs;
      if (n === 'remove') {
        rec.dead = true;
        recs.delete(rec);
      }
      // hidden: Vest keeps updating, we remember the real value and apply the "invisible" one
      if (swallow && rec.ghosted) {
        f.call(line, n === 'setPrice' ? PARK : GHOST);
        return line;
      }
      const out = Reflect.apply(f, line, callArgs);
      if (REEVALUATE.has(n)) evaluate(rec);
      return out;
    };
    try {
      line[n] = replacement;
    } catch {
      rec.patchFail = true;
    }
  }
}

/** Class of a Vest line: 'pnl' (position), 'leg' (position stop/target), 'other'. */
function classOf(rec) {
  const text = String((rec.args.setText && rec.args.setText[0]) ?? get(rec.line, 'getText') ?? '');
  if (/^\s*PnL/i.test(text)) return 'pnl';
  // on the site Vest's stops/targets have text "TP +$0.24" / "SL −$0.16" and a length other than 20%
  if (/^\s*(TP|SL|Take\s*profit|Stop\s*loss)\b/i.test(text)) return 'leg';
  // Vest pending orders: "BUY LIMIT" / "SELL LIMIT" with quantity and X (seen on the site)
  if (/^\s*(BUY|SELL)\b/i.test(text)) return 'order';
  const len = rec.args.setLineLength;
  // Vest draws position SL/TP as order lines 20% long (seen on the site)
  if (rec.type === 'order' && len && Number(len[0]) === 20 && /^percent/i.test(String(len[1]))) return 'leg';
  return 'other';
}

const priceOf = (rec) => {
  const raw = rec.args.setPrice ? rec.args.setPrice[0] : get(rec.line, 'getPrice');
  const price = Number(raw);
  return raw !== null && raw !== '' && Number.isFinite(price) ? price : null;
};

function ghost(rec) {
  if (rec.dead || rec.ghosted) return;
  rec.ghosted = true;
  for (const n of Object.keys(rec.orig)) {
    try {
      if (/^set.*Color$/.test(n)) {
        if (!rec.args[n]) {
          const g = get(rec.line, 'get' + n.slice(3));
          if (g === undefined) continue; // not restorable: we leave it alone
          rec.args[n] = [g];
        }
        rec.orig[n].call(rec.line, GHOST);
      }
    } catch {
      /* nothing */
    }
  }
  try {
    if (rec.orig.setPrice && rec.args.setPrice == null) {
      const p = get(rec.line, 'getPrice');
      if (p !== undefined) rec.args.setPrice = [p];
    }
    if (rec.orig.setPrice && rec.args.setPrice) rec.orig.setPrice.call(rec.line, PARK);
  } catch {
    /* nothing */
  }
}

function unghost(rec) {
  if (!rec.ghosted) return;
  rec.ghosted = false;
  if (rec.dead) return;
  for (const n of Object.keys(rec.orig)) {
    if (!(/^set.*Color$/.test(n) || n === 'setPrice') || !rec.args[n]) continue;
    try {
      rec.orig[n].apply(rec.line, rec.args[n]);
    } catch {
      /* nothing */
    }
  }
}

function evaluate(rec) {
  if (rec.dead) return;
  const want = wantGhost(classOf(rec), priceOf(rec));
  if (want) ghost(rec);
  else unghost(rec);
}

/** Replaces obj[name] with wrap(original) as a non-enumerable property; false if it is not a function. */
function redefine(obj, name, wrapFn) {
  const original = obj[name];
  if (typeof original !== 'function') return false;
  Object.defineProperty(obj, name, { configurable: true, writable: true, enumerable: false, value: wrapFn(original) });
  return true;
}

/** Registers a line Vest just created and applies the hiding rule to it. */
function adopt(line, type) {
  if (ownDepth > 0 || !line || typeof line !== 'object') return;
  try {
    const rec = { line, type, args: {}, orig: {}, ghosted: false, dead: false };
    patch(rec);
    recs.add(rec);
    evaluate(rec);
  } catch {
    /* never break Vest's chart */
  }
}

/** Hooks a chart (idempotent). Returns true if Vest's future lines go through us. */
function wrap(chart) {
  if (!chart || wrapped.has(chart)) return !!chart;
  try {
    const kinds = { createOrderLine: 'order', createPositionLine: 'position' };
    for (const [name, type] of Object.entries(kinds)) {
      redefine(chart, name, (create) => (...args) => {
        const line = Reflect.apply(create, chart, args);
        adopt(line, type);
        return line;
      });
    }
    wrapped.add(chart);
    log.info('Chart hooked: new Vest lines go through the tool');
    return true;
  } catch (e) {
    log.warn('Hooking Vest lines failed: ' + e.message);
    return false;
  }
}

/**
 * Also hooks the tradingViewApi object: every chart Vest gets LATER (activeChart(), chart(i)) comes out already hooked,
 * even if TradingView returned a new object at each call. Lines created before stay out (known limit).
 */
const wrappedApis = new WeakSet();
function wrapApi(api) {
  if (!api || wrappedApis.has(api)) return;
  wrappedApis.add(api);
  for (const name of ['activeChart', 'chart']) {
    try {
      redefine(api, name, (getChart) => (...args) => {
        const chart = Reflect.apply(getChart, api, args);
        if (chart && typeof chart === 'object') {
          try {
            wrap(chart);
          } catch {
            /* never break Vest's chart */
          }
        }
        return chart;
      });
    } catch {
      /* property not redefinable: the direct chart hook remains */
    }
  }
}

/** Creates OUR lines without them being treated as Vest's. */
function own(fn) {
  ownDepth++;
  try {
    return fn();
  } finally {
    ownDepth--;
  }
}

/** New rule (from overlay) and re-evaluation of all known lines. */
function setPolicy(fn) {
  wantGhost = fn;
  for (const rec of recs) evaluate(rec);
}

function restoreAll() {
  for (const rec of recs) unghost(rec);
}

// for diagnostics: how many Vest lines per type (first word of the text, never amounts) and how many hidden
const stats = () => {
  let ghosted = 0;
  const byClass = {},
    words = {};
  for (const r of recs) {
    if (r.ghosted) ghosted++;
    const c = classOf(r);
    byClass[c] = (byClass[c] || 0) + 1;
    const w = String((r.args.setText && r.args.setText[0]) ?? get(r.line, 'getText') ?? '').trim().split(/[\s$+−-]/)[0].slice(0, 12) || '(vuoto)';
    words[w] = (words[w] || 0) + 1;
  }
  return { seen: recs.size, ghosted, byClass, words };
};

module.exports = { wrap, wrapApi, own, setPolicy, restoreAll, stats };
