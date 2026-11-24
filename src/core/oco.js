// OCO (one cancels the other) on the pending ENTRIES of a market, selected account (Gerry 2026-11-20).
// With the option on, when one entry of a market is executed the other pending entries of that market are cancelled:
//  - a local STOP touched: before its market order, the other local stops AND the pending LIMITs (entries, not the
//    SL / TP legs) of that market are cancelled (awaited: Vest keeps one pending side per market, so a LIMIT on the
//    other side must be gone before the market order);
//  - a LIMIT filled (a pending entry disappears and the position grows): the local stops and the other pending LIMITs
//    of that market are cancelled.
// With OCO on, a local STOP may also be armed on the side opposite to a pending LIMIT (breakout both ways), when there is
// no position. Known limits: tab open and Orders ON (the cancels are orders); a LIMIT filled while the tab is closed
// leaves the others in place; partial fills of a LIMIT count as a fill.

const store = require('./store');
const stops = require('./stops');
const entry = require('./entry');
const orders = require('./orders');
const log = require('../diag/log');

const { S } = store;
let on = () => false;
const prev = new Map(); // account|symbol -> { ids: Set of pending entry ids, qty }

const entryOrders = (acc, sym) => ((S.state[acc] || {}).orders || []).filter((o) => o.symbol === sym && !o.reduceOnly);

/** Cancels every other pending entry of the market: local stops and Vest LIMITs (exceptId = the one executed). */
async function cancelOthers(acc, sym, why, exceptId) {
  const n0 = stops.list().filter((x) => x.accountId === acc && x.symbol === sym && x.id !== exceptId).length;
  if (n0) stops.cancelWhere(acc, sym, 'OCO: ' + why);
  const os = entryOrders(acc, sym).filter((o) => o.id !== exceptId);
  if (os.length && !orders.enabled()) {
    log.warn(`OCO ${sym}: ${os.length} pending LIMIT not cancelled (Orders OFF)`);
    return;
  }
  const res = await Promise.allSettled(os.map((o) => entry.cancelOrder({ accountId: acc, orderId: o.id, label: `OCO: LIMIT ${o.side === 'long' ? 'BUY' : 'SELL'} ${o.qty} @ ${o.price} (${why})` })));
  const bad = res.filter((r) => r.status === 'rejected').length;
  if (n0 || os.length) log[bad ? 'warn' : 'info'](`OCO ${sym}: ${why}: ${n0} local stop${n0 === 1 ? '' : 's'} and ${os.length - bad}/${os.length} LIMIT cancelled`);
}

/** At every state change: a pending entry gone + position grown on the selected account = filled. */
function watch() {
  const acc = S.selected;
  if (!acc) return;
  const st = S.state[acc] || {};
  const syms = new Set([...(st.orders || []).map((o) => o.symbol), ...(st.positions || []).map((p) => p.symbol)]);
  for (const k of prev.keys()) if (k.startsWith(acc + '|')) syms.add(k.slice(acc.length + 1));
  for (const sym of syms) {
    const k = acc + '|' + sym;
    const ids = new Set(entryOrders(acc, sym).map((o) => o.id));
    const pos = (st.positions || []).find((p) => p.symbol === sym && p.qty > 0);
    const qty = pos ? pos.qty : 0;
    const p = prev.get(k);
    const now = Date.now();
    const step = (S.symbols[sym] || {}).step || 1e-9;
    // the order status and the bigger position may arrive in two different messages: each one is remembered for 5 s
    const goneAt = p && [...p.ids].some((id) => !ids.has(id)) ? now : p ? p.goneAt : 0;
    const upAt = p && qty > p.qty + step / 2 ? now : p ? p.upAt : 0;
    prev.set(k, { ids, qty, goneAt, upAt, done: p ? p.done : 0 });
    if (!p || !on()) continue;
    if (!(now - goneAt < 5000 && now - upAt < 5000) || (p.done && now - p.done < 5000)) continue;
    prev.get(k).done = now;
    const left = ids.size + stops.list().filter((x) => x.accountId === acc && x.symbol === sym).length;
    if (!left) continue;
    cancelOthers(acc, sym, 'a LIMIT was filled').catch((e) => log.error(`OCO ${sym}: ${e.message}`));
  }
}
store.subscribe(watch);

// a local stop touched: the others go BEFORE its market order
stops.setBeforeFire(async (st) => {
  if (!on()) return;
  await cancelOthers(st.accountId, st.symbol, `${st.lim ? 'local LIMIT' : 'STOP'} ${st.trigger} touched`, st.id);
  // the size-0 placeholder of a cancelled LIMIT on the OTHER side stays on the feed a moment: the market entry would be
  // refused ("pending BUY order on this market") or rejected by Vest (10006). Waited until it is gone (max 3 s).
  // (seen on the harness 2026-11-21: local LIMIT SELL touched, BUY LIMIT cancelled, the SELL never sent)
  const t0 = Date.now();
  while (Date.now() - t0 < 3000 && entry.placeholderOn(st.accountId, st.symbol) && !entry.positionOn(st.accountId, st.symbol)) {
    const ph = entry.placeholderOn(st.accountId, st.symbol);
    if (ph.side === st.side) break; // same side: the entry goes onto it
    await new Promise((r) => setTimeout(r, 150));
  }
});

module.exports = { setConfig: (fn) => (on = fn), enabled: () => !!on() };
