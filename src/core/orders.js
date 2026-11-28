// Sending of the orders: FLAT, breakeven, SL/TP (new or moved), entries.
// Rules: 'Orders' switch on (off at every reload), account that can trade, one action at a time per position,
// Idempotency-Key on every order, no automatic retry (it is not proven that Vest honours the key), re-read right after.

const session = require('./session');
const transport = require('./transport');
const store = require('./store');
const sync = require('./sync');
const O = require('../domain/orders');
const log = require('../diag/log');

const { S } = store;
const busy = new Map(); // positionId -> description of the action in progress
const listeners = new Set();
let accountGuard = null; // copier: reason why an account may not trade by hand now (copier ON, not the master), or null
let sentHook = null,
  snapOf = null; // copier: notified after every successful order, with the account state captured BEFORE sending

const uuid = () =>
  crypto.randomUUID
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 15) >>> 0;
        return (c === 'x' ? r : (r & 3) | 8).toString(16);
      });

function notify() {
  for (const fn of listeners) fn();
  store.changed();
}

function setEnabled(v) {
  transport.setOrdersEnabled(v);
  if (v && S.selected) session.accountToken(S.selected).catch(() => {}); // ready before the first order
  log.warn(v ? 'ORDERS ON: BE, SL/TP, FLAT and entries send real orders to the selected account' : 'Orders off');
  notify();
}

const selfmatch = require('./selfmatch');

/** Reason why trading is not possible now, or null. */
function blocked(accountId) {
  if (!transport.ordersEnabled()) return 'Orders are off: switch ORDERS on (Trade commands)';
  if (!S.accounts[accountId]) return 'Account not active';
  if (session.canTradeOf(accountId) === false) return 'Vest says this account cannot trade (canTrade = false)';
  return null;
}

/** Sends an order { method, path, body } for an account. On 401 renews the token and retries ONCE (nothing was executed). */
async function send(accountId, order, label, positionId, opts = {}) {
  // copier guard on entries only (open / append): closing, reducing, cancelling and SL / TP stay possible on a copy, to fix it by hand
  const entry = /\/v3\/positions\/(open|append)$/.test(order.path || '');
  const why = blocked(accountId) || (entry && !opts.copy && accountGuard ? accountGuard(accountId) : null);
  if (why) {
    log.warn(`✗ ${label}: ${why}`);
    throw new Error(why);
  }
  // SELF-MATCHING (Vest Prop ToS sec. 5, permanent ban): an order that could trade against a resting order of ANOTHER own
  // account is refused; a manual exit gets a button in the header that cancels those orders and sends it again; an
  // automatic one (opts.auto, copier) cancels them itself and goes out.
  const label0 = label; // label is prefixed with the account below
  const asked = order; // what was asked (market): the copier mirrors this, not the protected form
  const g = await selfmatch.guard(accountId, order, { retry: () => send(accountId, order, label0, positionId, opts), auto: !!(opts.auto || opts.copy) });
  if (g && g.order) {
    order = g.order; // v0.20.70: copy reduce made safe (LIMIT IOC beyond the orders in the way)
    label = `${label} [LIMIT IOC @ ${order.body.price}]`;
  }
  if (positionId && busy.has(positionId)) throw new Error(`wait: "${busy.get(positionId)}" is still in progress`);
  if (positionId) busy.set(positionId, label);
  notify();
  const key = uuid();
  const before = snapOf ? snapOf(accountId) : null;
  const t0 = performance.now();
  // the account in every line (Gerry 2026-11-23: an order went to a copy account selected by mistake and the log did not say so)
  if (!/^COPY /.test(label)) label = `${(S.accounts[accountId] || {}).label || accountId}: ${label}`;
  log.info(`→ ${label}`);
  try {
    let tok = (await session.accountToken(accountId)).token;
    const t1 = performance.now(); // up to here: account token (0 ms if cached)
    let res;
    try {
      res = await transport.request(order.path, { method: order.method, token: tok, body: order.body, idempotencyKey: key });
    } catch (e) {
      if (!(e instanceof transport.HttpError) || e.status !== 401) throw e;
      session.dropAccountToken(accountId);
      tok = (await session.accountToken(accountId)).token;
      res = await transport.request(order.path, { method: order.method, token: tok, body: order.body, idempotencyKey: key });
    }
    const tokMs = Math.round(t1 - t0),
      vestMs = Math.round(performance.now() - t1);
    log.info(`✓ ${label} (${tokMs + vestMs} ms${tokMs > 5 ? ` = token ${tokMs} + Vest ${vestMs}` : ''})`);
    if (sentHook)
      try {
        sentHook({ accountId, order: asked, before, res });
      } catch (e) {
        log.error('copiatore: ' + e.message);
      }
    return res;
  } catch (e) {
    const vest = e.body && (e.body.message || e.body.msg || e.body.error);
    const msg = `${e.message}${vest ? ': ' + String(vest).slice(0, 160) : ''}`;
    log.error(`✗ ${label}: ${msg}`);
    throw new Error(msg);
  } finally {
    if (positionId) busy.delete(positionId);
    notify();
    sync.refreshAccount(accountId); // ids of the new legs and real state, without waiting for the loop
    setTimeout(() => sync.refreshAccount(accountId), 1500); // Vest's feed/REST may arrive a moment later
  }
}

const tickOf = (sym) => (S.symbols[sym] || {}).tick;
const markOf = (sym) => (S.marks[sym] || {}).px;

function flat(accountId, pos) {
  return send(accountId, O.closeOrder(pos), `FLAT ${pos.side.toUpperCase()} ${pos.qty} ${pos.symbol}`, pos.id);
}

/** Stop at breakeven; offPts > 0 = BE+ (stop in profit by that many points). */
function breakeven(accountId, pos, offPts = 0) {
  const tick = tickOf(pos.symbol);
  if (!(tick > 0)) return Promise.reject(new Error('market tick not read yet'));
  const plan = O.breakevenPlan(pos, markOf(pos.symbol), tick, offPts);
  const name = offPts > 0 ? 'BE+' : 'BE';
  if (plan.why) return Promise.reject(new Error(name + ': ' + plan.why));
  return send(accountId, O.legOrder(pos, 'sl', plan.price, tick, plan.existing), `${name}: stop at ${plan.price}`, pos.id);
}

/** Sets (POST) or moves (PUT) a stop/target at the given price. existing = leg to move or null. */
function setLeg(accountId, pos, kind, price, existing) {
  const tick = tickOf(pos.symbol);
  if (!(tick > 0)) return Promise.reject(new Error('market tick not read yet'));
  const bad = O.checkLeg({ kind, side: pos.side, price, mark: markOf(pos.symbol), tick });
  if (bad) return Promise.reject(new Error(`${kind.toUpperCase()}: ${bad}`));
  const verb = existing ? 'move' : 'set';
  return send(accountId, O.legOrder(pos, kind, price, tick, existing), `${kind.toUpperCase()} ${verb} at ${price}`, pos.id);
}

/** Removes an existing stop/target. */
function removeLeg(accountId, pos, leg) {
  return send(accountId, O.legDeleteOrder(pos, leg), `${leg.kind.toUpperCase()} removed (was at ${leg.price})`, pos.id);
}

// Account token always ready for the selected account with orders on: an order never waits for a mint
// (the token lasts ~15 minutes and is renewed 60 s before; without this the first order after expiry pays an extra round trip).
setInterval(() => {
  if (transport.ordersEnabled() && S.selected && S.accounts[S.selected]) session.accountToken(S.selected).catch(() => {});
}, 20000);

module.exports = {
  send,
  setEnabled,
  removeLeg,
  enabled: () => transport.ordersEnabled(),
  blocked,
  busyOn: (pid) => busy.get(pid) || null,
  onChange: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
  onSent: (fn, snap) => ((sentHook = fn), (snapOf = snap)),
  setAccountGuard: (fn) => (accountGuard = fn),
  flat,
  breakeven,
  setLeg,
};
