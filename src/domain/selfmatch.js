// SELF-MATCHING guard (PURE).
// Vest Prop Terms of Service (updated 2026-11-23), section 5: opposite positions across your own accounts are allowed;
// Self-Matching is not: your own opposite buy and sell orders executing against each other (also when you "know or
// reasonably should know" it will happen). Penalty: permanent ban. Vest matches orders against the resting order book
// (price-time priority), so a resting LIMIT on one account CAN be filled by an opposite order of another account.
//
// Rules (Gerry 2026-11-26):
// - an order is a risk when it is on the opposite side of a RESTING order on the same market and could cross it:
//   a buy at or above a resting sell, a sell at or below a resting buy; a MARKET order crosses at any price;
// - only OTHER accounts count: on the same account and market Vest itself refuses an order opposite to a pending LIMIT
//   or a position (seen by Gerry on Vest, 2026-11-26, from VestTool and from Vest's own ticket);
// - entries are blocked; a manual exit is blocked with a button that cancels the orders in the way and then closes;
//   an automatic exit (Account limits, Safe runner, copier) cancels them itself, says so, then goes out;
// - unknown or stale orders of another account: entries are blocked, exits are warned (see core/selfmatch.js).
// SL / TP legs: the tool sends them as executionType 'market', so they never rest on the book; when they trigger it is
// Vest that sends the market order, which this guard cannot see. Placing or moving a leg is only warned.

/** What an order does: { kind, exit, leg, side 'buy'|'sell', symbol, type 'limit'|'market', price } or null (cancel...). */
function sideOf(order, posOf) {
  const path = String((order && order.path) || '');
  const b = (order && order.body) || {};
  const m = path.match(/\/v3\/positions\/(open|append|reduce|close|stop-loss|take-profit)$/);
  if (!m) return null;
  const kind = m[1];
  if (String((order && order.method) || 'POST').toUpperCase() === 'DELETE') return null; // removing a leg
  const type = String(b.orderType || '').toLowerCase() === 'limit' ? 'limit' : 'market';
  const price = type === 'limit' ? +b.price : NaN;
  if (kind === 'open') {
    const s = String(b.side || '').toLowerCase();
    const buy = s === 'long' || s === 'buy' || b.isBuy === true;
    return { kind, exit: false, leg: false, side: buy ? 'buy' : 'sell', symbol: b.symbol, type, price };
  }
  const pos = b.positionId ? posOf(b.positionId) : null;
  if (kind === 'append') {
    const buy = b.isBuy != null ? b.isBuy === true : pos ? pos.side === 'long' : null;
    if (buy == null) return null;
    return { kind, exit: false, leg: false, side: buy ? 'buy' : 'sell', symbol: b.symbol || (pos && pos.symbol), type, price };
  }
  // reduce / close / SL / TP: the side opposite to the position
  if (!pos) return null;
  const leg = kind === 'stop-loss' || kind === 'take-profit';
  return { kind, exit: true, leg, side: pos.side === 'long' ? 'sell' : 'buy', symbol: pos.symbol || b.symbol, type: leg ? 'market' : type, price: leg ? NaN : price };
}

/** A resting order that can trade: price > 0, size not 0, side known. */
const resting = (r) => !!r && r.price > 0 && !(r.qty <= 0) && (r.side === 'long' || r.side === 'short');

/** Would an order { side, type, price } trade against the resting order r? Prices within half a tick count as equal. */
function crosses(o, r, tick) {
  if (!resting(r) || (r.side === 'long') === (o.side === 'buy')) return false; // same side never trades
  if (o.type !== 'limit' || !(o.price > 0)) return true; // market: at any price
  const t = tick > 0 ? tick / 2 : 0;
  return o.side === 'buy' ? o.price >= r.price - t : o.price <= r.price + t;
}

const fmt = (label, r) => `${label} ${r.side === 'long' ? 'BUY' : 'SELL'} ${r.qty} @ ${r.price}`;

/**
 * order { method, path, body }, accountId,
 * accounts: { id: { label, known (orders read and fresh), orders: [{ id, symbol, side 'long'|'short', price, qty }],
 *   positions: [{ id, symbol, side }] } }, tick, skip (Set of order ids already being cancelled),
 * position: { id, symbol, side } of an exit when the state does not hold it yet (fresh REST read of a FLAT).
 * -> null (nothing that can trade) or { exit, leg, symbol, what, hits: [{ accountId, label, orderId, text }], unknown: [label] }.
 */
function check({ order, accountId, accounts, tick, skip, position }) {
  const own = accounts[accountId] || {};
  const o = sideOf(order, (id) => (position && position.id === id ? position : (own.positions || []).find((p) => p.id === id)));
  if (!o || !o.symbol) return null;
  const hits = [],
    unknown = [];
  for (const [id, a] of Object.entries(accounts)) {
    if (id === accountId) continue; // same account: Vest refuses it by itself
    const label = a.label || id;
    if (!a.known) {
      unknown.push(label);
      continue;
    }
    for (const r of a.orders || []) {
      if (r.symbol !== o.symbol || (skip && skip.has(r.id))) continue;
      if (crosses(o, r, tick)) hits.push({ accountId: id, label, orderId: r.id, text: fmt(label, r) });
    }
  }
  const leg = o.kind === 'stop-loss' ? 'SL' : 'TP';
  const what = `${o.side.toUpperCase()} ${o.leg ? leg + ' (market when triggered)' : o.type + (o.type === 'limit' ? ' @ ' + o.price : '')} on ${o.symbol}`;
  return { exit: o.exit, leg: o.leg, symbol: o.symbol, what, hits, unknown };
}

/** Header text of a result ('' when nothing is wrong). blocked = the order was refused. */
function textOf(r, blocked) {
  if (!r) return '';
  const head = `SELF-MATCH ${blocked ? 'BLOCKED' : 'WARNING'}: ${r.what}`;
  if (r.hits.length) return `${head} could trade against your own resting order: ${r.hits.map((h) => h.text).join('; ')}`;
  if (r.unknown.length) return `${head}: the orders of ${r.unknown.join(', ')} are not read yet or out of date`;
  return '';
}

/**
 * Resting orders that ALREADY cross each other on the same market (read-only indicator).
 * accounts as in check(), tickOf(symbol). -> [{ symbol, buy: text, sell: text }]
 */
function crossings(accounts, tickOf) {
  const all = [];
  for (const [id, a] of Object.entries(accounts)) if (a.known) for (const r of a.orders || []) if (resting(r)) all.push({ r, id, label: a.label || id });
  const out = [];
  for (const b of all) {
    if (b.r.side !== 'long') continue;
    for (const s of all) {
      if (s.r.side !== 'short' || s.r.symbol !== b.r.symbol || s.id === b.id) continue; // same account: Vest refuses it
      const t = (tickOf && tickOf(b.r.symbol)) || 0;
      if (b.r.price >= s.r.price - t / 2) out.push({ symbol: b.r.symbol, buy: fmt(b.label, b.r), sell: fmt(s.label, s.r) });
    }
  }
  return out;
}

module.exports = { check, sideOf, crosses, crossings, textOf };
