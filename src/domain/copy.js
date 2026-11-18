// Copier, PURE part: from the master's successful order to each copy's order. No network, no state.
// MARKET entries and adds, reductions and closes. PENDING orders (limits, ticket stops, limit reductions) with the same
// price/trigger and the size in proportion; cancellations are handled by copier.js with the map
// master order -> copies' orders. SL/TP on the position: added, moved and removed on the copy's position at the same
// price; the copy's leg is recognised by the price of the master's leg before the change.
// Sizing: 1:1 = same size; Cap-to-fit = size proportional to equity, ONLY scaling down
// (a copy that is larger or equal sends the master's size), with a 5% margin and rounded down to the step.

const Z = require('./sizing');
const { closeOrder } = require('./orders');
const { floorStep, decimalsOf } = require('./num');

const CAP_BUFFER = 0.95; // 5% margin below the proportional size (fees, equity read a moment earlier)
const CAP_SAME_SIZE = 0.005; // equity within 0.5% of the master = same size (accounts equal to a few cents)
const EPS = 1e-9;

const ACTION_RE = /\/v3\/positions\/(open|append|reduce|close|cancel-order|stop-loss|take-profit)(\?|$)/;
/** Action of an order from its path: 'open', 'append', 'reduce', 'close', ... or null. */
const actionOf = (path) => (String(path).match(ACTION_RE) || [])[1] || null;

/** Size of a copy for an entry. { qty, scaled } or { skip: reason }. */
function capQty({ mode, masterQty, mEq, fEq, step }) {
  const mQ = +masterQty;
  if (!(mQ > 0)) return { skip: 'invalid master size' };
  if (mode !== 'cap') return { qty: mQ, scaled: false };
  // without equity it cannot scale: better to skip than to send the full size to a possibly much smaller account
  if (!(mEq > 0) || !(fEq > 0)) return { skip: 'equity unknown: Cap-to-fit cannot compute the size' };
  const prop = (mQ * fEq) / mEq;
  if (prop >= mQ || fEq >= mEq * (1 - CAP_SAME_SIZE)) return { qty: mQ, scaled: false };
  const q = floorStep(prop * CAP_BUFFER, step);
  if (!(q > 0)) return { skip: 'proportional size below the minimum size' };
  return { qty: q, scaled: true };
}

/** Master quantity (add or reduction) scaled to the copy's size, in the same proportion. */
function scaleQty(reqQty, followerQty, masterQty, step) {
  const rq = +reqQty,
    fq = +followerQty,
    mq = +masterQty;
  if (!(rq > 0) || !(fq > 0) || !(mq > 0)) return 0;
  if (Math.abs(fq - mq) < EPS) return floorStep(rq, step);
  return floorStep((rq * fq) / mq, step);
}

/**
 * Order to send to a copy.
 * in: { action, body (of the master's order), mBefore (master's position BEFORE the order, or null),
 *       fPos (copy's position on the market, or null), fPh (placeholder of a copy's limit, or null),
 *       mode ('1:1'|'cap'), mEq, fEq, step, tick, fLev (leverage to use for the copy) }
 * out: { order, label, positionId } or { skip: reason } or { notCopied: reason } (action not supported).
 */
function planFollower(p) {
  const { action, body = {}, mBefore, fPos, fPh, step, tick } = p;
  const lev = p.fLev > 0 ? p.fLev : +body.leverage || null;
  const market = String(body.orderType || 'market').toLowerCase() === 'market';
  if (!market && (action === 'open' || action === 'append' || action === 'reduce')) return planPending(p, lev);
  if (action === 'stop-loss' || action === 'take-profit') return planLeg(p);
  if (action === 'open' || action === 'append') {
    if (!(lev > 0)) return { skip: 'leverage unknown' };
    const side = action === 'open' ? body.side : mBefore ? mBefore.side : body.isBuy === true ? 'long' : body.isBuy === false ? 'short' : null;
    const symbol = body.symbol || (mBefore && mBefore.symbol);
    if (!side || !symbol) return { skip: 'order side or market not recognised' };
    // add on a copy already in the trade: same proportion as the current sizes; otherwise like a new entry
    let q;
    if (action === 'append' && fPos && mBefore && mBefore.qty > 0) q = scaleQty(body.quantity, fPos.qty, mBefore.qty, step);
    else {
      const c = capQty({ mode: p.mode, masterQty: body.quantity, mEq: p.mEq, fEq: p.fEq, step });
      if (c.skip) return { skip: c.skip };
      q = c.qty;
    }
    if (!(q > 0)) return { skip: 'size below the minimum size' };
    const word = side === 'long' ? 'BUY' : 'SELL';
    const on = fPos || fPh;
    if (on) {
      // Vest keeps one side per market: on the opposite side the copy is not touched
      if (on.side !== side) return { skip: `the copy is ${on.side.toUpperCase()} on this market: ${word} entry not copied` };
      return { order: Z.appendOrder({ pos: on, qty: q, leverage: lev, step, tick, type: 'market' }), label: `${word} ${q} at market (add)`, positionId: on.id };
    }
    if (action === 'append') return { skip: 'the copy is not in the trade: add not copied' };
    const order = Z.openOrder({ symbol, side, qty: q, leverage: lev, step, tick, type: 'market' });
    // SL/TP attached to the entry (Vest ticket): those without a quantity are copied, as for pending orders
    order.body.takeProfits = wholeLegs(body.takeProfits);
    order.body.stopLosses = wholeLegs(body.stopLosses);
    const nl = order.body.takeProfits.length + order.body.stopLosses.length;
    return { order, label: `${word} ${q} at market${nl ? ` with ${nl} SL/TP` : ''}`, positionId: null };
  }
  if (action === 'reduce' || action === 'close') {
    if (!fPos) return { skip: 'the copy has no position on this market' };
    if (mBefore && mBefore.side && fPos.side !== mBefore.side) return { skip: 'the copy is on the opposite side to the master: not reduced' };
    if (!(lev > 0) && action === 'reduce') return { skip: 'leverage unknown' };
    if (action === 'close') return { order: closeOrder(fPos), label: `close of the whole position (${fPos.qty})`, positionId: fPos.id };
    if (!mBefore || !(mBefore.qty > 0)) return { skip: 'master position before the reduction unknown' };
    // the master reduces everything: the copy reduces everything (reduce, not /close: the LIMITs stay, as for the master)
    const all = +body.quantity >= mBefore.qty - EPS;
    const q = all ? fPos.qty : scaleQty(body.quantity, fPos.qty, mBefore.qty, step);
    if (!(q > 0)) return { skip: 'proportional reduction below the minimum size' };
    return { order: Z.reduceOrder({ pos: fPos, qty: Math.min(q, fPos.qty), leverage: lev, step }), label: all ? `reduce of the whole position (${fPos.qty})` : `reduce ${q} of ${fPos.qty}`, positionId: fPos.id };
  }
  return { notCopied: `${action || 'order'}: not copied` };
}

const wholeLegs = (l) => (Array.isArray(l) ? l.filter((x) => x && x.quantity == null) : []);

/**
 * SL/TP on the master's position -> same level on the copy's position.
 * POST = add, PUT = move (stopLossId/takeProfitId), DELETE = remove. The copy's leg to move/remove is the one of the
 * same kind at the same price as the master's leg BEFORE the change; if there is none, the only one of that kind.
 * A move with no matching leg on the copy becomes an add.
 */
function planLeg(p) {
  const { action, body = {}, mBefore, fPos, step } = p;
  const method = String(p.method || 'POST').toUpperCase();
  const kind = action === 'stop-loss' ? 'sl' : 'tp';
  const idKey = kind === 'sl' ? 'stopLossId' : 'takeProfitId';
  const KIND = kind.toUpperCase();
  if (!fPos) return { skip: `the copy has no position: ${KIND} not copied` };
  if (mBefore && mBefore.side && fPos.side !== mBefore.side) return { skip: `the copy is on the opposite side to the master: ${KIND} not copied` };
  const fLegs = (fPos.triggers || []).filter((t) => t.kind === kind);
  let fLeg = null;
  if (method !== 'POST') {
    const mLeg = mBefore && (mBefore.triggers || []).find((t) => t.id === body[idKey]);
    fLeg = (mLeg && fLegs.find((t) => Math.abs(t.price - mLeg.price) < 1e-9)) || (fLegs.length === 1 ? fLegs[0] : null);
  }
  const path = `/v3/positions/${action}`;
  if (method === 'DELETE') {
    if (!fLeg) return { skip: `${KIND} to remove not found on the copy` };
    return { order: { method: 'DELETE', path, body: { positionId: fPos.id, [idKey]: fLeg.id } }, label: `${KIND} removed`, positionId: fPos.id };
  }
  const b = { ...Object.fromEntries(Object.entries(body).filter(([k]) => !['positionId', 'quantity', idKey].includes(k))), positionId: fPos.id };
  // partial leg: quantity in proportion to the copy's position
  if (body.quantity != null) {
    if (!mBefore || !(mBefore.qty > 0)) return { skip: `partial ${KIND}: master position unknown` };
    const q = Math.min(fPos.qty, scaleQty(body.quantity, fPos.qty, mBefore.qty, step));
    if (!(q > 0)) return { skip: `partial ${KIND} below the minimum size` };
    b.quantity = fmtQ(q, step);
  }
  if (method === 'PUT' && fLeg) return { order: { method: 'PUT', path, body: { ...b, [idKey]: fLeg.id } }, label: `${KIND} moved to ${body.triggerPrice}`, positionId: fPos.id };
  return { order: { method: 'POST', path, body: b }, label: `${KIND} at ${body.triggerPrice}${method === 'PUT' ? ' (moved on the master, missing on the copy)' : ''}`, positionId: fPos.id };
}

const fmtQ = (q, step) => q.toFixed(decimalsOf(step));
// master fields that describe the pending order (price, trigger, expiry, type) are copied as they are;
// those that depend on the account (position, size, leverage, side) are rebuilt for the copy
const OWN = ['positionId', 'quantity', 'leverage', 'side', 'isBuy', 'takeProfits', 'stopLosses', 'symbol'];
const pendingBase = (body) => Object.fromEntries(Object.entries(body).filter(([k]) => !OWN.includes(k)));
const pw = (body) => `${String(body.orderType || '').toUpperCase()} @ ${body.price ?? body.triggerPrice ?? '?'}`;

/** PENDING order (limit, stop, ...) of the master: same price/trigger, size in proportion. */
function planPending(p, lev) {
  const { action, body, mBefore, fPos, fPh, step } = p;
  if (!(lev > 0)) return { skip: 'leverage unknown' };
  if (action === 'reduce') {
    if (!fPos) return { skip: 'the copy has no position on this market: pending reduction not copied' };
    if (mBefore && mBefore.side && fPos.side !== mBefore.side) return { skip: 'the copy is on the opposite side to the master' };
    if (!mBefore || !(mBefore.qty > 0)) return { skip: 'master position unknown' };
    const all = +body.quantity >= mBefore.qty - EPS;
    const q = all ? fPos.qty : Math.min(fPos.qty, scaleQty(body.quantity, fPos.qty, mBefore.qty, step));
    if (!(q > 0)) return { skip: 'proportional reduction below the minimum size' };
    const b = { ...pendingBase(body), positionId: fPos.id, symbol: fPos.symbol, quantity: fmtQ(q, step), leverage: String(lev) };
    return { order: { method: 'POST', path: '/v3/positions/reduce', body: b }, label: `reduce ${q} ${pw(body)} (pending)`, positionId: fPos.id, pending: true };
  }
  const side = action === 'open' ? body.side : mBefore ? mBefore.side : body.isBuy === true ? 'long' : body.isBuy === false ? 'short' : null;
  const symbol = body.symbol || (mBefore && mBefore.symbol);
  if (!side || !symbol) return { skip: 'order side or market not recognised' };
  // in proportion to the copy's position if both are in the trade, otherwise like a new entry (1:1 / Cap-to-fit)
  let q;
  if (fPos && mBefore && mBefore.qty > 0 && fPos.side === side) q = scaleQty(body.quantity, fPos.qty, mBefore.qty, step);
  else {
    const c = capQty({ mode: p.mode, masterQty: body.quantity, mEq: p.mEq, fEq: p.fEq, step });
    if (c.skip) return { skip: c.skip };
    q = c.qty;
  }
  if (!(q > 0)) return { skip: 'size below the minimum size' };
  const word = side === 'long' ? 'BUY' : 'SELL';
  const on = fPos || fPh;
  if (on && on.side !== side) return { skip: `the copy is ${on.side.toUpperCase()} on this market: pending ${word} not copied` };
  const base = { ...pendingBase(body), symbol, quantity: fmtQ(q, step), leverage: String(lev) };
  // already a position or a placeholder on the market: a second /open would be rejected ("already exists"), so add to it
  if (on)
    return {
      order: { method: 'POST', path: '/v3/positions/append', body: { ...base, positionId: on.id, isBuy: side === 'long' } },
      label: `${word} ${q} ${pw(body)} (pending, add)`,
      positionId: on.id,
      pending: true,
    };
  // attached legs without a quantity (covering the whole position) are copied; those with a quantity are not (they would need rescaling)
  const b = { ...base, side, takeProfits: wholeLegs(body.takeProfits), stopLosses: wholeLegs(body.stopLosses) };
  return { order: { method: 'POST', path: '/v3/positions/open', body: b }, label: `${word} ${q} ${pw(body)} (pending)`, positionId: null, pending: true };
}

/**
 * Markets the master has LEFT: it had a position (prev) and now does not.
 * in: prev = Set of symbols, positions = master's current positions. out: { gone: [symbols], now: Set }.
 */
function exitedSymbols(prev, positions) {
  const now = new Set((positions || []).filter((p) => p && p.qty > 0 && p.symbol).map((p) => p.symbol));
  return { gone: [...(prev || [])].filter((s) => !now.has(s)), now };
}

/** Id of the created order, from Vest's response (orderId in camelCase or snake_case). */
const orderIdOf = (res) => (res && (res.orderId || res.order_id || (res.order && (res.order.orderId || res.order.id)))) || null;

module.exports = { actionOf, capQty, scaleQty, planFollower, orderIdOf, exitedSymbols, CAP_BUFFER, CAP_SAME_SIZE };
