// REST reads: account list, balances, equity series, positions per account, market rules, mark prices.
// With a live feed: full re-read every 60 s (safety net). Feed down: every 20 s.
// Prices: public ticker every 1 s only while there is an open position (or a preview).

const session = require('./session');
const { request } = require('./transport');
const store = require('./store');
const A = require('../domain/account');
const { num, decimalsOf } = require('../domain/num');
const { vestDayStart, dayStartEquity } = require('../domain/vestday');
const DP = require('../domain/daypts');
const log = require('../diag/log');

const { S } = store;
const POLL_FEED_DOWN_MS = 20000;
const POLL_FEED_UP_MS = 60000;
const PRICE_MS = 1000;
const BALANCES_LIMIT = 500;
const CONCURRENCY = 4;
const DEFAULT_SYMBOL = 'NDX-USD-PERP';

let busy = false,
  again = false,
  lastFull = 0;
const extraSymbols = new Set(); // symbols requested by the preview or the chart

async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

async function readEquitySeries() {
  try {
    const now = Date.now();
    const r = await session.userGet(
      `/v3/trading-performance/series?from=${now - 30 * 60000}&to=${now}&points=30`,
      'GET /v3/trading-performance/series',
    );
    const latest = {};
    for (const it of (r && r.items) || []) {
      const id = it.account_id;
      if (!latest[id] || (it.ts || 0) > latest[id].ts)
        latest[id] = { ts: it.ts || 0, equity: num(it.equity_value), upnl: num(it.total_unrealized_pnl) || 0 };
    }
    return latest;
  } catch (e) {
    log.warn('equity series not readable: ' + e.message);
    return {};
  }
}

/**
 * Opening equity of the Vest day (from 20:00 New York) for each account: first point of the series from that time.
 * Re-read at most once a minute and right away when the day changes.
 * [D] A payout made today lowers the equity: the "Today" P&L would come out negative (not corrected).
 */
const DAY_REFRESH_MS = 60000;
let dayBusy = false;
/** Leverages saved on Vest per account and market (user token). The one Vest's ticket would use. */
async function readLeverages() {
  try {
    const r = await session.userGet('/v3/user-state', 'GET /v3/user-state');
    const out = {};
    for (const a of (r && r.accounts) || []) {
      // name given to the account on Vest (it is in user-state accounts[].name, not in capital/accounts)
      if (a.accountId && typeof a.name === 'string' && a.name.trim()) S.vestNames[a.accountId] = a.name.trim().slice(0, 40);
      out[a.accountId] = {};
      for (const l of a.leverages || []) out[a.accountId][l.symbol] = num(l.leverage);
    }
    S.levs = out;
    applyNames();
  } catch (e) {
    log.warn('Saved leverages not readable (using the plan maximum): ' + e.message);
  }
}

/** Account labels: name given in the panel, otherwise Vest's name, otherwise number + end of the id. */
function applyNames() {
  let changed = false;
  for (const [id, a] of Object.entries(S.accounts)) {
    if (S.vestNames[id] && a.autoLabel !== S.vestNames[id]) a.autoLabel = S.vestNames[id];
    const want = store.aliasOf(id) || a.autoLabel;
    if (a.label !== want) (a.label = want), (changed = true);
  }
  if (changed) store.changed();
}

async function readDay() {
  const start = vestDayStart(Date.now());
  if (dayBusy || (S.day && S.day.start === start && Date.now() - S.day.at < DAY_REFRESH_MS)) return;
  dayBusy = true;
  try {
    const r = await session.userGet(
      `/v3/trading-performance/series?from=${start}&to=${Date.now()}&points=200`,
      'GET /v3/trading-performance/series (day)',
    );
    const startEq = dayStartEquity(r && r.items);
    const prev = S.day && S.day.start === start ? S.day.startEq : {};
    S.day = { start, at: Date.now(), startEq: { ...prev, ...startEq } };
    store.changed();
  } catch (e) {
    if (S.day && S.day.start === start) S.day.at = Date.now(); // retry in a minute
    log.warn('Vest day start not readable: ' + e.message);
  } finally {
    dayBusy = false;
  }
}

/**
 * Points of an account's closed positions: S.pts[id] = { map: { position: points }, full, at }.
 * The first time the whole history (closed positions never change), then only the first page (the most recent).
 */
const ptsBusy = new Set();
async function readPoints(id) {
  if (!id || ptsBusy.has(id)) return;
  ptsBusy.add(id);
  try {
    S.pts = S.pts || {};
    const prev = S.pts[id];
    const map = prev && prev.full ? { ...prev.map } : {};
    const pages = prev && prev.full ? 1 : 40;
    for (let page = 0; page < pages; page++) {
      const r = await session.userGet(`/v3/positions?account_id=${encodeURIComponent(id)}&limit=50&offset=${page * 50}`, 'GET /v3/positions (history)');
      const list = (r && r.positions) || [];
      Object.assign(map, DP.closedPointsAt(list.filter((x) => !x.accountId || x.accountId === id)));
      if (list.length < 50) break;
    }
    S.pts[id] = { map, full: true, at: Date.now() }; // map: { position: { pts, at } } (points of the day)
    store.changed();
  } catch (e) {
    log.warn(`${(S.accounts[id] || {}).label || id}: position history not readable (${e.message})`);
  } finally {
    ptsBusy.delete(id);
  }
}

async function readAccountState(id) {
  const [pos, ord] = await Promise.all([
    session.accountGet(id, '/v3/positions/opened', 'GET /v3/positions/opened'),
    session.accountGet(id, '/v3/positions/opened-orders', 'GET /v3/positions/opened-orders'),
  ]);
  return { positions: A.parseRestPositions(pos), placeholders: A.parseRestPlaceholders(pos), ...A.parseRestOrders(ord) };
}

/** Full re-read. One at a time; a request during a read queues another one. */
async function full(reason) {
  if (busy) {
    again = true;
    return;
  }
  busy = true;
  const t0 = Date.now();
  lastFull = t0; // the loop does not start another while this one is running
  try {
    const [active, bals, perf] = await Promise.all([
      session.userGet('/v3/capital/accounts/active', 'GET /v3/capital/accounts/active'),
      session.userGet(`/v3/accounts?active=true&limit=${BALANCES_LIMIT}`, 'GET /v3/accounts'),
      readEquitySeries(),
    ]);
    const list = (active && active.accounts) || [];
    const accounts = {};
    for (const a of list)
      if (a && a.id) {
        const p = A.parseCapitalAccount(a);
        p.autoLabel = S.vestNames[a.id] || p.label;
        p.label = store.aliasOf(a.id) || p.label; // name given in the panel
        accounts[a.id] = p;
      }
    for (const id of Object.keys(S.accounts)) if (!accounts[id]) log.warn(`Account ${S.accounts[id].label} no longer active`);
    S.accounts = accounts;
    S.perf = perf;
    const free = {};
    for (const b of (bals && bals.accounts) || []) free[b.account_id] = { amount: num(b.amount), ver: parseInt(b.balance_version, 10) };

    await pool(Object.keys(accounts), CONCURRENCY, async (id) => {
      try {
        const rest = await readAccountState(id);
        const prev = S.state[id];
        // a feed event that arrived DURING this read is newer: do not overwrite it
        if (prev && prev.posAt > t0) return;
        const f = free[id];
        S.state[id] = {
          seq: prev ? prev.seq : null,
          free: f && f.amount >= 0 && !(prev && f.ver < prev.balVer) ? f.amount : prev ? prev.free : NaN,
          balVer: f && f.ver >= 0 ? Math.max(f.ver, prev ? prev.balVer : -1) : prev ? prev.balVer : -1,
          positions: rest.positions,
          placeholders: rest.placeholders,
          orders: rest.orders,
          ordersCollateral: rest.ordersCollateral,
          restAt: Date.now(),
          feedAt: prev ? prev.feedAt : 0,
        };
      } catch (e) {
        log.warn(`${accounts[id].label}: positions not readable (${e.message})`);
      }
    });
    for (const id of Object.keys(S.state)) if (!accounts[id]) delete S.state[id];
    if (!S.selected || !accounts[S.selected]) S.selected = screenAccount(accounts) || Object.keys(accounts)[0] || null;
    await loadAllSymbols();
    await ensureSymbols([DEFAULT_SYMBOL, ...store.heldSymbols()]);
    await readDay();
    await readLeverages();
    S.lastSync = Date.now();
    S.syncError = null;
    if (reason) log.info(`Full re-read (${reason}): ${list.length} accounts, ${Date.now() - t0} ms`);
  } catch (e) {
    S.syncError = e.message;
    log.warn('Re-read failed: ' + e.message);
  } finally {
    busy = false;
    store.changed();
    if (again) {
      again = false;
      setTimeout(() => full('queued'), 500);
    }
  }
}

/** Account open on Vest as written in sessionStorage (s) and localStorage (l): ids of known accounts, or null. */
function screenCandidates(accounts) {
  const out = { s: null, l: null };
  try {
    const uid = session.uid();
    if (!uid) return out;
    const k = 'vest-active-account:' + uid;
    for (const [w, store] of [['s', sessionStorage], ['l', localStorage]]) {
      let v = store.getItem(k);
      v = v == null ? '' : String(v);
      // Vest may save it as a JSON string ("\"id\"") or as an object ({id}): read raw it matched no account
      if (v[0] === '"' || v[0] === '{')
        try {
          const j = JSON.parse(v);
          v = typeof j === 'string' ? j : (j && (j.id || j.accountId)) || '';
        } catch {}
      if (v && accounts[v]) out[w] = v;
    }
  } catch {
    /* storage not readable */
  }
  return out;
}

/** The account open on Vest's screen (the one of its ticket and of its lines on the chart), if known. */
function screenAccount(accounts) {
  const c = screenCandidates(accounts);
  return c.s || c.l;
}

/** Re-read of positions and orders of ONE account (after an order): does not wait for the full loop. */
async function refreshAccount(id, retry = true) {
  if (!S.accounts[id]) return;
  const t0 = Date.now();
  try {
    const rest = await readAccountState(id);
    const prev = S.state[id];
    // the feed changed positions during the read: it is newer; retry once shortly after
    if (prev && prev.posAt > t0) return void (retry && setTimeout(() => refreshAccount(id, false), 700));
    S.state[id] = { ...(prev || { seq: null, free: NaN, balVer: -1, feedAt: 0 }), ...rest, restAt: Date.now() };
    await ensureSymbols(store.heldSymbols());
    store.changed();
  } catch (e) {
    log.warn(`${S.accounts[id].label}: re-read after the order failed (${e.message})`);
  }
}

/** Market rules (tick, step) for the symbols needed. */
/** Rules of a market from exchangeInfo: tick, step, names the chart uses for it. */
function applySymbols(list) {
  for (const x of list || []) {
    const tick = parseFloat(x.minTickSize || x.defaultTickSize);
    const dec = parseInt(x.sizeDecimals, 10);
    if (!x.symbol || !(tick > 0) || !(dec >= 0)) continue;
    // on the site the chart says "NQ" for NDX-USD-PERP
    const names = [x.symbol, x.displaySymbol, x.displayName, x.base, x.asset].filter((v) => typeof v === 'string' && v);
    const aliases = [...new Set(names.flatMap((n) => [n, n.replace(/-PERP$/i, ''), n.replace(/-USD(-PERP)?$/i, '')]))];
    S.symbols[x.symbol] = {
      tick,
      step: +Math.pow(10, -dec).toFixed(dec),
      priceDec: decimalsOf(tick),
      label: String(x.displaySymbol || x.symbol).replace(/-PERP$/, ''),
      aliases,
      takerFee: num(x.takerFee),
      makerFee: num(x.makerFee),
      // for the maximum leverage: a missing 'capital' ratio means 'not defined', different from null
      margin: {
        initMarginRatio: num(x.initMarginRatio),
        capitalInitMarginRatio: x.capitalInitMarginRatio === undefined ? undefined : x.capitalInitMarginRatio === null || x.capitalInitMarginRatio === '' ? null : num(x.capitalInitMarginRatio),
        fundedInitMarginRatio: x.fundedInitMarginRatio == null || x.fundedInitMarginRatio === '' ? null : num(x.fundedInitMarginRatio),
        capitalPlans: (x.capitalPlans || []).map((c) => ({ accountType: c.accountType, planId: c.planId, initMarginRatio: num(c.initMarginRatio) })),
      },
    };
  }
}

/**
 * All markets in one request: the chart matches any market at once
 * and a new position on another market does not wait for the full re-read. Repeated every 30 minutes.
 */
const ALL_SYMBOLS_MS = 30 * 60000;
let allAt = 0,
  allBusy = null;
function loadAllSymbols() {
  if (allBusy || Date.now() - allAt < ALL_SYMBOLS_MS) return allBusy || Promise.resolve();
  allBusy = request('/v3/exchangeInfo', { shapeKey: 'GET /v3/exchangeInfo' })
    .then((r) => {
      applySymbols(r && r.symbols);
      allAt = Date.now();
      store.changed();
    })
    .catch((e) => log.warn('market list not readable: ' + e.message))
    .finally(() => (allBusy = null));
  return allBusy;
}

/** Rules of the markets still missing (one request in flight per market). */
const symBusy = new Set();
async function ensureSymbols(syms) {
  const need = [...new Set(syms)].filter((s) => s && !S.symbols[s] && !symBusy.has(s));
  if (!need.length) return;
  need.forEach((s) => symBusy.add(s));
  try {
    const r = await request(`/v3/exchangeInfo?symbols=${need.map(encodeURIComponent).join(',')}`, { shapeKey: 'GET /v3/exchangeInfo' });
    applySymbols(r && r.symbols);
    store.changed();
  } catch (e) {
    log.warn('exchangeInfo not readable: ' + e.message);
  } finally {
    need.forEach((s) => symBusy.delete(s));
  }
}

async function prices() {
  const syms = [...new Set([...store.heldSymbols(), ...extraSymbols])].filter(Boolean);
  if (!syms.length) return;
  try {
    const r = await request(`/v3/ticker/latest?symbols=${syms.map(encodeURIComponent).join(',')}`, {
      shapeKey: 'GET /v3/ticker/latest',
    });
    const now = Date.now();
    for (const t of (r && r.tickers) || []) {
      const px = parseFloat(t.markPrice),
        mpx = parseFloat(t.marginMarkPrice);
      if (px > 0) S.marks[t.symbol] = { px, mpx: mpx > 0 ? mpx : px, at: now }; // mpx: price Vest uses to compute the margin
    }
    for (const fn of priceListeners) {
      try {
        fn();
      } catch (e) {
        log.error('price check: ' + e.message);
      }
    }
    store.changed();
  } catch {
    /* the next loop retries; old marks are flagged by the panel */
  }
}

// who must react to every new price (the local stops) and whether to read more often
const priceListeners = new Set();
let fastPrices = () => false;
const FAST_PRICE_MS = 500;
async function priceLoop() {
  await prices();
  setTimeout(priceLoop, fastPrices() ? FAST_PRICE_MS : PRICE_MS);
}

function start() {
  const tick = () => {
    if (session.status().state !== 'ok') return;
    const every = store.feedLive() ? POLL_FEED_UP_MS : POLL_FEED_DOWN_MS;
    if (!started) return;
    if (Date.now() - lastFull >= every) full(null);
    else readDay(); // reads nothing if the day's base is fresh
  };
  let started = false; // the session notifies several times: only one startup read
  session.onChange((st) => {
    if (st.state === 'ok' && !started) {
      started = true;
      full('startup');
    }
  });
  setInterval(tick, 2000);
  loadAllSymbols(); // public: no session needed
  // new position from the feed on a market never seen: rules now, not at the next full re-read
  store.subscribe(() => {
    const miss = store.heldSymbols().filter((sym) => !S.symbols[sym]);
    if (miss.length) ensureSymbols(miss);
  });
  priceLoop();
}

module.exports = {
  start,
  full,
  refreshAccount,
  readPoints,
  screenAccount,
  screenCandidates,
  ensureSymbols,
  watchSymbol: (s) => s && extraSymbols.add(s),
  onPrices: (fn) => priceListeners.add(fn),
  setFastPrices: (fn) => (fastPrices = fn),
  unwatchSymbol: (s) => extraSymbols.delete(s),
};
