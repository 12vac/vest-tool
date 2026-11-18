// Emergency FLATTEN ALL: on EVERY account cancels the pending orders and closes every position at market.
// Per account: fresh re-read, orders first (one could fill after the close),
// then the positions; all accounts in parallel; second round after 1.5 s for whatever is left.
// Works even with 'Orders' off: it can ONLY close and cancel (transport.js, EMERGENCY_WRITES). Never open.

const session = require('./session');
const transport = require('./transport');
const store = require('./store');
const sync = require('./sync');
const O = require('../domain/orders');
const log = require('../diag/log');

const { S } = store;
const RECHECK_MS = 1500;
const FLAT_CHECK_MS = 700; // card FLAT: wait before re-reading the positions
const FLAT_ROUNDS = 4; // rounds of cancel+close+re-read until the market is clean (positions AND orders)
let running = false;

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One emergency order for an account; on 401 renews the token once (nothing was executed). */
async function emergency(accountId, order) {
  const key = uuid();
  const go = async () =>
    transport.request(order.path, {
      method: order.method,
      token: (await session.accountToken(accountId)).token,
      body: order.body,
      idempotencyKey: key,
      emergency: true,
    });
  try {
    return await go();
  } catch (e) {
    if (!(e instanceof transport.HttpError) || e.status !== 401) throw e;
    session.dropAccountToken(accountId);
    return go();
  }
}

/** One account: re-reads, cancels the orders, closes the positions. Returns how many things it found open. */
async function flattenAccount(id) {
  const label = (S.accounts[id] || {}).label || id;
  const [posR, ordR] = await Promise.all([
    session.accountGet(id, '/v3/positions/opened'),
    session.accountGet(id, '/v3/positions/opened-orders'),
  ]);
  const positions = ((posR && posR.positions) || []).filter((p) => (p.positionId || p.position_id) && p.symbol && parseFloat(p.quantity) > 0);
  const orders = ((ordR && ordR.orders) || []).map((o) => o.orderId || o.order_id || o.id).filter(Boolean);
  const cancels = await Promise.allSettled(
    orders.map((orderId) => emergency(id, { method: 'POST', path: '/v3/positions/cancel-order', body: { orderId } })),
  );
  const closes = await Promise.allSettled(
    positions.map((p) =>
      emergency(id, O.closeOrder({ id: p.positionId || p.position_id, symbol: p.symbol, leverage: parseFloat(p.leverage) || null })),
    ),
  );
  const failed = [...cancels, ...closes].filter((r) => r.status === 'rejected');
  if (orders.length || positions.length)
    log.warn(`FLATTEN ${label}: ${orders.length} orders cancelled, ${positions.length} positions closed${failed.length ? `, ${failed.length} rejected (${failed[0].reason.message})` : ''}`);
  return orders.length + positions.length;
}

/** All active accounts. Returns { found, left } (left > 0 = something was still open at the second round). */
async function flattenAll() {
  if (running) return null;
  const ids = Object.keys(S.accounts);
  if (!ids.length) {
    log.warn('FLATTEN ALL: no account loaded');
    return null;
  }
  running = true;
  S.flattening = true;
  store.changed();
  const t0 = performance.now();
  log.warn(`FLATTEN ALL: closing every position and cancelling every order on ${ids.length} accounts`);
  try {
    const sweep = () =>
      Promise.all(
        ids.map((id) =>
          flattenAccount(id).catch((e) => {
            log.error(`FLATTEN ${(S.accounts[id] || {}).label || id}: not readable (${e.message})`);
            return 1;
          }),
        ),
      );
    const found = (await sweep()).reduce((a, b) => a + b, 0);
    await sleep(RECHECK_MS);
    const left = (await sweep()).reduce((a, b) => a + b, 0);
    if (left) log.error(`FLATTEN ALL: at the second round something was still open (${left}): check every account on Vest`);
    else log.info(`FLATTEN ALL completed in ${Math.round(performance.now() - t0)} ms: all accounts are flat`);
    return { found, left };
  } finally {
    running = false;
    S.flattening = false;
    ids.forEach((id) => sync.refreshAccount(id));
    store.changed();
  }
}

/**
 * Card FLAT: one account, one market. Cancels EVERY pending order on that market (read fresh), then closes the position
 * if there is one. Works even when flat (orders clean-up only) and with Orders off: it can only cancel and close.
 * Double check: after every round it re-reads positions AND orders and redoes whatever is still open, up to
 * FLAT_ROUNDS rounds; if something is left it says so and throws.
 * Returns { cancelled, closed } (totals of all rounds).
 */
async function flattenMarket(accountId, symbol) {
  const label = (S.accounts[accountId] || {}).label || accountId;
  // what is open now: fresh REST PLUS what the feed knows (a late REST must not miss anything)
  const read = async () => {
    const [posR, ordR] = await Promise.all([
      session.accountGet(accountId, '/v3/positions/opened'),
      session.accountGet(accountId, '/v3/positions/opened-orders'),
    ]);
    const positions = ((posR && posR.positions) || [])
      .filter((p) => p.symbol === symbol && (p.positionId || p.position_id) && parseFloat(p.quantity) > 0)
      .map((p) => ({ id: p.positionId || p.position_id, symbol, leverage: parseFloat(p.leverage) || null }));
    const orders = ((ordR && ordR.orders) || []).filter((o) => o.symbol === symbol).map((o) => o.orderId || o.order_id || o.id).filter(Boolean);
    return { positions, orders };
  };
  const fromFeed = (cur) => {
    const st = S.state[accountId] || {};
    for (const p of st.positions || [])
      if (p.symbol === symbol && p.qty > 0 && p.id && !cur.positions.some((x) => x.id === p.id)) cur.positions.push({ id: p.id, symbol, leverage: p.leverage || null });
    for (const o of st.orders || []) if (o.symbol === symbol && o.id && !cur.orders.includes(o.id)) cur.orders.push(o.id);
    return cur;
  };
  let cancelled = 0,
    closed = 0,
    lastErr = null;
  try {
    let cur = fromFeed(await read());
    for (let round = 1; round <= FLAT_ROUNDS; round++) {
      if (!cur.positions.length && !cur.orders.length) break;
      if (round > 1) log.warn(`FLAT ${label} ${symbol}: still open after round ${round - 1} (${cur.positions.length} positions, ${cur.orders.length} orders), closing again`);
      // orders first: one could fill after the close and reopen
      const cancels = await Promise.allSettled(cur.orders.map((orderId) => emergency(accountId, { method: 'POST', path: '/v3/positions/cancel-order', body: { orderId } })));
      const closes = await Promise.allSettled(cur.positions.map((p) => emergency(accountId, O.closeOrder(p))));
      cancelled += cancels.filter((r) => r.status === 'fulfilled').length;
      closed += closes.filter((r) => r.status === 'fulfilled').length;
      const bad = [...cancels, ...closes].find((r) => r.status === 'rejected');
      if (bad) lastErr = bad.reason.message;
      await sleep(FLAT_CHECK_MS);
      cur = await read(); // check on fresh REST only: the feed may be a moment behind
    }
    if (cur.positions.length || cur.orders.length) {
      const what = `${cur.positions.length} positions and ${cur.orders.length} orders`;
      log.error(`FLAT ${label} ${symbol}: after ${FLAT_ROUNDS} rounds ${what} are left${lastErr ? ' (' + lastErr + ')' : ''}: close them on Vest`);
      throw new Error(`${what} are left: close them on Vest`);
    }
    log.info(`FLAT ${label} ${symbol}: ${cancelled} orders cancelled, ${closed} positions closed, verified flat`);
    return { cancelled, closed };
  } finally {
    sync.refreshAccount(accountId);
  }
}

/**
 * Cancel limits / cancel all of the second card: cancels ALL Vest pending orders on a market (read fresh), closing nothing.
 * Emergency path: works even with Orders off. Returns how many it cancelled.
 */
async function cancelOrdersOn(accountId, symbol) {
  const ordR = await session.accountGet(accountId, '/v3/positions/opened-orders');
  const ids = ((ordR && ordR.orders) || []).filter((o) => o.symbol === symbol).map((o) => o.orderId || o.order_id || o.id).filter(Boolean);
  try {
    const res = await Promise.allSettled(ids.map((orderId) => emergency(accountId, { method: 'POST', path: '/v3/positions/cancel-order', body: { orderId } })));
    const failed = res.filter((r) => r.status === 'rejected');
    if (ids.length) (failed.length ? log.error : log.info)(`Cancelled ${ids.length - failed.length} of ${ids.length} orders on ${symbol}${failed.length ? ' (' + failed[0].reason.message + ')' : ''}`);
    if (failed.length) throw new Error(failed[0].reason.message);
    return ids.length;
  } finally {
    sync.refreshAccount(accountId);
  }
}

module.exports = { flattenAll, flattenMarket, cancelOrdersOn, running: () => running };
