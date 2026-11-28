// SELF-MATCHING guard, live part: the accounts as last read, the block / warning shown in the panel header, and the
// button that cancels the orders in the way and then repeats the exit. Rules in domain/selfmatch.js.
// "No silent fallback" (Gerry 2026-11-26): orders of an account never read, or not refreshed for STALE_MS, are UNKNOWN:
// entries are blocked, exits go out with a warning (blocking a way out on missing data would be worse).

const store = require('./store');
const SM = require('../domain/selfmatch');
const log = require('../diag/log');

const { S } = store;
const STALE_MS = 90000; // REST re-read every 60 s with the feed up, 20 s with it down: older than this = not trusted
const listeners = new Set();
let shown = null; // { text, kind: 'err' | 'warn', button, run } of the last block / warning, or null
let busy = false;
let rolesOf = null; // () => { master, followers } while the copier is ON, else null (set by main)

/** Snapshot for the domain: { id: { label, known, orders, positions } }. */
function accounts(now = Date.now()) {
  const out = {};
  for (const id of Object.keys(S.accounts)) {
    const st = S.state[id];
    const at = st ? Math.max(st.restAt || 0, st.feedAt || 0) : 0;
    out[id] = {
      label: S.accounts[id].label || id,
      known: !!st && Array.isArray(st.orders) && now - at < STALE_MS,
      orders: (st && st.orders) || [],
      positions: (st && st.positions) || [],
    };
  }
  return out;
}

function notify() {
  for (const fn of listeners) fn(shown);
}
let warnTimer = null;
function show(v) {
  shown = v;
  clearTimeout(warnTimer);
  // a yellow warning (something was done for you) stays 20 s, then goes; the log keeps it
  if (v && v.kind === 'warn') warnTimer = setTimeout(() => shown === v && show(null), 20000);
  notify();
}

/** The block / warning from the header goes away (✕ button, or after the exit went through). */
function dismiss() {
  show(null);
}

/**
 * Check before an order is sent. Throws (and shows the reason in the header) when it must not go out.
 * retry: function that sends the same exit again, offered on the button after the orders in the way are cancelled.
 * skip: Set of order ids that are being cancelled together with this order (FLAT of several accounts).
 * position: { id, symbol, side } of an exit read fresh from REST (FLAT), when the state may not hold it yet.
 * auto: automatic exit (Account limits, Safe runner, copier): nobody is there to press the button, so the orders in the
 *   way are cancelled here (said in the header and the log) and the exit goes out (Gerry 2026-11-26).
 * Copier ON, "the master commands" (Gerry 2026-11-26): the master's exit cancels the copies' orders in the way by itself;
 * a copy's exit that could hit a master's order is blocked (domain exitPlan).
 */
async function guard(accountId, order, { retry, skip, position, auto } = {}) {
  const b = order.body || {};
  // market of the order: reduce / close bodies carry only the position id
  const pos = position || (b.positionId ? ((S.state[accountId] || {}).positions || []).find((p) => p.id === b.positionId) : null);
  const sym = b.symbol || (pos && pos.symbol);
  const r = SM.check({ order, accountId, accounts: accounts(), tick: sym ? (S.symbols[sym] || {}).tick : NaN, skip, position });
  if (!r) return; // cancel, leg removal...: nothing that can trade
  if (!r.hits.length && !r.unknown.length) {
    if (shown && shown.kind === 'err' && !busy) show(null); // an order passed the check: the old block is no longer current
    return;
  }
  if (r.hits.length && !r.leg && r.exit) {
    const name = (S.accounts[accountId] || {}).label || accountId;
    // v0.20.71 (Gerry 2026-11-27, "compliant but the accounts must close"): a MARKET reduce of ANY account (master, copy,
    // automatic or by hand) goes out first as a LIMIT IOC beyond every order in the way: nothing is cancelled, nothing is
    // blocked, the orders of the other accounts (e.g. the copies' pending LIMITs) stay. Close / FLAT: rules below.
    const o0 = SM.sideOf(order, (id) => (position && position.id === id ? position : pos));
    const pr = o0 ? SM.protect({ order, side: o0.side, hits: r.hits, tick: (S.symbols[sym] || {}).tick, mark: (S.marks[sym] || {}).px }) : { why: 'side unknown' };
    if (pr.order) {
      const again = SM.check({ order: pr.order, accountId, accounts: accounts(), tick: (S.symbols[sym] || {}).tick, skip, position });
      if (again && !again.hits.length) {
        const text = `SELF-MATCH: ${name} reduce sent as LIMIT IOC @ ${pr.order.body.price} instead of market, so it cannot trade against ${r.hits.map((h) => h.text).join('; ')} (nothing cancelled). What does not fill at once is cancelled by Vest`;
        log.warn(text);
        show({ text, kind: 'warn', button: '', run: null });
        return { order: pr.order };
      }
    }
    const pl = SM.exitPlan({ hits: r.hits, accountId, roles: rolesOf ? rolesOf() : null, auto });
    if (pl.block) {
      const text = `SELF-MATCH BLOCKED: copy ${name} NOT closed (${r.what}): it could trade against the master's resting order ${pl.block.map((h) => h.text).join('; ')}. The master's orders are never touched: close this copy by hand when that order is gone${pr.why ? ` (${pr.why})` : ''}`;
      log.error(text);
      show({ text, kind: 'err', button: '', run: null });
      throw new Error(text);
    }
    if (pl.cancel.length) {
      const flatten = require('./flatten'); // lazy: flatten -> orders -> selfmatch
      for (const h of pl.cancel) {
        try {
          await flatten.cancelOne(h.accountId, h.orderId);
        } catch (e) {
          const text = `SELF-MATCH BLOCKED: exit ${r.what} of ${name} not sent: cancelling ${h.text} failed (${e.message})`;
          log.error(text);
          show({ text, kind: 'err', button: '', run: null });
          throw new Error(text);
        }
      }
      const text = `SELF-MATCH: exit ${r.what} of ${name}: cancelled first ${pl.cancel.map((h) => h.text).join('; ')}`;
      log.warn(text);
      show({ text, kind: 'warn', button: '', run: null });
      if (!pl.ask.length) return;
    }
    r.hits = pl.ask; // manual exit vs an account outside the copier: the button
  }
  if (r.hits.length && !r.leg) {
    const text = SM.textOf(r, true);
    log.warn(`✗ ${(S.accounts[accountId] || {}).label || accountId}: ${text}`);
    const list = r.hits.map((h) => ({ accountId: h.accountId, orderId: h.orderId, text: h.text }));
    const fix = r.exit && retry;
    show({
      text: fix ? text : text + ': cancel that order first',
      kind: 'err',
      button: fix ? `CANCEL ${list.length === 1 ? 'THAT ORDER' : 'THOSE ' + list.length + ' ORDERS'}, THEN CLOSE` : '',
      run: fix ? () => cancelThenRetry(list, retry) : null,
    });
    throw new Error(text);
  }
  if (r.unknown.length && !r.exit) {
    const text = SM.textOf(r, true);
    log.warn(`✗ ${(S.accounts[accountId] || {}).label || accountId}: ${text}`);
    show({ text: text + ': wait a moment or press "Reload all data"', kind: 'err', button: '', run: null });
    throw new Error(text);
  }
  // SL / TP leg against a resting order, or an exit while some account is unknown: sent, with a warning
  const text = SM.textOf(r, false) + (r.leg ? ': when it triggers, Vest sends it at market. Cancel that order if it is yours' : ': exit sent anyway');
  log.warn(text);
  show({ text, kind: 'warn', button: '', run: null });
}

/** Button: cancels the orders in the way (emergency path: works with Orders OFF), drops them from the state, repeats the exit. */
async function cancelThenRetry(list, retry) {
  if (busy) return;
  busy = true;
  const flatten = require('./flatten'); // lazy: flatten -> orders -> selfmatch
  try {
    for (const h of list) {
      await flatten.cancelOne(h.accountId, h.orderId);
      log.info(`SELF-MATCH: cancelled ${h.text} (button)`);
    }
    show(null);
    await retry();
    log.info('SELF-MATCH: exit sent after cancelling the orders in the way');
  } catch (e) {
    log.error('SELF-MATCH: ' + e.message);
    if (!shown) show({ text: 'SELF-MATCH: ' + e.message, kind: 'err', button: '', run: null });
  } finally {
    busy = false;
  }
}

/** Read-only indicator: resting orders of your accounts that already cross each other. '' = none. */
function crossingText() {
  const c = SM.crossings(accounts(), (sym) => (S.symbols[sym] || {}).tick);
  if (!c.length) return '';
  return `SELF-MATCH RISK: resting orders already cross on ${[...new Set(c.map((x) => x.symbol))].join(', ')}: ${c
    .slice(0, 3)
    .map((x) => `${x.buy} / ${x.sell}`)
    .join('; ')}${c.length > 3 ? ` (+${c.length - 3})` : ''}. Cancel one of them on Vest`;
}

module.exports = {
  guard,
  accounts,
  dismiss,
  crossingText,
  run: () => shown && shown.run && shown.run(),
  current: () => shown,
  subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
  STALE_MS,
  setRoles: (fn) => (rolesOf = fn),
};
