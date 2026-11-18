// Single in-memory state: accounts, state per account (REST or feed), prices, feed/chart health.
// Readers subscribe(); notifications are batched (at most every 250 ms).

const A = require('../domain/account');
const { vestDayStart } = require('../domain/vestday');
const log = require('../diag/log');

const ALIAS_KEY = 'vt1:alias'; // names given by the user to accounts (id -> name): labels only, no amounts
const SESSION_KEY = 'vt1:session'; // localStorage shared with Vest: prefix and minimal data (only start-of-day equity)

const S = {
  accounts: {}, // id -> fixed data (parseCapitalAccount)
  state: {}, // id -> { free, balVer, seq, positions, ordersCollateral, orders, restAt, feedAt }
  perf: {}, // id -> { equity, upnl } from the performance series
  vestNames: {}, // accountId -> name given on Vest (GET /v3/user-state)
  levs: {}, // accountId -> { symbol: leverage saved on Vest } (GET /v3/user-state)
  flattening: false,
  day: null, // { start, at, startEq: { id: equity } } opening equity of the Vest day (20:00 New York)
  marks: {}, // symbol -> { px, at }
  symbols: {}, // symbol -> { tick, step, label }
  feed: { attached: 0, lastAt: 0, open: false, stateAt: 0, missing: [] },
  chart: { ok: false, why: 'not searched yet', symbol: null },
  checks: [], // [{ key, name, level: 'pass'|'warn'|'fail'|'wait', msg }]
  selected: null,
  lastSync: 0,
  syncError: null,
};

let session = null;
try {
  session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
} catch {
  session = null;
}

let aliases = {};
try {
  aliases = JSON.parse(localStorage.getItem(ALIAS_KEY) || '{}') || {};
} catch {
  aliases = {};
}
/** Account name: the one given in the panel, if any. */
const aliasOf = (id) => (typeof aliases[id] === 'string' && aliases[id].trim() ? aliases[id].trim().slice(0, 40) : null);
function setAlias(id, name) {
  const n = String(name || '').trim().slice(0, 40);
  if (n) aliases[id] = n;
  else delete aliases[id];
  try {
    localStorage.setItem(ALIAS_KEY, JSON.stringify(aliases));
  } catch {
    /* nothing */
  }
  const a = S.accounts[id];
  if (a) a.label = n || a.autoLabel;
  changed();
}

const subs = new Set();
let timer = null;
function changed() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    for (const fn of subs) {
      try {
        fn(S);
      } catch (e) {
        log.error('render: ' + e.message);
      }
    }
  }, 250);
}

const FEED_QUIET_MS = 75000;
const feedLive = () => S.feed.open && Date.now() - S.feed.lastAt < FEED_QUIET_MS;

/** $ values of an account, with session P&L. */
function values(id) {
  const acc = S.accounts[id];
  if (!acc) return null;
  const marks = Object.fromEntries(Object.entries(S.marks).map(([k, v]) => [k, v.px]));
  const dayEq = S.day && S.day.start === vestDayStart(Date.now()) ? S.day.startEq[id] : NaN; // day changed: old base, do not use it
  const v = A.valuesOf(acc, S.state[id], marks, S.perf[id], dayEq);
  if (v.equity >= 0) {
    const day = A.localDay(new Date());
    const next = A.sessionBaseline(session, day, id, v.equity);
    if (!session || next.day !== session.day || next.start[id] !== session.start[id]) {
      session = next;
      try {
        localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      } catch {
        /* storage full or blocked: the session holds only for this tab */
      }
    }
  }
  const base = session && session.start[id];
  v.sessionPnl = base >= 0 && v.equity >= 0 ? v.equity - base : NaN;
  return v;
}

function resetSession() {
  session = null;
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* nothing */
  }
  log.info('Session P&L reset: new base = current equity');
  changed();
}

/** Symbols with open positions on any account. */
const heldSymbols = () => [...new Set(Object.values(S.state).flatMap((st) => (st ? st.positions.map((p) => p.symbol) : [])))];

/**
 * What an account has open (dot next to the name). lvl: 'free' nothing, 'busy' positions or pending orders,
 * 'ph' only an empty Vest placeholder (size 0 without orders: blocks copies on the opposite side), 'unk' state not read yet.
 */
function activityOf(id) {
  const st = S.state[id];
  if (!st) return { lvl: 'unk', tip: 'positions not read yet' };
  const sym = (s) => (S.symbols[s] || {}).label || s;
  const pos = (st.positions || []).filter((p) => p.qty > 0);
  const ord = st.orders || [];
  const ph = (st.placeholders || []).filter((p) => !pos.some((x) => x.symbol === p.symbol));
  const parts = [
    ...pos.map((p) => `${p.side === 'long' ? 'LONG' : 'SHORT'} ${p.qty} ${sym(p.symbol)}`),
    ...ord.map((o) => `pending ${o.side === 'long' ? 'BUY' : o.side === 'short' ? 'SELL' : '?'} ${o.qty} ${sym(o.symbol)} @ ${o.price}`),
  ];
  if (parts.length) return { lvl: 'busy', tip: parts.join('\n') };
  if (ph.length) return { lvl: 'ph', tip: ph.map((p) => `placeholder ${String(p.side || '?').toUpperCase()} ${sym(p.symbol)} at size 0, no orders (blocks copies on the opposite side)`).join('\n') };
  return { lvl: 'free', tip: 'free: no positions, no pending orders' };
}

module.exports = {
  activityOf,
  S,
  changed,
  subscribe: (fn) => (subs.add(fn), () => subs.delete(fn)),
  values,
  resetSession,
  aliasOf,
  setAlias,
  feedLive,
  heldSymbols,
};
