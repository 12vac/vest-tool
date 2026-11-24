// LOCAL entry stops. Vest has no native entry stop: the stop lives in this browser tab and,
// when the price touches it, sends a MARKET order. Known limits:
//  - tab closed, page reloaded or Orders off = the stop no longer exists (never re-armed by itself)
//  - the price is Vest's mark read every 0.5 s: it may trigger late and with slippage
//  - with an old price (> 3 s) it does not trigger: better not to enter than to enter late

const store = require('./store');
const entry = require('./entry');
const Z = require('../domain/sizing');
const log = require('../diag/log');

const { S } = store;
const STALE_MS = 3000;
let seq = 1;
const armed = new Map(); // id -> { id, accountId, symbol, side, trigger, qty, lev, at, firing, plan? }
// plan STOP (Risk & targets): when touched, this sends the market entry WITH the plan's SL / TP (set by main.js)
let planFire = null;
// OCO (core/oco.js): runs before the market order of a touched stop (cancels the other entries of the market)
let beforeFire = null;
let ocoOn = () => false;
const listeners = new Set();
const notify = () => {
  for (const fn of listeners) fn();
  store.changed();
};

/**
 * Arms an entry stop at the given price (size and leverage fixed now). With plan: size, SL and TP of the plan.
 * lim = LOCAL LIMIT (Gerry 2026-11-21, OCO): Vest keeps one pending side per market, so with OCO on a LIMIT on the side
 * opposite to a pending Vest LIMIT is kept here: a BUY below / SELL above the price, sent at market when the price gets
 * there (after OCO has cancelled the other side).
 */
function arm({ accountId, symbol, price, pct, cap, plan, lim }) {
  if (!plan) entry.checkPct(pct, cap);
  const m = S.symbols[symbol],
    mk = S.marks[symbol];
  const side = Z.entrySide(lim ? 'lm' : 'st', price, mk && mk.px);
  if (!side) throw new Error('current price not available');
  if (Z.tooClose(price, mk.px, m.tick)) throw new Error('too close to the price: to enter now use ADD or the ticket');
  if (plan) {
    // the plan opens only on a free market (no position, no pending order): same rule as the plan LIMIT
    if (entry.positionOn(accountId, symbol)) throw new Error('plan STOP: only with no position on this market');
    if (entry.placeholderOn(accountId, symbol)) throw new Error('plan STOP: a pending order is on this market (cancel it first)');
    if ([...armed.values()].some((x) => x.accountId === accountId && x.symbol === symbol)) throw new Error('plan STOP: another local stop is armed on this market');
  } else if (lim) {
    if (!ocoOn() || entry.positionOn(accountId, symbol)) throw new Error('local LIMIT: only with OCO on and no position on this market');
  } else if (!(ocoOn() && !entry.positionOn(accountId, symbol))) entry.target(accountId, symbol, side, 'a stop'); // same side as the position or the pending orders (OCO with no position: either side)
  const sz = plan ? { qty: plan.qty, lev: null } : entry.sizeFor(accountId, symbol, pct);
  if (sz.why) throw new Error(sz.why);
  const st = { id: 'st' + seq++, accountId, symbol, side, trigger: price, qty: sz.qty, lev: sz.lev, at: Date.now(), firing: false, plan: plan || null, lim: !!lim };
  armed.set(st.id, st);
  log.warn(`${lim ? 'LIMIT' : 'STOP'} ${side === 'long' ? 'BUY' : 'SELL'} ${st.qty} at ${price} armed${plan ? ` with plan SL ${plan.sl} and ${plan.targets.length} TP` : ''} (LOCAL: lives in this tab, ${lim ? 'sent at market when the price gets there' : 'triggers at market'})`);
  notify();
  return st;
}

function cancel(id, why) {
  const st = armed.get(id);
  if (!st) return;
  armed.delete(id);
  log.info(`STOP ${st.side === 'long' ? 'BUY' : 'SELL'} at ${st.trigger} cancelled${why ? ' (' + why + ')' : ''}`);
  notify();
}

/** Moves a local stop (dragged on the chart): same side, not too close to the price. plan = new plan for it;
 *  a plan stop moved without a new plan keeps size and distances (SL / TP shift with it). */
function move(id, price, plan) {
  const st = armed.get(id);
  if (!st) throw new Error('local stop not found (triggered or cancelled?)');
  const mk = S.marks[st.symbol],
    m = S.symbols[st.symbol];
  const side = Z.entrySide(st.lim ? 'lm' : 'st', price, mk && mk.px);
  if (!side) throw new Error('current price not available');
  if (side !== st.side)
    throw new Error(st.lim ? `a ${st.side === 'long' ? 'BUY limit goes below' : 'SELL limit goes above'} the price` : `a ${st.side === 'long' ? 'BUY stop goes above' : 'SELL stop goes below'} the price: for the other side cancel it and place a new one`);
  if (Z.tooClose(price, mk.px, m.tick)) throw new Error('too close to the price');
  log.info(`STOP ${st.side === 'long' ? 'BUY' : 'SELL'} moved ${st.trigger} -> ${price} (local)${plan ? `: plan ${plan.qty} with SL ${plan.sl}` : ''}`);
  if (plan) {
    st.plan = plan;
    st.qty = plan.qty;
  } else if (st.plan) {
    const dx = price - st.trigger;
    const sh = (v) => +(v + dx).toFixed(8);
    st.plan = { ...st.plan, sl: sh(st.plan.sl), targets: st.plan.targets.map((t) => ({ ...t, price: sh(t.price) })) };
  }
  st.trigger = price;
  notify();
  return st;
}

/** Cancels an account's local stops on a market (card FLAT). Returns how many. */
function cancelWhere(accountId, symbol, why) {
  const ids = [...armed.values()].filter((x) => x.accountId === accountId && x.symbol === symbol).map((x) => x.id);
  ids.forEach((id) => cancel(id, why));
  return ids.length;
}

/** Bracket SL / TP distances of one local entry (dragged on the chart): { sl, tp } in points, kept when the entry is moved. */
function setBracketOf(id, br) {
  const st = armed.get(id);
  if (!st) throw new Error('local entry not found (triggered or cancelled?)');
  st.br = { ...(st.br || {}), ...br };
  log.info(`${st.lim ? 'LIMIT' : 'STOP'} ${st.side === 'long' ? 'BUY' : 'SELL'} ${st.trigger} (local): bracket ${st.br.sl > 0 ? 'SL ' + st.br.sl + ' pt' : ''}${st.br.tp > 0 ? ' TP ' + st.br.tp + ' pt' : ''} for this entry`);
  notify();
  return st;
}

function cancelAll(why) {
  for (const id of [...armed.keys()]) cancel(id, why);
}

/** Check at every new price: the stop triggers only once, then disappears. */
function check() {
  const now = Date.now();
  for (const st of armed.values()) {
    if (st.firing) continue;
    const mk = S.marks[st.symbol];
    if (!mk || now - mk.at > STALE_MS) continue;
    // a local LIMIT is reached from the other direction (BUY: price down to it, SELL: price up to it)
    if (!(st.lim ? Z.stopHit(st.side === 'long' ? 'short' : 'long', st.trigger, mk.px) : Z.stopHit(st.side, st.trigger, mk.px))) continue;
    st.firing = true;
    armed.delete(st.id);
    log.warn(`${st.lim ? 'local LIMIT' : 'STOP'} ${st.side === 'long' ? 'BUY' : 'SELL'} ${st.trigger} touched (price ${mk.px}): sending at market${st.plan ? ' with the plan' : ''}`);
    Promise.resolve(beforeFire ? beforeFire(st) : null)
      .catch((e) => log.warn(`OCO before STOP ${st.trigger}: ${e.message}`))
      .then(() =>
        st.plan && planFire
          ? planFire(st)
          : entry.marketEntry({ accountId: st.accountId, symbol: st.symbol, side: st.side, qty: st.qty, lev: st.lev, why: st.lim ? 'local LIMIT' : 'STOP', br: st.br || null }),
      )
      .catch((e) => log.error(`STOP not executed: ${e.message}`))
      .finally(notify);
  }
}

module.exports = {
  arm,
  move,
  cancel,
  cancelAll,
  cancelWhere,
  setBracketOf,
  check,
  setPlanFire: (fn) => (planFire = fn),
  setBeforeFire: (fn) => (beforeFire = fn),
  setOco: (fn) => (ocoOn = fn),
  list: () => [...armed.values()],
  count: () => armed.size,
  onChange: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
};
