// "If all limits fill" calculator: size, average entry and P&L when the price touches the last entry limit
// (the farthest against the position), with the equity and drawdown left at that point. Calculation only, no orders.
// Excluded: local stops (they trigger at market, price not guaranteed), close orders (CL), fees and funding.

const { pnlUsd } = require('./money');
const { roundToTick } = require('./num');

/**
 * pos: { side, qty, openPrice } or null · orders: [{ id, side, price, qty }] Vest entry limits on the market
 * equity: account equity · mark: current price · floors: { total, daily } (equity below which it fails) · sl: SL price or null
 * Returns null if there are no useful limits, otherwise
 * { side, lastId, last, n, qty, avg, pnl, equityAt, ddLeft, floorKind, slPnl, slEquityAt, slDdLeft }
 */
function ladder({ pos, orders, equity, mark, floors, sl }) {
  const side = pos ? pos.side : orders.length ? orders[0].side : null;
  const lms = orders.filter((o) => o.side === side && o.price > 0 && o.qty > 0);
  if (!side || !lms.length) return null;
  const dir = side === 'long' ? 1 : -1;
  // last limit = the farthest against the position (long: the lowest)
  const lastO = lms.reduce((a, o) => (dir * o.price < dir * a.price ? o : a));
  let qty = pos ? pos.qty : 0,
    cost = pos ? pos.qty * pos.openPrice : 0;
  for (const o of lms) {
    qty += o.qty;
    cost += o.qty * o.price;
  }
  const avg = cost / qty;
  const last = lastO.price;
  const pnl = pnlUsd(side, qty, avg, last);
  // equity at that price: remove the open P&L of THIS position and add the one with the full grid
  const upnlNow = pos && mark > 0 ? pnlUsd(side, pos.qty, pos.openPrice, mark) : 0;
  const base = equity >= 0 ? equity - upnlNow : NaN;
  const equityAt = base + pnl;
  const t = floors && floors.total > 0 ? floors.total : 0,
    d = floors && floors.daily > 0 ? floors.daily : 0;
  const floor = Math.max(t, d);
  const out = { side, lastId: lastO.id, last, n: lms.length, qty, avg, pnl, equityAt, ddLeft: floor > 0 ? equityAt - floor : NaN, floorKind: !floor ? null : d > t ? 'daily' : 'total' };
  // open position + ONLY the next limit (the nearest against the position), if there is more than one
  if (pos && pos.qty > 0 && lms.length > 1) {
    const nextO = lms.reduce((a, o) => (dir * o.price > dir * a.price ? o : a));
    const q = pos.qty + nextO.qty;
    out.next = { id: nextO.id, price: nextO.price, qty: q, avg: (pos.qty * pos.openPrice + nextO.qty * nextO.price) / q };
  }
  // SL beyond the last limit: loss with the whole size
  if (sl > 0 && dir * sl < dir * last) {
    out.slPnl = pnlUsd(side, qty, avg, sl);
    out.slEquityAt = base + out.slPnl;
    out.slDdLeft = floor > 0 ? out.slEquityAt - floor : NaN;
  }
  return out;
}

/**
 * ACCOUNT FAIL price: price at which the equity reaches the drawdown limit (the nearer of total and daily),
 * counting the entry limits that fill on the way (the size grows at every limit reached before it).
 * Returns null with no position and no limits, without a drawdown limit, or if the equity is already below.
 * { price, qty, avg, filled (limits filled before), floor, floorKind, loss (P&L compared to now) }
 */
function knockout({ pos, orders, equity, mark, floors }) {
  const side = pos ? pos.side : orders.length ? orders[0].side : null;
  if (!side || !(equity >= 0)) return null;
  const t = floors && floors.total > 0 ? floors.total : 0,
    d = floors && floors.daily > 0 ? floors.daily : 0;
  const floor = Math.max(t, d);
  if (!(floor > 0) || equity <= floor) return null;
  const r = reach({ pos, orders, equity, mark, level: floor });
  return r && { ...r, floor, floorKind: d > t ? 'daily' : 'total', loss: floor - equity };
}

/**
 * Price at which the equity drops to `level`, with the entry limits that fill on the way (basis of the fail price).
 * equity(p) = base + dir*(qty*p - cost), base = equity without the open P&L of this position.
 * { side, price, qty, avg, filled, base } or null.
 */
function reach({ pos, orders, equity, mark, level }) {
  const side = pos ? pos.side : orders.length ? orders[0].side : null;
  if (!side || !(equity >= 0)) return null;
  const dir = side === 'long' ? 1 : -1;
  const upnlNow = pos && mark > 0 ? pnlUsd(side, pos.qty, pos.openPrice, mark) : 0;
  const base = equity - upnlNow;
  // limits against the position, nearest to farthest
  const lms = orders.filter((o) => o.side === side && o.price > 0 && o.qty > 0).sort((a, b) => dir * (b.price - a.price));
  let qty = pos ? pos.qty : 0,
    cost = pos ? pos.qty * pos.openPrice : 0,
    filled = 0;
  const solve = () => (cost + dir * (level - base)) / qty;
  for (const o of lms) {
    if (qty > 0) {
      const k = solve();
      if (dir * k > dir * o.price) return done(k); // the level comes before this limit
    }
    qty += o.qty;
    cost += o.qty * o.price;
    filled++;
  }
  if (!(qty > 0)) return null;
  return done(solve());
  function done(k) {
    return k > 0 ? { side, price: k, qty, avg: cost / qty, filled, base } : null;
  }
}

/**
 * 50% drawdown label as a "half fail price": available drawdown = balance - total floor (initial drawdown + overall
 * profit); price at which the position + the entry limits that fill first lose pct% of that available amount.
 * The level is fixed (base - half, base = equity without the open P&L): it does not move with the price. Rounded toward the
 * current price (loss <= half). afterKo: the nearer floor (e.g. daily) comes before the level.
 * { price, qty, avg, filled, avail, half, loss (position P&L at that price), fromNow, pl, ddInit, afterKo } or null.
 */
function ddHalf({ pos, orders = [], equity, balance, mark, floors, initial, tick, pct = 50 }) {
  const t = floors && floors.total > 0 ? floors.total : 0,
    d = floors && floors.daily > 0 ? floors.daily : 0;
  if (!(t > 0) || !(balance > 0) || !(tick > 0) || !(equity >= 0)) return null;
  const avail = balance - t;
  if (!(avail > 0)) return null;
  const half = (avail * pct) / 100;
  const side = pos ? pos.side : orders.length ? orders[0].side : null;
  if (!side) return null;
  const upnlNow = pos && mark > 0 ? pnlUsd(side, pos.qty, pos.openPrice, mark) : 0;
  const level = equity - upnlNow - half;
  const r = reach({ pos, orders, equity, mark, level });
  if (!r) return null;
  const dir = side === 'long' ? 1 : -1;
  const price = roundToTick(r.price, tick, dir > 0 ? 'up' : 'down');
  if (!(price > 0)) return null;
  // position P&L (with the filled limits) at the rounded price
  const loss = dir * (r.qty * price - r.avg * r.qty);
  return {
    price, qty: r.qty, avg: r.avg, filled: r.filled, avail, half, loss,
    fromNow: r.base + loss - equity,
    pl: initial > 0 ? balance - initial : NaN,
    ddInit: initial > 0 ? initial - t : NaN,
    afterKo: Math.max(t, d) >= level,
  };
}

module.exports = { ladder, knockout, reach, ddHalf };
