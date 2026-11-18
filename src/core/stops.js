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
const armed = new Map(); // id -> { id, accountId, symbol, side, trigger, qty, lev, at, firing }
const listeners = new Set();
const notify = () => {
  for (const fn of listeners) fn();
  store.changed();
};

/** Arms an entry stop at the given price (size and leverage fixed now). */
function arm({ accountId, symbol, price, pct, cap }) {
  entry.checkPct(pct, cap);
  const m = S.symbols[symbol],
    mk = S.marks[symbol];
  const side = Z.entrySide('st', price, mk && mk.px);
  if (!side) throw new Error('current price not available');
  if (Z.tooClose(price, mk.px, m.tick)) throw new Error('too close to the price: to enter now use ADD or the ticket');
  entry.target(accountId, symbol, side, 'a stop'); // same side as the position or the pending orders
  const sz = entry.sizeFor(accountId, symbol, pct);
  if (sz.why) throw new Error(sz.why);
  const st = { id: 'st' + seq++, accountId, symbol, side, trigger: price, qty: sz.qty, lev: sz.lev, at: Date.now(), firing: false };
  armed.set(st.id, st);
  log.warn(`STOP ${side === 'long' ? 'BUY' : 'SELL'} ${st.qty} at ${price} armed (LOCAL: lives in this tab, triggers at market)`);
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

/** Moves a local stop (dragged on the chart): same side, not too close to the price. */
function move(id, price) {
  const st = armed.get(id);
  if (!st) throw new Error('local stop not found (triggered or cancelled?)');
  const mk = S.marks[st.symbol],
    m = S.symbols[st.symbol];
  const side = Z.entrySide('st', price, mk && mk.px);
  if (!side) throw new Error('current price not available');
  if (side !== st.side) throw new Error(`a ${st.side === 'long' ? 'BUY stop goes above' : 'SELL stop goes below'} the price: for the other side cancel it and place a new one`);
  if (Z.tooClose(price, mk.px, m.tick)) throw new Error('too close to the price');
  log.info(`STOP ${st.side === 'long' ? 'BUY' : 'SELL'} moved ${st.trigger} -> ${price} (local)`);
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
    if (!Z.stopHit(st.side, st.trigger, mk.px)) continue;
    st.firing = true;
    armed.delete(st.id);
    log.warn(`STOP ${st.side === 'long' ? 'BUY' : 'SELL'} ${st.trigger} touched (price ${mk.px}): sending at market`);
    entry
      .marketEntry({ accountId: st.accountId, symbol: st.symbol, side: st.side, qty: st.qty, lev: st.lev, why: 'STOP' })
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
  check,
  list: () => [...armed.values()],
  count: () => armed.size,
  onChange: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
};
