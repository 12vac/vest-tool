// BRACKET follows a DCA (option "follow adds"): when a position of the selected account grows and its average entry moves
// (an add from the tool or from Vest), its SL / TP are moved to the bracket distances from the new average.
// v0.20.62 (Gerry 2026-11-23): the average is AVG ALL = the position plus the entry LIMITs waiting on the same side, and
// SL / TP are computed again also when such a LIMIT is placed, cancelled or filled while the position is open. The SL never
// sits between two entries (domain/bracket.js). With no position yet (only LIMITs) nothing is moved: Vest's legs on a LIMIT
// not filled yet are left as they are.
// Known limits: acts only with Orders ON and the tab open; a position already open at load is only recorded (nothing moved
// until its next add); one attempt per add (a rejected move is logged, not retried).

const store = require('./store');
const orders = require('./orders');
const O = require('../domain/orders');
const B = require('../domain/bracket');
const log = require('../diag/log');

const { S } = store;
const st = new Map(); // positionId -> { qty, px, todo: { oldPx } | null, guard: { at } | null }
const T0 = Date.now(); // positions opened before the page loaded are never touched
const GUARD_MS = 3000;
let cfgOf = () => null; // -> { sl, tp, follow } or null

function positions() {
  return ((S.state[S.selected] || {}).positions || []).filter((p) => p.qty > 0);
}
// AVG ALL: position + entry LIMITs waiting on the same side of the same market; far = the farthest of those LIMITs
function refOf(pos) {
  const lm = ((S.state[S.selected] || {}).orders || []).filter((o) => o.symbol === pos.symbol && o.side === pos.side && o.price > 0 && o.qty > 0 && !o.reduceOnly);
  const q = pos.qty + lm.reduce((a, o) => a + o.qty, 0);
  const avg = (pos.qty * pos.openPrice + lm.reduce((a, o) => a + o.qty * o.price, 0)) / q;
  const d = pos.side === 'long' ? 1 : -1;
  const far = lm.length ? lm.reduce((a, o) => (d * o.price < d * a ? o.price : a), lm[0].price) : NaN;
  const sig = lm.map((o) => `${o.price}:${o.qty}`).sort().join('|');
  return { avg, far, sig, n: lm.length };
}

let running = false;
async function apply(pos, oldPx, b, why) {
  const tick = (S.symbols[pos.symbol] || {}).tick;
  const mk = S.marks[pos.symbol];
  const ref = refOf(pos);
  const r = B.follow({ side: pos.side, avg: ref.avg, oldAvg: oldPx, sl: b.sl, tp: b.tp, legs: pos.triggers || [], tick, far: ref.far });
  for (const t of r.skip) log.warn(`BRACKET ${pos.symbol}: after the add ${t}`);
  for (const mv of r.moves) {
    const bad = O.checkLeg({ kind: mv.kind, side: pos.side, price: mv.price, mark: mk && mk.px, tick });
    if (bad) {
      log.warn(`BRACKET ${pos.symbol}: ${mv.kind.toUpperCase()} at ${mv.price} not moved (${bad})`);
      continue;
    }
    const what = `BRACKET ${why || 'follows the add'}: ${mv.kind.toUpperCase()} ${mv.leg ? mv.leg.price + ' -> ' : 'at '}${mv.price} (${ref.n ? `AVG ALL ${+ref.avg.toFixed(4)} with ${ref.n} LIMIT(s) waiting` : `entry ${pos.openPrice}`})`;
    try {
      await orders.send(S.selected, O.legOrder(pos, mv.kind, mv.price, tick, mv.leg), what, pos.id);
    } catch (e) {
      log.error(`${what}: ${e.message}`);
    }
  }
}

/** At every price. */
function check() {
  const live = positions();
  for (const id of [...st.keys()]) if (!live.some((p) => p.id === id)) st.delete(id);
  const b = cfgOf();
  for (const pos of live) {
    const tick = (S.symbols[pos.symbol] || {}).tick || 1e-6;
    const step = (S.symbols[pos.symbol] || {}).step || 1e-9;
    let s = st.get(pos.id);
    if (!s) {
      // NEW position born while this tab is open (LIMIT filled, entry from Vest's ticket, add to a pending order...):
      // if it ends up with NO legs at all, the bracket SL / TP are added from its entry (Gerry 2026-11-21: "il bracket non
      // mi inserisce SL e TP se metto un ordine limit"). Legs it already has (bracket on /open, plan, by hand) are left alone.
      const fresh = Number.isFinite(pos.openedAt) ? pos.openedAt > T0 : Date.now() - T0 > 15000; // no open date: seen well after the load
      st.set(pos.id, { qty: pos.qty, px: pos.openPrice, sig: refOf(pos).sig, todo: null, guard: fresh ? { at: Date.now() } : null });
      continue;
    }
    if (s.guard && !running && !orders.busyOn(pos.id) && Date.now() - s.guard.at >= GUARD_MS) {
      s.guard = null; // one attempt
      if (b && b.sl > 0 && orders.enabled() && !(pos.triggers || []).length) {
        running = true;
        s.todo = null;
        apply(pos, pos.openPrice, b, 'new position without SL / TP').finally(() => (running = false));
        continue;
      }
    }
    // an add: the size grew (the new average may come a moment later on the feed: waited up to 3 s)
    if (pos.qty > s.qty + step / 2) s.todo = { oldPx: s.todo ? s.todo.oldPx : s.px, at: Date.now(), add: true };
    // an entry LIMIT placed / cancelled / filled on this market: AVG ALL changed (no wait for the average)
    const sig = refOf(pos).sig;
    if (sig !== s.sig && !s.todo) s.todo = { oldPx: s.px, at: Date.now(), add: false };
    s.sig = sig;
    s.qty = pos.qty;
    s.px = pos.openPrice;
    if (!s.todo) continue;
    if (!b || !b.follow || !orders.enabled()) {
      s.todo = null; // option off or Orders OFF at the add: nothing is done later either
      continue;
    }
    if (running || orders.busyOn(pos.id)) continue; // the add itself is still in progress: next price
    // after an add the new position average may come a moment later on the feed: waited up to 3 s
    if (s.todo.add && Math.abs(pos.openPrice - s.todo.oldPx) < tick / 2 && Date.now() - s.todo.at < 3000) continue;
    const oldPx = s.todo.oldPx;
    const why = s.todo.add ? '' : 'follows the LIMITs waiting';
    s.todo = null;
    running = true;
    apply(pos, oldPx, b, why).finally(() => (running = false)); // nothing is sent when SL / TP are already there
  }
}

module.exports = { check, setConfig: (fn) => (cfgOf = fn), wants: () => !!(cfgOf() || {}).follow };
