// Entry orders from the second card: LIMIT dragged onto the chart, STOP (local stop, see stops.js),
// ADD (add at market), CUT (cut 50% at market), cancellation of a pending order.
// Size = percentage of the maximum size the account can open, never above the panel's cap.

const store = require('./store');
const orders = require('./orders');
const Z = require('../domain/sizing');
const { floorStep } = require('../domain/num');
const { closeOrder } = require('../domain/orders');
const { entryLegs } = require('../domain/plan');
const { roundToTick } = require('../domain/num');

// BRACKET (experimental build): fixed SL / TP in points attached to every NEW position opened from the tool (market
// LONG / SHORT, LIMIT, local STOP when it triggers, a moved LIMIT). Adds to a position go through /append, which has no
// legs: the position keeps the legs of its first order. Risk & targets plans keep their own SL / TP.
let bracketOf = () => null; // -> { sl, tp } in points (tp may be NaN = no TP) or null
const setBracket = (fn) => (bracketOf = fn);
/** Puts the bracket legs on an /open order. ref = entry price (limit price, or the current price at market). Returns the label part. */
function withBracket(order, side, ref, m, ov) {
  const b0 = bracketOf();
  // ov = distances set for this entry by dragging its SL / TP on the chart (local entries), over the panel's ones
  const b = b0 && ov ? { sl: ov.sl > 0 ? ov.sl : b0.sl, tp: ov.tp > 0 ? ov.tp : b0.tp } : b0;
  if (!b || !(b.sl > 0) || !(ref > 0) || order.path !== '/v3/positions/open') return '';
  const d = side === 'long' ? 1 : -1;
  const qty = +order.body.quantity;
  const sl = roundToTick(ref - d * b.sl, m.tick, d > 0 ? 'down' : 'up');
  const tp = b.tp > 0 ? roundToTick(ref + d * b.tp, m.tick, d > 0 ? 'up' : 'down') : NaN;
  const legs = entryLegs({ qty, sl, targets: tp > 0 ? [{ price: tp, qty }] : [], each: false, step: m.step, tick: m.tick });
  if (legs.why) throw new Error('bracket: ' + legs.why);
  order.body.stopLosses = legs.stopLosses;
  order.body.takeProfits = legs.takeProfits;
  return ` + SL ${sl}${tp > 0 ? ' TP ' + tp : ''}`;
}

const { S } = store;

/** Leverage, maximum size and size for the percentage, for an account on a market. { lev, max, qty, why } */
function sizeFor(accountId, symbol, pct) {
  const acc = S.accounts[accountId],
    st = S.state[accountId],
    m = S.symbols[symbol],
    mk = S.marks[symbol];
  if (!acc || !m) return { why: 'account or market not read yet' };
  const max = Z.maxLeverageFor(m.margin, acc);
  const lev = Z.orderLeverage((S.levs[accountId] || {})[symbol], max);
  if (!(lev > 0)) return { why: 'leverage unknown for this market' };
  if (!(mk && mk.mpx > 0)) return { lev, why: 'price not read yet' };
  const v = store.values(accountId) || {};
  const power = Z.tradingPower({ free: st && st.free, upnl: v.upnl, leverage: lev, takerFee: m.takerFee });
  const maxQ = Z.maxQty(power, mk.mpx, m.step);
  const qty = Z.qtyForPct(maxQ, pct, m.step);
  if (!(maxQ > 0)) return { lev, max: maxQ, why: 'no free margin' };
  if (!(qty > 0)) return { lev, max: maxQ, why: `${pct}% is less than the minimum size` };
  if (qty * mk.px < 1) return { lev, max: maxQ, why: 'below the Vest minimum ($1 notional)' };
  return { lev, max: maxQ, qty };
}

const positionOn = (accountId, symbol) => ((S.state[accountId] || {}).positions || []).find((p) => p.symbol === symbol) || null;
const placeholderOn = (accountId, symbol) => ((S.state[accountId] || {}).placeholders || []).find((p) => p.symbol === symbol) || null;

/**
 * Where a new entry goes: onto the open position, onto the placeholder of a pending limit (Vest rejects a second /open on
 * the market: 10006), or /open if there is nothing. Same side required: an opposite entry would reverse or clash.
 */
function target(accountId, symbol, side, what) {
  const pos = positionOn(accountId, symbol);
  if (pos) {
    if (pos.side !== side) throw new Error(`you are ${pos.side.toUpperCase()}: ${what} ${side === 'long' ? 'BUY' : 'SELL'} would reduce or reverse the position. Use CUT or FLAT`);
    return pos;
  }
  const ph = placeholderOn(accountId, symbol);
  if (ph) {
    if (ph.side !== side) throw new Error(`there is already a pending ${ph.side === 'long' ? 'BUY' : 'SELL'} order on this market: Vest keeps one side per market (cancel it first)`);
    return ph;
  }
  return null;
}

function checkPct(pct, cap) {
  if (!(pct > 0)) throw new Error('set the size in % in the second card');
  if (!(cap > 0)) throw new Error('size cap not set in the panel');
  if (pct > cap) throw new Error(`${pct}% exceeds the per-order cap (${cap}%): raise it in the panel if intended`);
}

/** LIMIT: entry limit at the price where it was dropped. Side: below the price buys, above sells. */
async function placeLimit({ accountId, symbol, price, pct, cap }) {
  checkPct(pct, cap);
  const m = S.symbols[symbol],
    mk = S.marks[symbol];
  const side = Z.entrySide('lm', price, mk && mk.px);
  if (!side) throw new Error('current price not available');
  if (Z.tooClose(price, mk.px, m.tick)) throw new Error('too close to the price: to enter now use ADD or the ticket');
  const sz = sizeFor(accountId, symbol, pct);
  if (sz.why) throw new Error(sz.why);
  const pos = target(accountId, symbol, side, 'a limit');
  const order = pos
    ? Z.appendOrder({ pos, qty: sz.qty, leverage: sz.lev, step: m.step, tick: m.tick, type: 'limit', price })
    : Z.openOrder({ symbol, side, qty: sz.qty, leverage: sz.lev, step: m.step, tick: m.tick, type: 'limit', price });
  const br = withBracket(order, side, price, m);
  const label = `LIMIT ${side === 'long' ? 'BUY' : 'SELL'} ${sz.qty} @ ${price}${pos ? (pos.qty > 0 ? ' (add)' : ' (next to the pending orders)') : ''}${br}`;
  return orders.send(accountId, order, label, pos ? pos.id : null);
}

/**
 * Entry grid: LIMITs sent one after the other. The first one opens (with the bracket if it is on), the others are added next
 * to it (/append on Vest's placeholder): before each of them the placeholder must be visible, otherwise Vest would refuse
 * a second /open on the market. legs = [{ n, side, price, qty }].
 */
async function placeGrid({ accountId, symbol, legs, lev }) {
  const m = S.symbols[symbol];
  let sent = 0;
  for (const l of legs) {
    let pos = target(accountId, symbol, l.side, 'a grid limit');
    if (!pos && sent > 0) {
      for (let i = 0; i < 30 && !pos; i++) {
        await new Promise((r) => setTimeout(r, 200));
        pos = target(accountId, symbol, l.side, 'a grid limit');
      }
      if (!pos) throw new Error(`${sent} grid LIMIT(s) sent; the others NOT sent: the first one is not visible on Vest yet`);
    }
    const order = pos
      ? Z.appendOrder({ pos, qty: l.qty, leverage: lev, step: m.step, tick: m.tick, type: 'limit', price: l.price })
      : Z.openOrder({ symbol, side: l.side, qty: l.qty, leverage: lev, step: m.step, tick: m.tick, type: 'limit', price: l.price });
    const br = pos ? '' : withBracket(order, l.side, l.price, m);
    await orders.send(accountId, order, `GRID ${l.side === 'long' ? 'BUY' : 'SELL'}${l.n} LIMIT ${l.qty} @ ${l.price}${br}`, pos ? pos.id : null);
    sent++;
  }
  return sent;
}

/** Market entry (used by ADD and by the local stop). Adds if there is a position on the same side. */
async function marketEntry({ accountId, symbol, side, qty, lev, why, br }) {
  const m = S.symbols[symbol];
  const pos = target(accountId, symbol, side, 'an entry');
  const order = pos
    ? Z.appendOrder({ pos, qty, leverage: lev, step: m.step, tick: m.tick, type: 'market' })
    : Z.openOrder({ symbol, side, qty, leverage: lev, step: m.step, tick: m.tick, type: 'market' });
  const mk = S.marks[symbol];
  const bl = withBracket(order, side, mk && mk.px, m, br);
  return orders.send(accountId, order, `${why} ${side === 'long' ? 'BUY' : 'SELL'} ${qty} at market${pos ? ' (add)' : ''}${bl}`, pos ? pos.id : null);
}

/** SHORT / LONG of the second card: market entry with the size in %, on the chosen side (add if already on the same side). */
async function marketOpen({ accountId, symbol, side, pct, cap }) {
  checkPct(pct, cap);
  const sz = sizeFor(accountId, symbol, pct);
  if (sz.why) throw new Error(sz.why);
  const pos = positionOn(accountId, symbol);
  // opposite side to the position: CUT of the given size, never beyond the position (no reversal: FLAT closes everything)
  if (pos && pos.side !== side) return cutQty({ accountId, symbol, pos, qty: Math.min(sz.qty, pos.qty), why: side.toUpperCase() });
  return marketEntry({ accountId, symbol, side, qty: sz.qty, lev: sz.lev, why: side === 'long' ? 'LONG' : 'SHORT' });
}

/** Market reduction of a quantity (rounded down to the step). The whole position = close. */
async function cutQty({ accountId, symbol, pos, qty, why }) {
  const m = S.symbols[symbol];
  const q = floorStep(qty, m.step);
  if (!(q > 0)) throw new Error('quantity to cut below the minimum size');
  const lev = pos.leverage > 0 ? pos.leverage : sizeFor(accountId, symbol, 1).lev || 50;
  // size >= position: real close (/close), not a reduce that could leave leftovers
  if (q >= pos.qty) return orders.send(accountId, closeOrder(pos), `${why}: close of the whole position (${pos.qty})`, pos.id);
  return orders.send(accountId, Z.reduceOrder({ pos, qty: q, leverage: lev, step: m.step }), `${why}: cut ${q} of ${pos.qty}`, pos.id);
}

/**
 * CLOSE %: closes the given percentage of the position at market, WITHOUT cancelling the pending orders (unlike FLAT).
 * 100% = reduce of the whole size (reduceAll, the LIMITs stay); less = reduce of that part.
 */
async function closePct({ accountId, symbol, pct }) {
  if (!(pct > 0 && pct <= 100)) throw new Error('close percentage between 1 and 100');
  const pos = positionOn(accountId, symbol);
  if (!pos) throw new Error('no open position to close');
  if (pct >= 100) return reduceAll({ accountId, symbol }); // /close would cancel the LIMITs
  return cutQty({ accountId, symbol, pos, qty: (pos.qty * pct) / 100, why: `CLOSE ${pct}%` });
}

/**
 * Closes the whole position with a REDUCE of the full size instead of /close: the attached LIMITs stay (checked on a real
 * account); with /close they disappear. Used by CLOSE, by the label's X and by PARTIAL CLOSE at 100%.
 */
async function reduceAll({ accountId, symbol }) {
  const pos = positionOn(accountId, symbol);
  if (!pos) throw new Error('no open position to close');
  const m = S.symbols[symbol];
  const lev = pos.leverage > 0 ? pos.leverage : sizeFor(accountId, symbol, 1).lev || 50;
  return orders.send(accountId, Z.reduceOrder({ pos, qty: pos.qty, leverage: lev, step: m.step }), `CLOSE: reduce of the whole position (${pos.qty}), pending orders left`, pos.id);
}

/** ADD: adds the percentage size to the open position, at market. */
async function addMarket({ accountId, symbol, pct, cap }) {
  checkPct(pct, cap);
  const pos = positionOn(accountId, symbol);
  if (!pos) throw new Error('no open position to add to');
  const sz = sizeFor(accountId, symbol, pct);
  if (sz.why) throw new Error(sz.why);
  return marketEntry({ accountId, symbol, side: pos.side, qty: sz.qty, lev: sz.lev, why: 'ADD' });
}

/** CUT: cuts 50% of the position at market (rounded down to the step). */
async function cutHalf({ accountId, symbol }) {
  const pos = positionOn(accountId, symbol);
  if (!pos) throw new Error('no open position to cut');
  const m = S.symbols[symbol];
  const qty = floorStep(pos.qty / 2, m.step);
  if (!(qty > 0)) throw new Error('half the position is below the minimum size: use FLAT');
  const lev = pos.leverage > 0 ? pos.leverage : sizeFor(accountId, symbol, 1).lev || 50;
  return orders.send(accountId, Z.reduceOrder({ pos, qty, leverage: lev, step: m.step }), `CUT 50%: ${qty} of ${pos.qty}`, pos.id);
}

/**
 * Moves a Vest LIMIT dragged on the chart. Vest has no "modify order": as Vest itself does, it is cancelled and
 * placed again. Order: FIRST the new one (attached to the same placeholder/position, which exists while the old one
 * is there), THEN the old one is cancelled. If the new one fails, the old one stays where it was.
 */
async function moveLimit({ accountId, symbol, order, price }) {
  const m = S.symbols[symbol],
    mk = S.marks[symbol];
  if (order.reduceOnly) throw new Error('close order: it cannot be moved from here, cancel it and place it again');
  const side = Z.entrySide('lm', price, mk && mk.px);
  if (!side) throw new Error('current price not available');
  const w = order.side === 'long' ? 'BUY' : 'SELL';
  if (side !== order.side) throw new Error(`a ${w} limit goes ${order.side === 'long' ? 'below' : 'above'} the price: for the other side cancel it and place a new one`);
  if (Z.tooClose(price, mk.px, m.tick)) throw new Error('too close to the price');
  if (Math.abs(price - order.price) < m.tick / 2) return null;
  const pos = target(accountId, symbol, side, 'the move');
  const lev = pos && pos.leverage > 0 ? pos.leverage : sizeFor(accountId, symbol, 1).lev;
  if (!(lev > 0)) throw new Error('leverage unknown for this market');
  const nu = pos
    ? Z.appendOrder({ pos, qty: order.qty, leverage: lev, step: m.step, tick: m.tick, type: 'limit', price })
    : Z.openOrder({ symbol, side, qty: order.qty, leverage: lev, step: m.step, tick: m.tick, type: 'limit', price });
  const br = withBracket(nu, side, price, m);
  await orders.send(accountId, nu, `LIMIT ${w} ${order.qty} moved ${order.price} -> ${price} (new)${br}`, pos ? pos.id : null);
  try {
    await cancelOrder({ accountId, orderId: order.id, label: `LIMIT ${w} @ ${order.price} (moved to ${price})` });
  } catch (e) {
    throw new Error(`WARNING: new LIMIT at ${price} placed but the old one at ${order.price} NOT cancelled (${e.message}): cancel it with the X`);
  }
  return true;
}

/**
 * Risk & targets in Active mode: new trade with the plan's size and its SL / TP legs in the same /open request
 * (market, or limit at price). plan = { qty, sl, targets: [{ price, qty }], each }.
 * Only on a free market: Vest attaches legs to /open only, while orders added to a position or to a pending order
 * go through /append, which has no legs.
 */
async function planOpen({ accountId, symbol, side, type, price, plan }) {
  const m = S.symbols[symbol],
    mk = S.marks[symbol];
  if (!m || !(mk && mk.px > 0)) throw new Error('market or price not read yet');
  if (positionOn(accountId, symbol)) throw new Error('Risk plan: there is already a position on this market. The plan opens new trades only (Manual mode to add)');
  if (placeholderOn(accountId, symbol)) throw new Error('Risk plan: there is already a pending order on this market (SL / TP attach only to the first order): cancel it first');
  const w = side === 'long' ? 'BUY' : 'SELL';
  const ref = type === 'limit' ? price : mk.px;
  if (type === 'limit') {
    if (Z.entrySide('lm', price, mk.px) !== side) throw new Error(`a ${w} limit goes ${side === 'long' ? 'below' : 'above'} the price`);
    if (Z.tooClose(price, mk.px, m.tick)) throw new Error('too close to the price');
  }
  if (!(plan && plan.qty > 0)) throw new Error('Risk plan: no size (check the Risk & targets section)');
  if ((side === 'long' ? 1 : -1) * (ref - plan.sl) <= 0) throw new Error(`Risk plan: the stop ${plan.sl} is on the wrong side of the entry ${ref}`);
  const sz = sizeFor(accountId, symbol, 100);
  if (!(sz.lev > 0)) throw new Error(sz.why || 'leverage unknown for this market');
  if (sz.max > 0 && plan.qty > sz.max) throw new Error(`Risk plan: size ${plan.qty} above what the margin allows (${sz.max})`);
  if (plan.qty * mk.px < 1) throw new Error('below the Vest minimum ($1 notional)');
  const legs = entryLegs({ qty: plan.qty, sl: plan.sl, targets: plan.targets, each: plan.each, step: m.step, tick: m.tick });
  if (legs.why) throw new Error('Risk plan: ' + legs.why);
  const order = Z.openOrder({ symbol, side, qty: plan.qty, leverage: sz.lev, step: m.step, tick: m.tick, type, price });
  order.body.takeProfits = legs.takeProfits;
  order.body.stopLosses = legs.stopLosses;
  const label = `PLAN ${w} ${plan.qty} ${type === 'limit' ? '@ ' + price : 'at market'} with SL ${plan.sl} and ${legs.takeProfits.length} TP`;
  return orders.send(accountId, order, label, null);
}

/** Pending orders of the account on a market (Vest limits). */
const pendingOn = (accountId, symbol) => ((S.state[accountId] || {}).orders || []).filter((o) => o.symbol === symbol);

/**
 * Moves the LIMIT of an Active plan: cancelled, then placed again at the new price with the legs recalculated there
 * (a /append move would lose them). If the new one is refused, nothing stays pending: said clearly.
 */
async function planMove({ accountId, symbol, order, price, plan }) {
  const w = order.side === 'long' ? 'BUY' : 'SELL';
  // checked BEFORE cancelling: when the new /open would surely be refused, the old LIMIT is left where it is
  if (positionOn(accountId, symbol)) throw new Error('Risk plan: there is a position on this market, the LIMIT is left as it is');
  if (pendingOn(accountId, symbol).some((o) => o.id !== order.id)) throw new Error('Risk plan: other pending orders on this market, the LIMIT is left as it is (SL / TP attach only to a single order)');
  const m = S.symbols[symbol];
  if (!(plan && plan.qty > 0) || !m) throw new Error('Risk plan: no size');
  const legs = entryLegs({ qty: plan.qty, sl: plan.sl, targets: plan.targets, each: plan.each, step: m.step, tick: m.tick });
  if (legs.why) throw new Error('Risk plan: ' + legs.why + ', the LIMIT is left as it is');
  await cancelOrder({ accountId, orderId: order.id, label: `LIMIT ${w} @ ${order.price} (plan moved to ${price})` });
  // Vest needs a moment to drop the pending slot (placeholder): a new /open before that is refused
  for (let i = 0; i < 25 && (placeholderOn(accountId, symbol) || pendingOn(accountId, symbol).some((o) => o.id === order.id)); i++) await new Promise((r) => setTimeout(r, 200));
  try {
    return await planOpen({ accountId, symbol, side: order.side, type: 'limit', price, plan });
  } catch (e) {
    throw new Error(`old LIMIT cancelled, new one at ${price} NOT placed (${e.message}): nothing is pending now`);
  }
}

/** Cancels a pending order. */
function cancelOrder({ accountId, orderId, label }) {
  return orders.send(accountId, { method: 'POST', path: '/v3/positions/cancel-order', body: { orderId } }, `cancel ${label || orderId}`, null);
}

module.exports = { placeGrid, setBracket, planOpen, planMove, sizeFor, positionOn, placeholderOn, target, marketOpen, closePct, reduceAll, moveLimit, placeLimit, marketEntry, addMarket, cutHalf, cancelOrder, checkPct };
