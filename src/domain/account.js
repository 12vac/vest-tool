// Account model from REST and feed. PURE: takes data and "now", returns new objects.
// Field names as observed in Vest's API responses; see the API notes.

const { num, cmpSeq } = require('./num');
const { pnlUsd } = require('./money');

const typeName = (t, product) =>
  t === 2 ? 'Evaluation' : t === 3 ? (product === 'instant_funded' ? 'Instant' : 'Funded') : 'Other';

/** What a field looks like, without its value: for diagnostics (shareable without amounts). */
function classify(obj, key) {
  if (!obj || !(key in obj)) return 'missing';
  const v = obj[key];
  if (v === null || v === '') return 'empty';
  const n = num(v);
  if (!Number.isFinite(n)) return 'not a number';
  return n === 0 ? 'zero' : n > 0 ? 'positive' : 'negative';
}
const DAILY_FIELDS = ['daily_reset_equity', 'daily_reset_balance', 'daily_reset_base_limit', 'daily_loss_floor', 'max_daily_loss_pct'];

/** One item of GET /v3/capital/accounts/active -> fixed account data. */
function parseCapitalAccount(a) {
  const daily = num(a.daily_loss_floor);
  return {
    dailyInfo: Object.fromEntries(DAILY_FIELDS.map((k) => [k, classify(a, k)])),
    id: a.id,
    // [?] the name given to the account on Vest's site does not arrive in "name": other plausible field names are tried;
    // otherwise the name is set in the panel (store.setAlias)
    vestName: a.name || a.nickname || a.display_name || a.displayName || a.alias || a.label || null,
    // without a name: account number + last 6 digits of the id ("2 c028c8")
    label: a.name || a.nickname || a.display_name || a.displayName || a.alias || a.label || `${(a.attempt_index ?? 0) + 1} ${String(a.id).slice(-6)}`,
    type: typeName(a.account_type, a.plan_product_type),
    accountType: a.account_type,
    planId: a.plan_id || null,
    maxLeverage: num(a.max_leverage) || null,
    initial: num(a.initial_capital),
    floor: num(a.max_drawdown_limit), // equity below which the account fails
    dailyFloor: num(a.max_daily_loss_pct) > 0 && daily > 0 ? daily : null,
    target: num(a.target_equity) > num(a.initial_capital) ? num(a.target_equity) : null,
    // [D] equity at Vest's last daily reset (field seen on the site; meaning deduced from the name)
    dailyResetEquity: num(a.daily_reset_equity) > 0 ? num(a.daily_reset_equity) : null,
    // [L] allowed daily loss in $ (Vest's "Max. Daily Loss"), its % and the balance at reset it is computed on
    dailyLimit: num(a.daily_reset_base_limit) > 0 ? num(a.daily_reset_base_limit) : null,
    dailyPct: num(a.max_daily_loss_pct) > 0 ? num(a.max_daily_loss_pct) : null,
    dailyResetBalance: num(a.daily_reset_balance) > 0 ? num(a.daily_reset_balance) : null,
    order: a.attempt_index ?? 0,
  };
}

/** A leg (SL/TP) from REST. */
const legOf = (kind) => (b) => ({
  id: b.id || null,
  kind,
  price: num(b.triggerPrice),
  qty: b.quantity != null && b.sizeMode !== 'full_position' ? num(b.quantity) : null,
});

/** Time in ms from a number (s or ms) or an ISO string; NaN when missing. */
function msOf(v) {
  if (v == null || v === '') return NaN;
  const n = typeof v === 'number' ? v : /^\d+(\.\d+)?$/.test(String(v)) ? +v : Date.parse(v);
  return Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : NaN;
}

/** GET /v3/positions/opened -> open positions (quantity > 0). */
function parseRestPositions(res) {
  return ((res && res.positions) || [])
    .map((p) => ({
      id: p.positionId || p.position_id,
      symbol: p.symbol,
      side: p.side,
      qty: num(p.quantity),
      openPrice: num(p.openPrice),
      openedAt: msOf(p.openDate), // ms, NaN when Vest does not give it (safe runner: candle of the entry)
      collateral: num(p.collateral) || 0,
      leverage: num(p.leverage) || null,
      triggers: [...(p.takeProfits || []).map(legOf('tp')), ...(p.stopLosses || []).map(legOf('sl'))].filter(
        (l) => l.id,
      ),
    }))
    .filter((p) => p.id && p.qty > 0);
}

/**
 * PLACEHOLDER positions (size 0): Vest creates one for the pending limit order on a market.
 * A new /open on that market is rejected ("already exists", 10006): later orders go to append here.
 */
function parseRestPlaceholders(res) {
  return ((res && res.positions) || [])
    .filter((p) => (p.positionId || p.position_id) && p.symbol && !(num(p.quantity) > 0))
    .map((p) => ({
      id: p.positionId || p.position_id,
      symbol: p.symbol,
      side: p.side,
      qty: 0,
      leverage: num(p.leverage) || null,
      // SL / TP that Vest keeps on the pending LIMIT (sent with /open); null = Vest sent no list at all
      triggers: p.takeProfits || p.stopLosses ? [...(p.takeProfits || []).map(legOf('tp')), ...(p.stopLosses || []).map(legOf('sl'))] : null,
    }));
}

/**
 * A pending order from REST (camelCase) or from the feed (snake_case).
 * Returns { id, symbol, type, side, price, qty, reduceOnly, positionId } or null.
 */
function orderOf(o) {
  if (!o) return null;
  const id = o.orderId || o.order_id || o.id;
  if (!id) return null;
  const side = String(o.side || '').toLowerCase();
  const isBuy = o.isBuy === true || o.is_buy === true || side === 'buy' || side === 'long';
  return {
    id,
    symbol: o.symbol,
    type: o.orderType || o.order_type || null,
    side: isBuy ? 'long' : side === 'sell' || side === 'short' || o.isBuy === false || o.is_buy === false ? 'short' : null,
    price: num(o.price),
    qty: num(o.quantity),
    reduceOnly: !!(o.reduceOnly || o.reduce_only) || /CLOSE|REDUCE/i.test(o.positionOrderType || o.position_order_type || ''),
    positionId: o.positionId || o.position_id || null,
  };
}

/** GET /v3/positions/opened-orders -> collateral held by pending orders and list of limits. */
function parseRestOrders(res) {
  const list = (res && res.orders) || [];
  return {
    ordersCollateral: list.reduce((s, o) => (o.reduceOnly || o.reduce_only ? s : s + (num(o.collateral) || 0)), 0),
    orders: list.map(orderOf).filter(Boolean),
  };
}

const LIVE_ORDER = new Set(['pending', 'accepted', 'partially_filled']);
const TRIGGER_KIND = { stop_loss: 'sl', take_profit: 'tp' };

/** Feed position event: closed -> removed from the list; open with size -> replaced (keeps leverage and known SL/TP). */
function mergePosition(st, ev) {
  const id = ev.position_id;
  if (!id) return;
  const at = st.positions.findIndex((x) => x.id === id);
  const known = at < 0 ? null : st.positions[at];
  const gone = ev.status === 'closed' || String(ev.event_type || '').endsWith('CLOSED');
  if (gone) {
    if (known) st.positions = st.positions.filter((x) => x.id !== id);
    return;
  }
  const size = num(ev.quantity);
  if (ev.status !== 'opened' || !(size > 0)) return;
  const row = {
    id,
    symbol: ev.symbol,
    side: ev.side,
    qty: size,
    openPrice: num(ev.open_price),
    openedAt: known && Number.isFinite(known.openedAt) ? known.openedAt : msOf(ev.open_date ?? ev.created_at),
    collateral: num(ev.collateral) || 0,
    leverage: num(ev.leverage) || known?.leverage || null,
    triggers: known ? known.triggers : [],
  };
  st.positions = known ? st.positions.map((x) => (x.id === id ? row : x)) : [...st.positions, row];
}

/** SL/TP (order_intents) of a known position: active -> present, other state -> removed. */
function mergeTrigger(st, intent) {
  const kind = TRIGGER_KIND[intent.kind];
  const owner = kind ? st.positions.find((x) => x.id === intent.position_id) : null;
  if (!owner) return;
  const rest = owner.triggers.filter((t) => t.id !== intent.id);
  owner.triggers = intent.state === 'active' ? [...rest, { id: intent.id, kind, price: num(intent.trigger_price), qty: null }] : rest;
}

/** Pending order: stays in the list only if live and not fully filled yet. */
function mergeOrder(st, raw) {
  const o = orderOf(raw);
  if (!o) return;
  const others = (st.orders || []).filter((x) => x.id !== o.id);
  const live = LIVE_ORDER.has(raw.status) && !(num(raw.executed_quantity) >= o.qty);
  st.orders = live ? [...others, o] : others;
}

/** Free balance: accepted only if its version is not older than the one already seen. */
function mergeBalance(st, fb) {
  if (!fb) return;
  const amount = num(fb.amount);
  if (!(amount >= 0)) return;
  const ver = parseInt(fb.balance_version, 10);
  if (ver < st.balVer) return;
  st.free = amount;
  if (ver >= 0) st.balVer = ver;
}

/**
 * Applies a feed account_state event to an account's state.
 * Returns { state, applied } ; applied=false if the event is old or repeated (account_seq).
 */
function applyFeedState(prev, d, now) {
  const st = prev
    ? { ...prev, positions: prev.positions.map((p) => ({ ...p, triggers: p.triggers.slice() })) }
    : { positions: [], ordersCollateral: 0, free: NaN, balVer: -1, seq: null };
  // account_seq arrives as a string: compared without converting to a number
  const seq = d.account_seq != null && /^\d+$/.test(String(d.account_seq)) ? String(d.account_seq) : null;
  if (seq != null && st.seq != null && !(cmpSeq(seq, st.seq) > 0)) return { state: prev, applied: false };
  if (seq != null) st.seq = seq;

  const changes = d.positions || [];
  for (const ev of changes) mergePosition(st, ev);
  for (const intent of d.order_intents || []) mergeTrigger(st, intent);
  const oc = num(d.orders_collateral);
  if (d.orders_collateral != null && oc >= 0) st.ordersCollateral = oc;
  for (const raw of d.orders || []) mergeOrder(st, raw);
  mergeBalance(st, d.final_balance);
  st.feedAt = now;
  // posAt: last message that touched positions/orders. REST re-reads are discarded only for this, not for a
  // balance-only message (they arrive constantly for the account on screen and made REST always look "old")
  if ((d.positions || []).length || (d.orders || []).length || (d.order_intents || []).length) st.posAt = now;
  return { state: st, applied: true };
}

/**
 * $ values of an account.
 * Balance (cash) = free + position collateral + order collateral. Equity = balance + open P&L at the mark.
 * If a mark or the free balance is missing, falls back on the performance series equity (~1 minute late).
 * marks: { symbol: price }
 */
function valuesOf(acc, st, marks, perf, dayStartEq) {
  let balance = NaN,
    upnl = NaN,
    equity = NaN,
    source = null;
  if (st && st.free >= 0) {
    balance = st.free + st.positions.reduce((s, p) => s + p.collateral, 0) + (st.ordersCollateral || 0);
    let u = 0,
      ok = true;
    for (const p of st.positions) {
      const px = marks && marks[p.symbol];
      if (!(px > 0)) {
        ok = false;
        break;
      }
      u += pnlUsd(p.side, p.qty, p.openPrice, px);
    }
    if (ok) {
      upnl = u;
      equity = balance + u;
      source = 'live';
    }
  }
  if (!(equity >= 0) && perf && perf.equity >= 0) {
    equity = perf.equity;
    upnl = perf.upnl;
    if (!(balance >= 0)) balance = perf.equity - (perf.upnl || 0);
    source = 'series';
  }
  const floor = Math.max(acc.floor || 0, acc.dailyFloor || 0);
  return {
    balance,
    equity,
    upnl,
    source,
    totalPnl: equity - acc.initial,
    // P&L of the Vest day (from 20:00 New York): base = first point of the performance series
    dayPnl: dayStartEq >= 0 ? equity - dayStartEq : NaN,
    toFloor: floor > 0 ? equity - floor : NaN, // $ before the drawdown limit (the nearer of total and daily)
    toTarget: acc.target ? acc.target - equity : NaN,
  };
}

/**
 * Third card, like Vest's page (Max. Daily Loss / Max. Drawdown / Evaluation Goal): used and available in $.
 * [L] daily (real account): daily_reset_base_limit = max_daily_loss_pct x daily_reset_balance (196.36 = 4% of
 *     4908.94) = Vest's "Max. Daily Loss"; daily_loss_floor = daily_reset_balance - that limit. Base = BALANCE at reset, not equity.
 *     Used = limit - (equity - daily_loss_floor). Without the field: pct x balance at reset.
 * [D] maximum: limit = initial capital - max_drawdown_limit (right if the limit is fixed, not trailing).
 */
/**
 * man: manual limits from the panel (Gerry 2026-11-23, for Instant accounts that have none on Vest): { day: $ daily drawdown
 * limit, goal: $ profit target }; a value > 0 replaces Vest's. Manual daily: left = limit + P&L of the day.
 */
function limitsOf(a, v, man = {}) {
  if (!a || !(v.equity >= 0)) return {};
  const mDay = man.day > 0,
    mGoal = man.goal > 0;
  // P&L of the day on Vest's base (balance at daily reset); without the field, the series one (20:00 New York)
  const dayPl = a.dailyResetBalance > 0 ? v.equity - a.dailyResetBalance : v.dayPnl;
  const dayLimit = mDay ? man.day : !(a.dailyFloor > 0) ? NaN : a.dailyLimit > 0 ? a.dailyLimit : a.dailyPct > 0 && a.dailyResetBalance > 0 ? a.dailyPct * a.dailyResetBalance : NaN;
  const maxLimit = a.floor > 0 && a.initial > a.floor ? a.initial - a.floor : NaN;
  // room: $ left before the account fails. Daily = limit + P&L of the day (moves, 0 = account lost); maximum: static
  const dayLeft = mDay ? (Number.isFinite(dayPl) ? man.day + dayPl : NaN) : a.dailyFloor > 0 ? v.equity - a.dailyFloor : NaN;
  return {
    dayUsed: Math.max(0, dayLimit - dayLeft),
    dayLimit,
    maxUsed: Math.max(0, maxLimit - (v.equity - a.floor)),
    maxLimit,
    pl: v.equity - a.initial,
    goal: mGoal ? man.goal : a.target > a.initial ? a.target - a.initial : NaN,
    dayLeft,
    maxLeft: a.floor > 0 ? v.equity - a.floor : NaN,
    dayPl,
    dayManual: mDay,
    goalManual: mGoal,
  };
}
/**
 * Session P&L base: equity at the first value read in the day (local date).
 * record = { day, start: { id: equity } }. Returns a new record.
 */
function sessionBaseline(record, day, id, equity) {
  const rec = record && record.day === day ? { day, start: { ...record.start } } : { day, start: {} };
  if (rec.start[id] == null && equity >= 0) rec.start[id] = equity;
  return rec;
}

const localDay = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

module.exports = {
  limitsOf,
  orderOf,
  classify,
  parseCapitalAccount,
  parseRestPositions,
  parseRestPlaceholders,
  parseRestOrders,
  applyFeedState,
  valuesOf,
  sessionBaseline,
  localDay,
};
