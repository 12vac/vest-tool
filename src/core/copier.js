// Copier. One master account, one or more copies, sizing 1:1, Cap-to-fit or DD left (both reduce only).
// EVERY successful order of the master is copied: the tool's own (orders.send) and those from Vest's order ticket (page
// fetch/XHR, listened to and never modified): market entries/adds, reductions, closes, the card's FLAT, PENDING orders
// (limits, ticket stops, limit reductions) with their cancellations, SL/TP on the position (added, moved, removed).
// A move (new + cancel) follows by itself.
// Pending orders of the master and of the copies are tied in `links`: when the master's is cancelled, the copies' are too.
// [?] Master order filled and copy not (or vice versa): the sizes drift apart, there is no re-alignment.
// Safety net: if the master's position on a market DISAPPEARS (SL/TP hit, close from the site, ...) and after 1.5 s
// Vest confirms (REST) that the master is flat there, the copies still open on that market are closed (reduce of the
// whole size: the copies' pending orders stay, as for CLOSE).
// Safety: starts OFF at every reload (never re-armed automatically), START requires Orders ON and a confirmation, it
// switches off by itself if Orders go off or an account of the group disappears. FLATTEN ALL is not copied (it already
// closes everything on every account).
// [?] Master order accepted (200) and then rejected by Vest asynchronously: the copies stay open (orphans).

const store = require('./store');
const orders = require('./orders');
const session = require('./session');
const flatten = require('./flatten');
const sync = require('./sync');
const A = require('../domain/account');
const { decodeJwt } = require('./jwt');
const C = require('../domain/copy');
const Z = require('../domain/sizing');
const log = require('../diag/log');
const F = require('../ui/format');
const hooks = require('./hooks');

const { S } = store;
const CFG_KEY = 'vt1:copy'; // roles and mode (configuration, no amounts); the armed state is NEVER saved

let cfg = { roles: {}, mode: 'cap', dry: false, lim: {}, mult: {} }; // mult = { copy id: { on, x } } size multiplier per copy // dry = test mode; lim = { copy id: { loss: $ per day, pos: max positions } }
try {
  Object.assign(cfg, JSON.parse(localStorage.getItem(CFG_KEY) || '{}'));
} catch {
  /* defaults */
}
const save = () => {
  try {
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  } catch {
    /* nothing */
  }
};

const st = { armed: false, master: null, followers: [], mode: 'cap', last: null, dry: false, mult: {} };
const skips = new Map(); // copy -> { symbol, why, kind: 'small' | 'limit' | 'other', at }: last copy not made, for the sync status

/**
 * Every order to a COPY goes through here. TEST MODE: nothing is sent, the order is only written in the log
 * (Gerry 2026-11-20): to see what the copier WOULD do, with real orders on the master only.
 */
function fsend(f, order, what, positionId) {
  if (st.dry) {
    log.info(`TEST (not sent) ${what}`);
    return Promise.resolve({ test: true });
  }
  return orders.send(f, order, what, positionId, { copy: true });
}
function fflat(f, symbol) {
  if (st.dry) {
    log.info(`TEST (not sent) COPY ${label(f)}: FLAT ${symbol}`);
    return Promise.resolve({ cancelled: 0, closed: 0 });
  }
  return flatten.flattenMarket(f, symbol, { auto: true }); // copies follow the master: nobody clicks for them
}

/** Per-copy limits for an entry (open / add): reason to skip it, or null. Exits, SL / TP and cancels are always copied. */
function limitWhy(f, symbol, action) {
  if (action !== 'open' && action !== 'append') return null;
  const L = (cfg.lim || {})[f] || {};
  const loss = +L.loss,
    maxPos = NaN; // Max positions removed (Gerry 2026-11-23): an old saved value no longer applies
  if (loss > 0) {
    const day = (store.values(f) || {}).dayPnl;
    if (Number.isFinite(day) && day <= -loss) return `daily loss limit reached (today ${day.toFixed(2)} $, limit -${loss} $): entries not copied`;
  }
  if (maxPos > 0) {
    const ps = ((S.state[f] || {}).positions || []).filter((p) => p.qty > 0);
    if (!ps.some((p) => p.symbol === symbol) && ps.length >= maxPos) return `max ${maxPos} open position${maxPos > 1 ? 's' : ''} reached: new market not copied`;
  }
  return null;
}

// copied pending orders: key = id of the master's order (or market|price|size signature when Vest gives no id)
// -> { symbol, sig, at, ids: { copy: id of its order | null } }. Memory only: after a reload the links are lost.
const links = new Map();
const sigOf = (symbol, price, qty) => `${symbol}|${+price}|${+qty}`;
const orderSig = (o) => o && sigOf(o.symbol, o.price, o.qty);
function linkFor(orderId, mOrder) {
  if (orderId && links.has(orderId)) return [orderId, links.get(orderId)];
  const sig = orderSig(mOrder);
  if (sig) for (const [k, l] of links) if (l.sig === sig) return [k, l];
  return [null, null];
}
// copy's order to cancel: the linked id, otherwise the pending one on the same market at the same price
function followerOrderId(f, l) {
  if (l.ids[f]) return l.ids[f];
  const o = ((S.state[f] || {}).orders || []).find((x) => x.symbol === l.symbol && +x.price === l.price);
  return o ? o.id : null;
}
// copy orders just cancelled, per copy: their empty placeholder can still be there for a moment (see leftoverPh)
const justCancelled = new Map(); // follower -> { symbol, ids: Set, at }
async function cancelLinked(l, why) {
  const sent = {};
  const res = await Promise.allSettled(
    st.followers.map((f) => {
      const id = followerOrderId(f, l);
      sent[f] = id;
      if (!id) {
        log.warn(`COPY ${label(f)}: pending order to cancel not found (${why})`);
        return Promise.reject(new Error('not found'));
      }
      return fsend(f, { method: 'POST', path: '/v3/positions/cancel-order', body: { orderId: id } }, `COPY ${label(f)}: cancel pending order (${why})`, null);
    }),
  );
  st.followers.forEach((f, i) => {
    if (res[i].status !== 'fulfilled') return;
    const jc = justCancelled.get(f);
    const ids = jc && jc.symbol === l.symbol && Date.now() - jc.at < 10000 ? jc.ids : new Set();
    ids.add(sent[f]);
    justCancelled.set(f, { symbol: l.symbol, ids, at: Date.now() });
  });
  return res.filter((r) => r.status === 'fulfilled').length;
}
/** Before copying a new /open: waits (max 5 s) until the copies' placeholders left by a cancel just made are gone. */
async function leftoversGone(symbol) {
  const left = (f) => C.leftoverPh(S.state[f], justCancelled.get(f), symbol, Date.now());
  for (let i = 0; i < 25 && st.followers.some(left); i++) await new Promise((r) => setTimeout(r, 200));
  const still = st.followers.filter(left);
  if (still.length) log.warn(`Copy: ${still.map(label).join(', ')} still have the empty placeholder of the order just cancelled: the new order goes onto it (Vest may reject it)`);
}
// links of orders the master no longer has (filled or cancelled elsewhere): dropped after 15 s, time for the state to update
function pruneLinks() {
  const mine = new Set(((S.state[st.master] || {}).orders || []).map((o) => o.id));
  for (const [k, l] of links) if (Date.now() - l.at > 15000 && !mine.has(k) && !((S.state[st.master] || {}).orders || []).some((o) => orderSig(o) === l.sig)) links.delete(k);
}

const label = (id) => (S.accounts[id] || {}).label || id;
const masterId = () => Object.keys(cfg.roles).find((id) => cfg.roles[id] === 'master' && S.accounts[id]) || null;
const followerIds = () => Object.keys(cfg.roles).filter((id) => cfg.roles[id] === 'copy' && S.accounts[id]);

function setRole(id, role) {
  if (st.armed) throw new Error('stop the copier before changing the roles');
  if (role === 'master') for (const k of Object.keys(cfg.roles)) if (cfg.roles[k] === 'master') delete cfg.roles[k]; // only one master
  if (role === 'master' || role === 'copy') cfg.roles[id] = role;
  else delete cfg.roles[id];
  save();
  store.changed();
}
const MODE_NAME = { '1:1': '1:1 (same size)', cap: 'Cap-to-fit (in proportion to equity, reduce only)', dd: 'DD left (same share of the drawdown left as the master, reduce only)' };
const modeShort = (m) => (m === '1:1' ? '1:1' : m === 'dd' ? 'DD left' : 'Cap-to-fit');
// $ left before an account fails (smaller of daily and max drawdown left), set by main.js
let roomOf = () => NaN;
function setRoom(fn) {
  roomOf = fn;
}
function setMode(mode) {
  if (st.armed) throw new Error('stop the copier before changing the sizing');
  cfg.mode = mode === '1:1' || mode === 'dd' ? mode : 'cap';
  save();
  store.changed();
}

/** Why it cannot start, or null. */
function setDry(on) {
  if (st.armed) throw new Error('stop the copier before changing test mode');
  cfg.dry = !!on;
  save();
  store.changed();
}
/** Multiplier of a copy: { on, x }; x read with a dot (a comma is accepted). Only while the copier is stopped. */
const multOf = (m, id) => {
  const r = (m || {})[id];
  return r && r.on && r.x > 0 ? r.x : NaN;
};
function setMult(id, patch) {
  if (st.armed) throw new Error('stop the copier before changing the multiplier');
  cfg.mult = cfg.mult || {};
  const r = { on: false, x: NaN, ...(cfg.mult[id] || {}) };
  if ('on' in patch) r.on = !!patch.on;
  if ('x' in patch) {
    const n = parseFloat(String(patch.x).replace(',', '.'));
    r.x = n > 0 && n <= 100 ? Math.round(n * 1000) / 1000 : NaN;
    if (!(r.x > 0)) r.on = false;
  }
  if (r.on && !(r.x > 0)) throw new Error('type the multiplier first (e.g. 0.5 or 2.0)');
  cfg.mult[id] = { on: r.on, x: r.x > 0 ? r.x : null };
  save();
  store.changed();
}
function setLimit(id, k, v) {
  cfg.lim = cfg.lim || {};
  const n = parseFloat(String(v).replace(',', '.'));
  const L = { ...(cfg.lim[id] || {}) };
  if (n > 0) L[k] = k === 'pos' ? Math.floor(n) : n;
  else delete L[k];
  if (Object.keys(L).length) cfg.lim[id] = L;
  else delete cfg.lim[id];
  save();
  store.changed();
}

function cannotStart() {
  if (!orders.enabled() && !cfg.dry) return 'switch Orders on first (or tick test mode)';
  const m = masterId(),
    f = followerIds();
  if (!m) return 'choose the master account';
  if (!f.length) return 'choose at least one copy account';
  for (const id of [m, ...f]) if (session.canTradeOf(id) === false) return `${label(id)}: Vest says it cannot trade`;
  return null;
}

/** Text for the START confirmation. */
function describe() {
  const m = masterId(),
    f = followerIds();
  return `${cfg.dry ? 'TEST MODE: nothing is sent to the copies, only written in the log\n' : ''}Master: ${label(m)}\nCopies: ${f.map(label).join(', ')}\nSizing: ${MODE_NAME[cfg.mode] || MODE_NAME.cap}${cfg.mode === 'dd' ? ddLines(m, f) : ''}${f.filter((id) => multOf(cfg.mult, id) > 0).map((id) => `\n${label(id)}: x${F.mult(multOf(cfg.mult, id))} of the master size (multiplier)`).join('')}`;
}
// DD left now, per account, for the START confirmation (it is read again at every entry)
function ddLines(m, f) {
  const usd = (x) => (Number.isFinite(x) ? `${Math.round(x)} $` : 'unknown');
  const mr = roomOf(m);
  return `\nDrawdown left now: ${label(m)} ${usd(mr)}` + f.filter((id) => !(multOf(cfg.mult, id) > 0)).map((id) => {
    const r = roomOf(id);
    const pct = r > 0 && mr > 0 ? Math.min(100, Math.floor((r / mr) * 100)) : NaN;
    return `\n${label(id)}: ${usd(r)} -> ${Number.isFinite(pct) ? `${pct}% of the master size` : 'entries NOT copied'}`;
  }).join('');
}

function start() {
  const why = cannotStart();
  if (why) throw new Error(why);
  st.master = masterId();
  st.followers = followerIds();
  st.mode = cfg.mode;
  st.dry = !!cfg.dry;
  st.mult = Object.fromEntries(st.followers.map((f) => [f, multOf(cfg.mult, f)]).filter(([, x]) => x > 0));
  st.armed = true;
  skips.clear();
  st.last = null;
  held = new Set();
  watchMaster(); // markets already open on the master when switched on
  installPageHooks();
  for (const id of st.followers) session.accountToken(id).catch(() => {}); // tokens ready: the first copy does not wait for a mint
  log.warn(`COPIER ON${st.dry ? ' (TEST MODE, nothing sent)' : ''}: ${label(st.master)} -> ${st.followers.map(label).join(', ')} (${modeShort(st.mode)})`);
  store.changed();
}

function stop(why) {
  if (!st.armed) return;
  st.armed = false;
  log.warn('Copier off' + (why ? ': ' + why : ''));
  store.changed();
}

// ── safety net: master left a market -> copies closed
const EXIT_CONFIRM_MS = 1500;
let held = new Set(); // markets where the master has a position (since switched on)
const heldSide = new Map(); // market -> master's side (only copies on the same side are closed)
const checking = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const restPositions = async (id) => A.parseRestPositions(await session.accountGet(id, '/v3/positions/opened'));

function watchMaster() {
  if (!st.armed) return void held.clear();
  const pos = (S.state[st.master] || {}).positions || [];
  const { gone, now } = C.exitedSymbols(held, pos);
  held = now;
  for (const p of pos) if (p.qty > 0) heldSide.set(p.symbol, p.side);
  for (const sym of gone) if (!checking.has(sym)) exitCheck(sym, heldSide.get(sym)).catch((e) => log.error('Copy (master exit): ' + e.message));
}

async function exitCheck(sym, side) {
  checking.add(sym);
  try {
    await sleep(EXIT_CONFIRM_MS); // the copied exit (close/reduce/FLAT) and copied SL/TP have time to arrive
    if (!st.armed || S.flattening) return;
    // confirmation from Vest, not from the state: a late feed or a half-done re-read must not close anything
    if ((await restPositions(st.master)).some((p) => p.symbol === sym)) return;
    const m = S.symbols[sym] || {};
    const label0 = m.label || sym;
    const res = await Promise.allSettled(
      st.followers.map(async (f) => {
        const p = (await restPositions(f)).find((x) => x.symbol === sym);
        if (!p) return false;
        if (side && p.side !== side) {
          log.info(`COPY ${label(f)}: ${p.side.toUpperCase()} on ${label0}, opposite side to the master: not closed`);
          return false;
        }
        const lev = p.leverage > 0 ? p.leverage : Z.maxLeverageFor(m.margin, S.accounts[f]);
        await fsend(f, Z.reduceOrder({ pos: p, qty: p.qty, leverage: lev, step: m.step }), `COPY ${label(f)}: master left ${label0}, closing ${p.qty}`, p.id);
        return true;
      }),
    );
    const closed = res.filter((r) => r.status === 'fulfilled' && r.value).length;
    const failed = res.filter((r) => r.status === 'rejected').length;
    if (!closed && !failed) return; // copies already flat: the exit had already been copied
    st.last = { at: Date.now(), action: 'master exit', src: 'safety net', ok: closed, n: closed + failed, ms: null };
    log.warn(`Master left ${label0}: ${closed} copies closed${failed ? `, ${failed} NOT closed (check!)` : ''}`);
    store.changed();
  } finally {
    checking.delete(sym);
  }
}
store.subscribe(watchMaster);

// switching Orders off switches the copier off too (the copies would not be sent)
orders.onChange(() => {
  if (st.armed && !st.dry && !orders.enabled()) stop('Orders off');
});

// copies' account tokens always ready while the copier is on (like the selected account's)
setInterval(() => {
  if (st.armed) for (const id of st.followers) if (S.accounts[id]) session.accountToken(id).catch(() => {});
}, 20000);

/** Positions and placeholders of an account right now (before the order changes things). */
function snapshot(accountId) {
  const s = S.state[accountId] || {};
  return {
    positions: (s.positions || []).map((p) => ({ ...p })),
    placeholders: (s.placeholders || []).map((p) => ({ ...p })),
    orders: (s.orders || []).map((o) => ({ ...o })),
  };
}

const onSym = (list, symbol) => (list || []).find((p) => p.symbol === symbol) || null;

/** Successful order of an account: if it is the master and the copier is on, it is replicated on the copies. */
async function mirror({ accountId, order, before, via, res: mRes }) {
  if (!st.armed || accountId !== st.master) return;
  const action = C.actionOf(order.path);
  if (!action) return;
  if (S.flattening) return log.info(`MASTER ${action} during FLATTEN ALL: not copied`);
  const gone = [st.master, ...st.followers].find((id) => !S.accounts[id]);
  if (gone) return stop(`${label(gone)} is no longer active`);
  const body = order.body || {};
  const b = before || { positions: [], placeholders: [] };
  const src0 = via === 'page' ? 'Vest ticket' : 'tool';
  pruneLinks();
  if (action === 'cancel-order') {
    // a pending order of the master was cancelled: the copies' orders linked to it are cancelled
    const mOrder = (b.orders || []).find((o) => o.id === body.orderId) || null;
    const [k, l] = linkFor(body.orderId, mOrder);
    if (!l) return log.info(`MASTER (${src0}) cancelled a pending order that was not copied: the copies are not touched`);
    links.delete(k);
    const t0 = performance.now();
    const ok = await cancelLinked(l, 'cancelled on the master');
    st.last = { at: Date.now(), action: 'cancel', src: src0, ok, n: st.followers.length, ms: Math.round(performance.now() - t0) };
    log[ok === st.followers.length ? 'info' : 'warn'](`Copy cancel from ${src0}: ${ok}/${st.followers.length} copies`);
    return store.changed();
  }
  let mBefore =
    [...b.positions, ...b.placeholders].find((p) => body.positionId && p.id === body.positionId) || (body.symbol ? onSym(b.positions, body.symbol) : null);
  // master's position not yet in the state (rapid orders from the ticket, late feed): rebuilt from Vest,
  // current position +/- the order quantity
  if (!mBefore && body.positionId && ['reduce', 'append', 'stop-loss', 'take-profit'].includes(action)) mBefore = await masterBefore(action, body);
  const symbol = body.symbol || (mBefore && mBefore.symbol);
  const m = symbol && S.symbols[symbol];
  const src = via === 'page' ? 'Vest ticket' : 'tool';
  if (!m) return log.warn(`MASTER ${action} (${src}): market ${symbol || '?'} not recognised, not copied`);
  if (action === 'open') await leftoversGone(symbol); // e.g. LIMIT moved by the plan: cancel + new /open on the master
  const mEq = (store.values(st.master) || {}).equity;
  const mRoom = st.mode === 'dd' ? roomOf(st.master) : NaN;
  const t0 = performance.now();
  const plans = st.followers.map((f) => {
    const fs = S.state[f] || {};
    const maxLev = Z.maxLeverageFor(m.margin, S.accounts[f]);
    const want = +body.leverage || (mBefore && mBefore.leverage) || null;
    const fLev = want > 0 && maxLev > 0 ? Math.min(want, maxLev) : want || maxLev;
    return {
      f,
      plan: C.planFollower({
        action,
        method: order.method,
        body,
        mBefore,
        fPos: onSym(fs.positions, symbol),
        fPh: onSym(fs.placeholders, symbol),
        mode: st.mode,
        mult: st.mult[f],
        mEq,
        fEq: (store.values(f) || {}).equity,
        mRoom,
        fRoom: st.mode === 'dd' ? roomOf(f) : NaN,
        step: m.step,
        tick: m.tick,
        fLev,
      }),
    };
  });
  const nc = plans.find((x) => x.plan.notCopied);
  if (nc) return log.warn(`MASTER (${src}): ${nc.plan.notCopied}`);
  const res = await Promise.allSettled(
    plans.map(({ f, plan }) => {
      const lim = !plan.skip && limitWhy(f, symbol, action);
      if (plan.skip || lim) {
        const why = plan.skip || lim;
        skips.set(f, { symbol, why, kind: lim ? 'limit' : /small|minimum|below|step/i.test(why) ? 'small' : 'other', at: Date.now() });
        log.warn(`COPY ${label(f)}: ${why}${lim ? '' : phNote(f, symbol)}`);
        return Promise.reject(new Error('skipped'));
      }
      if (action === 'open' || action === 'append') skips.delete(f);
      return fsend(f, plan.order, `COPY ${label(f)}: ${plan.label}`, plan.positionId);
    }),
  );
  const ok = res.filter((r) => r.status === 'fulfilled').length;
  // pending order: master -> copies link, to cancel them when the master cancels (or moves) its own
  if (plans.some((x) => x.plan.pending)) {
    const mId = C.orderIdOf(mRes);
    const price = +(body.price ?? body.triggerPrice);
    const l = { symbol, price, sig: sigOf(symbol, price, body.quantity), at: Date.now(), ids: {} };
    plans.forEach(({ f }, i) => (l.ids[f] = res[i].status === 'fulfilled' ? C.orderIdOf(res[i].value) : null));
    links.set(mId || l.sig, l);
    if (!mId) log.info('Copy: Vest gave no id for the master order, linked by price and size');
  }
  st.last = { at: Date.now(), action, src, ok, n: plans.length, ms: Math.round(performance.now() - t0) };
  log[ok === plans.length ? 'info' : 'warn'](`Copy ${action} from ${src}: ${ok}/${plans.length} copies in ${st.last.ms} ms`);
  store.changed();
}

// copy skipped because of a placeholder (size-0 position) on the market: which one and what is on it, to tell a leftover
// (orphan) order from an empty Vest shell
function phNote(f, symbol) {
  const fs = S.state[f] || {};
  if (onSym(fs.positions, symbol)) return '';
  const ph = onSym(fs.placeholders, symbol);
  if (!ph) return '';
  const os = (fs.orders || []).filter((o) => o.positionId === ph.id || (!o.positionId && o.symbol === symbol));
  const list = os.map((o) => `${o.side === 'long' ? 'BUY' : o.side === 'short' ? 'SELL' : '?'} ${o.qty} @ ${o.price}${o.reduceOnly ? ' CL' : ''}`).join(', ');
  return ` [placeholder ${ph.side ? ph.side.toUpperCase() : '?'} ...${String(ph.id).slice(-6)}, pending orders: ${os.length ? list : 'none'}]`;
}

async function masterBefore(action, body) {
  try {
    const now = A.parseRestPositions(await session.accountGet(st.master, '/v3/positions/opened')).find((p) => p.id === body.positionId);
    if (action === 'stop-loss' || action === 'take-profit') return now || null; // the size does not change
    const q = +body.quantity || 0;
    if (action === 'append') return now ? { ...now, qty: Math.max(0, now.qty - q) } : null;
    // reduction: if the position is gone the master reduced all of it
    return now ? { ...now, qty: now.qty + q } : { id: body.positionId, symbol: body.symbol, side: null, qty: q, leverage: +body.leverage || null };
  } catch (e) {
    log.warn('Copy: master position not re-read (' + e.message + ')');
    return null;
  }
}

/** Card cancel limits / cancel all on the master (emergency path, not orders.send): the copied orders on that market are cancelled. */
async function mirrorCancelAll(accountId, symbol) {
  if (!st.armed || accountId !== st.master || !symbol) return;
  const mine = [...links].filter(([, l]) => l.symbol === symbol);
  if (!mine.length) return;
  for (const [k] of mine) links.delete(k);
  const n = (await Promise.all(mine.map(([, l]) => cancelLinked(l, 'all cancelled on the master')))).reduce((a, b) => a + b, 0);
  log.info(`Copy cancel pending orders: ${n}/${mine.length * st.followers.length}`);
  store.changed();
}

/** Card FLAT on the master (emergency path, not orders.send): same FLAT on the copies' market. */
async function mirrorFlat(accountId, symbol) {
  if (!st.armed || accountId !== st.master || !symbol) return;
  for (const [k, l] of links) if (l.symbol === symbol) links.delete(k); // the copies' FLAT already cancels their orders
  const res = await Promise.allSettled(st.followers.map((f) => fflat(f, symbol)));
  const ok = res.filter((r) => r.status === 'fulfilled').length;
  st.last = { at: Date.now(), action: 'FLAT', src: 'tool', ok, n: res.length, ms: null };
  log[ok === res.length ? 'info' : 'warn'](`Copy FLAT: ${ok}/${res.length} copies`);
  store.changed();
}

/**
 * FLAT on the master with the copier OFF (Gerry 2026-11-20: after a reload the copier stays off, FLAT closed the master only
 * and the copies had to be closed by hand). The copy accounts set in the roles are read fresh; if any of them has a position
 * on that market, the user is ASKED (never automatic: a position there may have been opened by hand) and on OK each one gets
 * the same FLAT. The copier is not switched on. Returns the number of copies flattened.
 */
async function flatIdleCopies(accountId, symbol) {
  if (st.armed || !symbol || accountId !== masterId()) return 0;
  const fs = followerIds().filter((f) => f !== accountId);
  if (!fs.length) return 0;
  const open = [];
  await Promise.all(
    fs.map(async (f) => {
      try {
        const ps = (await restPositions(f)).filter((p) => p.symbol === symbol && p.qty > 0);
        for (const p of ps) open.push({ f, txt: `${label(f)}: ${String(p.side).toUpperCase()} ${p.qty}` });
      } catch (e) {
        log.warn(`FLAT copies: ${label(f)} not readable (${e.message})`);
      }
    }),
  );
  if (!open.length) return 0;
  const ids = [...new Set(open.map((o) => o.f))];
  const many = ids.length > 1;
  const list = open.map((o) => o.txt).join('\n');
  const ok = window.confirm(`Copier is OFF, but ${ids.length} copy account${many ? 's' : ''} still hold${many ? '' : 's'} ${symbol}:\n\n${list}\n\nFLAT them too (cancel their orders on this market and close at market)?`);
  if (!ok) {
    log.warn(`FLAT copies: copier off, ${ids.length} copies left open on ${symbol} (refused)`);
    return 0;
  }
  const res = await Promise.allSettled(ids.map((f) => flatten.flattenMarket(f, symbol, { auto: true })));
  const done = res.filter((r) => r.status === 'fulfilled').length;
  log[done === ids.length ? 'info' : 'warn'](`FLAT copies (copier off): ${done}/${ids.length} copies flat on ${symbol}`);
  store.changed();
  return done;
}

/**
 * Sync status of a copy on a market, for the Copier accounts table:
 * { k: 'ok' | 'off' | 'small' | 'limit' | 'missing' | 'extra' | 'side', text }. Sides only: sizes differ on purpose with Cap-to-fit.
 */
/** Sync of a copy with the master on a market. Copier OFF: no mark at all (Gerry 2026-11-23: "!" only with the copier ON). */
function syncOf(f, symbol) {
  return st.armed ? syncRaw(f, symbol) : null;
}
function syncRaw(f, symbol) {
  const mId = st.armed ? st.master : masterId();
  if (!mId || f === mId) return null;
  const mp = ((S.state[mId] || {}).positions || []).find((p) => p.symbol === symbol && p.qty > 0);
  const fp = ((S.state[f] || {}).positions || []).find((p) => p.symbol === symbol && p.qty > 0);
  const sk = skips.get(f);
  if (!mp && !fp) return { k: st.armed ? 'ok' : 'off', text: st.armed ? 'in sync (both flat)' : 'copier off' };
  if (mp && fp && mp.side === fp.side) return { k: 'ok', text: `in sync (${fp.side.toUpperCase()} ${fp.qty})` };
  if (mp && fp) return { k: 'side', text: `OUT OF SYNC: master ${mp.side.toUpperCase()}, copy ${fp.side.toUpperCase()}` };
  if (mp && !fp) {
    if (sk && sk.symbol === symbol && sk.kind === 'small') return { k: 'small', text: `too small: ${sk.why}` };
    if (sk && sk.symbol === symbol && sk.kind === 'limit') return { k: 'limit', text: `limit: ${sk.why}` };
    return { k: 'missing', text: `OUT OF SYNC: master ${mp.side.toUpperCase()} ${mp.qty}, copy flat${st.armed ? '' : ' (copier off)'}` };
  }
  return { k: 'extra', text: `OUT OF SYNC: master flat, copy ${fp.side.toUpperCase()} ${fp.qty}` };
}

// ── orders made by the page (Vest's order ticket): fetch and XHR are listened to, never modified. Installed at the first START.
let hooked = false;
const API_RE = /^https:\/\/api-gateway\.[^/]+\.vestmarkets\.com\/v3\/positions\//;
const accountOfAuth = (auth) => {
  const t = String(auth || '').replace(/^Bearer\s+/i, '');
  return t ? decodeJwt(t).accountId || null : null;
};
const parse = (b) => {
  try {
    return typeof b === 'string' ? JSON.parse(b) : null;
  } catch {
    return null;
  }
};
function pageOrder(url, method, auth, rawBody) {
  if (!st.armed || method === 'GET' || !API_RE.test(String(url)) || !C.actionOf(String(url).split('?')[0])) return null;
  const accountId = accountOfAuth(auth);
  if (accountId !== st.master) return null;
  const path = String(url).replace(/^https:\/\/[^/]+/, '').split('?')[0];
  return { accountId, order: { method, path, body: parse(rawBody) || {} }, before: snapshot(accountId), via: 'page' };
}
const done = (p, status, res) => {
  if (p && status >= 200 && status < 300) {
    mirror({ ...p, res }).catch((e) => log.error('Copy: ' + e.message));
    sync.refreshAccount(p.accountId); // master state refreshed at once, as after the tool's orders
  }
  else if (p) log.info(`MASTER (Vest ticket) ${p.order.path.split('/').pop()} rejected by Vest (HTTP ${status || 'no response'}): not copied`);
};

/** Reads a JSON body from a finished XHR without touching what the page gets. */
function xhrJson(xhr) {
  if (xhr.responseType === 'json') return xhr.response;
  if (xhr.responseType && xhr.responseType !== 'text') return null;
  return hooks.guarded(() => JSON.parse(xhr.responseText)) ?? null;
}

/** Method, url and Authorization header of a fetch call, whatever form the page used (string/Request, init/headers). */
function fetchMeta(input, init) {
  const req = typeof input === 'string' ? null : input;
  const headers = (init && init.headers) || (req && req.headers) || {};
  return {
    url: req ? req.url : input,
    method: String((init && init.method) || (req && req.method) || 'GET').toUpperCase(),
    auth: typeof headers.get === 'function' ? headers.get('Authorization') : headers.Authorization || headers.authorization,
    body: init && init.body,
  };
}

function installPageHooks() {
  if (hooked) return;
  hooked = true;
  try {
    // fetch: the page receives the original response; we read a clone of it
    const pageFetch = window.fetch;
    window.fetch = function (...args) {
      const m = hooks.guarded(() => fetchMeta(args[0], args[1]));
      const order = m ? hooks.guarded(() => pageOrder(m.url, m.method, m.auth, m.body)) : null;
      const pending = Reflect.apply(pageFetch, this, args);
      if (order) {
        pending.then(
          async (res) => {
            const ok = res.status >= 200 && res.status < 300;
            const json = ok ? await res.clone().json().catch(() => null) : null;
            done(order, res.status, json);
          },
          () => done(order, 0),
        );
      }
      return pending;
    };
    // XHR (axios): method/url from open, Authorization from setRequestHeader, body from send
    const meta = new WeakMap();
    const proto = XMLHttpRequest.prototype;
    hooks.observe(proto, 'open', function ([method, url]) {
      meta.set(this, { method: String(method || 'GET').toUpperCase(), url });
    });
    hooks.observe(proto, 'setRequestHeader', function ([name, value]) {
      const m = meta.get(this);
      if (m && /^authorization$/i.test(name)) m.auth = value;
    });
    hooks.observe(proto, 'send', function ([body]) {
      const m = meta.get(this);
      const order = m && pageOrder(m.url, m.method, m.auth, body);
      if (!order) return;
      this.addEventListener('loadend', () => done(order, this.status, xhrJson(this)), { once: true });
    });
  } catch (e) {
    log.warn('Copier: listening to page orders not installed (' + e.message + '): only orders from the tool are copied');
  }
}

// copier ON: the tool trades only on the master (Gerry 2026-11-23: a SHORT went to copy 23, selected by mistake, and was not
// copied). Only NEW entries (open / append) are refused on the other accounts: FLAT, close, reduce, cancel, SL / TP stay allowed.
orders.setAccountGuard((id) => (st.armed && id !== st.master ? `Copier ON: entries only from the master ${label(st.master)} (selected: ${label(id)})` : null));

// tool orders: orders.send notifies after every successful order, with the account snapshot taken before sending
orders.onSent((x) => mirror({ ...x, via: 'tool' }).catch((e) => log.error('Copy: ' + e.message)), snapshot);

module.exports = {
  start,
  stop,
  cannotStart,
  describe,
  setRole,
  setMode,
  setRoom,
  mirrorFlat,
  flatIdleCopies,
  setDry,
  setLimit,
  setMult,
  multOf: (id) => multOf(st.armed ? Object.fromEntries(Object.entries(st.mult).map(([k, x]) => [k, { on: true, x }])) : cfg.mult, id),
  syncOf,
  mirrorCancelAll,
  state: () => ({ dry: st.armed ? st.dry : !!cfg.dry, lim: { ...(cfg.lim || {}) }, mult: JSON.parse(JSON.stringify(cfg.mult || {})), armed: st.armed, master: st.armed ? st.master : masterId(), followers: st.armed ? st.followers : followerIds(), mode: st.armed ? st.mode : cfg.mode, roles: { ...cfg.roles }, last: st.last }),
  isFollower: (id) => st.armed && st.followers.includes(id),
};
