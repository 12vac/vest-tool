// Trailing stop and auto BE on the selected account's positions (the card's account). Logic in domain/trail.js.
// Known limits:
//  - acts only with Orders ON and the tab open; the NATIVE stop stays where it got to even with the tab closed
//  - price = Vest mark read every 0.5 s while trailing is on: a shorter spike is not seen
//  - after a reload the "best" restarts from the current price (the stop never moves back)
//  - if the price passes the level and the stop is missing or behind by at least one step (move rejected or too slow),
//    it closes at market (/close: also cancels attached LIMITs); behind by less than one step it lets it trigger
//  - with the copier on, the master's stop moves are copied (one order per copy at every step)

const store = require('./store');
const orders = require('./orders');
const O = require('../domain/orders');
const T = require('../domain/trail');
const log = require('../diag/log');

const { S } = store;
const STALE_MS = 3000;
const MIN_GAP_MS = 1000; // between two trailing orders on the same position
const FAIL_WAIT_MS = 5000; // after a rejection
const SENT_HOLD_MS = 4000; // a stop just sent counts as already there until the feed shows it (no duplicates)
const BE_EDIT_MS = 1500; // how long the BE+ field must stay unchanged before moving the stop (while typing "16" no "1" is sent)
const st = new Map(); // positionId -> { best, active, beDone, bePx, next, level }
let cfgOf = () => ({});

const wanted = (c) => c.trOn || c.beAuto || c.beOn;
const keyOf = (pos) => pos.qty + '|' + pos.openPrice;

function positions() {
  return ((S.state[S.selected] || {}).positions || []).filter((p) => p.qty > 0);
}

function fire(pos, order, label, s, now) {
  s.next = now + MIN_GAP_MS;
  return orders.send(S.selected, order, label, pos.id).catch((e) => {
    s.next = Date.now() + FAIL_WAIT_MS;
    log.error(`${label}: ${e.message}`);
  });
}

/** Check at every new price. */
function check() {
  const c = cfgOf();
  const live = positions();
  for (const id of [...st.keys()]) if (!live.some((p) => p.id === id)) st.delete(id); // position closed: start again from zero
  if (!wanted(c) || !orders.enabled()) return;
  const now = Date.now();
  for (const pos of live) {
    const mk = S.marks[pos.symbol],
      tick = (S.symbols[pos.symbol] || {}).tick;
    if (!mk || now - mk.at > STALE_MS || !(tick > 0) || orders.busyOn(pos.id)) continue;
    const key = keyOf(pos);
    let s = st.get(pos.id);
    // size or entry changed (DCA, add, reduction): trailing restarts from zero. Before, it kept the best of the old
    // entry and, once the average had moved, closed at once
    if (s && s.key !== key) {
      log.info(`TRAIL ${pos.symbol}: size or entry changed (${s.key} -> ${key}), trailing and auto BE restart from zero`);
      s = null;
    }
    if (!s) st.set(pos.id, (s = { key, best: null, active: false, beDone: false, next: 0 }));
    const sls = pos.triggers.filter((t) => t.kind === 'sl');
    if (sls.length > 1) {
      if (!s.warned) log.warn(`TRAIL ${pos.symbol}: more than one stop on the position, trailing and auto BE paused`);
      s.warned = true;
      continue;
    }
    const sl = sls[0] || null;
    let slPx = sl ? sl.price : null;
    const d = pos.side === 'long' ? 1 : -1;
    if (s.sent != null && now - s.sentAt < SENT_HOLD_MS && (slPx == null || d * (s.sent - slPx) > 0)) slPx = s.sent;
    const base = { side: pos.side, qty: pos.qty, entry: pos.openPrice, mark: mk.px, tick, sl: slPx };
    if (c.trOn) {
      const r = T.trailStep({ ...base, best: s.best, active: s.active, act: c.trAct, dist: c.trDist, step: c.trStep, unit: c.trUnit });
      if (r.active && !s.active) log.warn(`TRAIL ${pos.symbol} ${pos.side.toUpperCase()} started (best ${r.best}, level ${r.level})`);
      Object.assign(s, { best: r.best, active: r.active, level: r.level, waitProfit: !!r.waitProfit });
      if (r.action && now >= s.next) {
        if (r.action.type === 'sl') {
          Object.assign(s, { sent: r.action.price, sentAt: now });
          fire(pos, O.legOrder(pos, 'sl', r.action.price, tick, sl), `TRAIL: stop ${sl ? sl.price + ' -> ' : 'at '}${r.action.price}`, s, now);
          continue;
        }
        log.warn(`TRAIL ${pos.symbol}: price ${mk.px} beyond the level ${r.level} without a stop: closing at market`);
        fire(pos, O.closeOrder(pos), `TRAIL: close ${pos.side.toUpperCase()} ${pos.qty} ${pos.symbol}`, s, now);
        s.next = now + SENT_HOLD_MS; // the position may stay in the feed for a moment
        continue;
      }
    }
    if (c.beAuto && !s.beDone && now >= s.next) {
      const price = T.autoBe({ ...base, at: c.beAt, off: c.beOn ? c.beOff : 0, unit: c.beUnit });
      if (price != null) {
        s.beDone = true; // once per position: if the stop is then moved back by hand, it is not put back
        Object.assign(s, { sent: price, sentAt: now, bePx: price });
        fire(pos, O.legOrder(pos, 'sl', price, tick, sl), `Auto BE: stop ${sl ? sl.price + ' -> ' : 'at '}${price}`, s, now);
        continue;
      }
    }
    // BE+ after the BE (auto or from the button): changing the profit in the field moves the stop to the new level.
    // Only when the field changes (a stop moved by hand with the field unchanged is not put back) and not if trailing
    // has already taken over the stop.
    const trailOwns = c.trOn && s.active && !s.waitProfit && s.level != null;
    if (s.beDone && s.bePx != null && c.beOn && !trailOwns && now >= s.next) {
      const offP = T.toPts(c.beOff, c.beUnit, pos.qty);
      const px = offP > 0 ? O.breakevenPrice(pos.side, pos.openPrice, tick, offP) : null;
      if (px == null || px === s.bePx) s.bePend = null;
      else if (!s.bePend || s.bePend.px !== px) s.bePend = { px, at: now };
      else if (now - s.bePend.at >= BE_EDIT_MS) {
        const bad = O.checkLeg({ kind: 'sl', side: pos.side, price: px, mark: mk.px, tick });
        if (bad) {
          if (s.bePend.warned !== px) log.warn(`BE+ ${px}: ${bad}, the stop stays at ${slPx}`);
          s.bePend.warned = px;
        } else {
          Object.assign(s, { bePx: px, bePend: null, sent: px, sentAt: now });
          fire(pos, O.legOrder(pos, 'sl', px, tick, sl), `BE+ changed: stop ${sl ? sl.price + ' -> ' : 'at '}${px}`, s, now);
        }
      }
    }
  }
}

/** The BE button put the stop at price: from here the BE+ field can move it. */
function markBe(pos, price) {
  let s = st.get(pos.id);
  if (!s || s.key !== keyOf(pos)) st.set(pos.id, (s = { key: keyOf(pos), best: null, active: false, beDone: false, next: 0 }));
  Object.assign(s, { beDone: true, bePx: price, bePend: null });
}

/** State for the panel: one line per followed position. */
function status() {
  const c = cfgOf();
  if (!wanted(c)) return null;
  if (!orders.enabled()) return 'waiting: Orders OFF';
  const live = positions();
  if (!live.length) return 'waiting for a position';
  return live
    .map((p) => {
      const s = st.get(p.id);
      if (!c.trOn) {
        if (s && s.bePx != null) return `${p.symbol}: BE at ${s.bePx}${c.beOn ? ', follows the BE+ field' : ''}`;
        return `${p.symbol}: ${c.beAuto ? 'auto BE waiting' : 'BE+ ready for the button'}`;
      }
      if (s && s.active && s.waitProfit) return `${p.symbol}: trailing waiting, level ${s.level} not in profit yet`;
      return s && s.active ? `${p.symbol}: trailing ACTIVE, best ${s.best}, level ${s.level}` : `${p.symbol}: trailing waiting to start`;
    })
    .join(' · ');
}

/** Trailing levels for the chart's position (segments on the overlay), or null. */
function view(pos) {
  const c = cfgOf();
  if (!c.trOn || !pos) return null;
  const mk = S.marks[pos.symbol],
    tick = (S.symbols[pos.symbol] || {}).tick;
  if (!mk || !(tick > 0)) return null;
  const sls = pos.triggers.filter((t) => t.kind === 'sl');
  if (sls.length > 1) return null;
  let s = st.get(pos.id);
  if (s && s.key !== keyOf(pos)) s = null; // state of the old entry: the check loop resets it
  return T.trailView({ side: pos.side, qty: pos.qty, entry: pos.openPrice, mark: mk.px, tick, best: s ? s.best : null, active: s ? s.active : false,
    sl: sls[0] ? sls[0].price : null, act: c.trAct, dist: c.trDist, step: c.trStep, unit: c.trUnit });
}

/** Has auto BE already triggered on this position (with the same entry)? */
function beDone(pos) {
  const s = pos && st.get(pos.id);
  return !!(s && s.key === keyOf(pos) && s.beDone);
}

module.exports = {
  markBe,
  beDone,
  view,
  check,
  status,
  setConfig: (fn) => (cfgOf = fn),
  wants: () => wanted(cfgOf()) && orders.enabled() && positions().length > 0,
};
