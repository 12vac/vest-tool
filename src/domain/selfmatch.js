// SELF-MATCHING guard (PURE). Vest policy shared by Gerry 2026-11-25: positions on opposite sides across accounts are
// allowed, but an order of one account must never trade against an order of ANOTHER account of the same user.
// Before an order is sent, its side / price are compared with the pending orders of the user's other accounts on the
// same market: if it could execute against one of them, it is reported.
// Known limits: only orders sent by the tool are checked (Vest's ticket is not); the other accounts' orders are as last
// read (feed / REST, about 1 s old); SL / TP turn into market orders on Vest's side and cannot be checked here.

const NEAR_TICKS = 4; // a market order is treated as able to hit a resting order up to this many ticks from the mark

/** Side ('buy' | 'sell'), market, type and price of an order that can execute, or null (cancel, SL / TP, ...). */
function sideOf(order, posOf) {
  const path = String((order && order.path) || '');
  const b = (order && order.body) || {};
  const m = path.match(/\/v3\/positions\/(open|append|reduce|close)$/);
  if (!m) return null;
  const kind = m[1];
  const type = b.orderType === 'limit' ? 'limit' : 'market';
  const price = type === 'limit' ? +b.price : NaN;
  if (kind === 'open') {
    const s = String(b.side || '').toLowerCase();
    const buy = s === 'long' || s === 'buy' || b.isBuy === true;
    return { kind, exit: false, side: buy ? 'buy' : 'sell', symbol: b.symbol, type, price };
  }
  if (kind === 'append') return { kind, exit: false, side: b.isBuy ? 'buy' : 'sell', symbol: b.symbol, type, price };
  // reduce / close: the side opposite to the position
  const pos = posOf(b.positionId);
  if (!pos) return null;
  return { kind, exit: true, side: pos.side === 'long' ? 'sell' : 'buy', symbol: pos.symbol || b.symbol, type, price };
}

/**
 * order { path, body }, accountId, accounts: { id: { label, orders: [{ id, symbol, side 'long'|'short', price, qty }],
 * positions: [{ id, symbol, side }] } }, mark (price), tick.
 * -> null, or { exit, text } (text names the other account and its order).
 */
function check({ order, accountId, accounts, mark, tick }) {
  const own = accounts[accountId] || {};
  const o = sideOf(order, (id) => (own.positions || []).find((p) => p.id === id));
  if (!o || !o.symbol) return null;
  const t = tick > 0 ? tick : 0;
  const hits = [];
  for (const [id, a] of Object.entries(accounts)) {
    if (id === accountId) continue;
    for (const r of a.orders || []) {
      if (r.symbol !== o.symbol || !(r.price > 0)) continue;
      const rBuy = r.side === 'long';
      if (rBuy === (o.side === 'buy')) continue; // same side: cannot trade against each other
      let cross;
      if (o.type === 'limit') cross = o.side === 'sell' ? o.price <= r.price + t / 2 : o.price >= r.price - t / 2;
      else if (Number.isFinite(mark)) cross = o.side === 'sell' ? r.price >= mark - NEAR_TICKS * t : r.price <= mark + NEAR_TICKS * t;
      else cross = true; // no price: better to report than to miss it
      if (cross) hits.push(`${a.label || id} has a pending ${rBuy ? 'BUY' : 'SELL'} ${r.qty} @ ${r.price}`);
    }
  }
  if (!hits.length) return null;
  const what = `${o.side.toUpperCase()} ${o.type}${o.type === 'limit' ? ' @ ' + o.price : ''} on ${o.symbol}`;
  return { exit: o.exit, text: `SELF-MATCH risk: ${what} could trade against your own order (${hits.join('; ')}): cancel that order first` };
}

module.exports = { check, sideOf, NEAR_TICKS };
