// Startup. Order matters: the hooks (WebSocket, native fetch) must be installed at document-start, before Vest's code.
// Orders: only from the trade overlay (core/orders.js), only with the 'Orders' switch on. transport.js blocks the rest.

const hooks = require('./core/hooks');

/** Whole number from a panel field: empty or not a number -> def, otherwise kept between lo and hi. */
function clampInt(v, lo, hi, def) {
  const n = Math.round(parseFloat(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
}

function start(version) {
  hooks.install(); // synchronous, right away

  const log = require('./diag/log');
  const session = require('./core/session');
  const store = require('./core/store');
  const feed = require('./core/feed');
  const sync = require('./core/sync');
  const check = require('./core/check');
  const tv = require('./chart/tv');
  const lines = require('./chart/lines');
  const vestlines = require('./chart/vestlines');
  const vestdom = require('./chart/vestdom');
  const overlay = require('./chart/overlay');
  const orders = require('./core/orders');
  const flatten = require('./core/flatten');
  const entry = require('./core/entry');
  const stops = require('./core/stops');
  const trail = require('./core/trail');
  const { toPts } = require('./domain/trail');
  const { breakevenPrice } = require('./domain/orders');
  const copier = require('./core/copier');
  const { knockout, ladder, ddHalf } = require('./domain/ladder');
const { limitsOf } = require('./domain/account');
  const panel = require('./ui/panel');
  const calc = require('./ui/calc');
  const F = require('./ui/format');
  const { rate } = require('./core/transport');
  const { S } = store;
  const DP = require('./domain/daypts');
  const { vestDayStart } = require('./domain/vestday');

  log.info(`VestTool v${version} started (${document.readyState})`);
  session.start();
  feed.start((why) => sync.full(why));
  sync.start();

  let checked = false;
  store.subscribe(() => {
    if (!checked && S.lastSync && session.status().state === 'ok') {
      checked = true;
      check.run();
    }
  });

  // ── chart
  let chartSym = null;
  const isChartSym = (sym) => tv.sameSymbol(chartSym, sym, (S.symbols[sym] || {}).aliases);

  function calcResult() {
    const ui = panel.ui();
    const position = calc.refPosition(S.state[S.selected], isChartSym);
    if (ui.mode === 'man') {
      sync.watchSymbol(ui.symbol || calc.DEFAULT_SYMBOL);
      sync.ensureSymbols([ui.symbol || calc.DEFAULT_SYMBOL]);
    }
    return calc.compute(ui, { position, symbols: S.symbols, marks: S.marks });
  }

  const GREEN = '#3ecf8e',
    RED = '#ff5a4f';
  function lineSpecs() {
    const ui = panel.ui();
    if (!ui.lines || !chartSym) return [];
    const specs = [];
    const st = S.state[S.selected];
    for (const p of (st && st.positions) || []) {
      if (!isChartSym(p.symbol)) continue;
      if (overlay.state().visible && overlay.state().posId === p.id) continue; // drawn by the overlay
      const mk = S.marks[p.symbol];
      const pnl = mk ? (p.side === 'long' ? 1 : -1) * p.qty * (mk.px - p.openPrice) : NaN;
      specs.push({ key: 'pos:' + p.id, price: p.openPrice, text: `${p.side.toUpperCase()} · ${F.usd(pnl, true)}`, qty: F.qty(p.qty), color: pnl >= 0 ? GREEN : RED, length: 35 });
      for (const t of p.triggers) {
        const usd = calc.triggerUsd(p, t);
        specs.push({ key: 'leg:' + t.id, price: t.price, text: `${t.kind.toUpperCase()} ${F.usd(usd, true)}`, qty: '', color: t.kind === 'sl' ? RED : GREEN, length: 25 });
      }
    }
    // no calculator previews on the chart: SL and TP are placed only by dragging them from the overlay
    return specs;
  }

  // ── trade overlay: position of the selected account on the chart's market
  let lastFound = null;
  // market shown by the chart (the cards exist even without a position)
  const chartMarket = () => (chartSym ? tv.marketOfChart(chartSym, S.symbols) : null);
  // points of the day: selected account only
  const pointsIds = () => (S.selected && S.accounts[S.selected] ? [S.selected] : []);
  // switching the copier on (panel and COPY card): always with confirmation
  const copyStart = () => {
    const why = copier.cannotStart();
    if (why) return log.warn('Copier: ' + why);
    const ok = window.confirm(
      `Switch the COPIER on?

${copier.describe()}

Every order of the master (from the tool and from Vest's order ticket) is also sent to the copies: market orders, adds,
reductions, closes, FLAT, pending LIMIT/STOP orders and their cancellations, SL/TP. If the master leaves a market, the copies
on that market are closed. Real money on every account. It switches off at every reload and when you switch Orders off.`,
    );
    if (ok) copier.start();
  };
  const copyToggle = () => (copier.state().armed ? copier.stop('from the card') : copyStart());
  function tradeModel() {
    const found = lastFound;
    if (!found) return null;
    const symbol = chartMarket();
    const m = symbol && S.symbols[symbol];
    if (!m) return { found, market: null, pos: null };
    const ui = panel.ui();
    const acc = S.selected;
    const st = S.state[acc];
    const pos = ((st && st.positions) || []).find((p) => p.symbol === symbol) || null;
    const size = acc ? entry.sizeFor(acc, symbol, +ui.sizePct || 0) : { why: '' };
    // pending orders on this market (Vest: entry limits; local: entry stops) for the lines with X
    const pendings = [
      ...((st && st.orders) || [])
        .filter((o) => o.symbol === symbol && o.price > 0) // all of them: Vest's own order lines are hidden
        .map((o) => ({ id: o.id, kind: 'lm', label: o.reduceOnly ? 'CLOSE' : 'LIMIT', side: o.side, price: o.price, qty: o.qty, local: false })),
      ...stops
        .list()
        .filter((x) => x.accountId === acc && x.symbol === symbol)
        .map((x) => ({ id: x.id, kind: 'st', side: x.side, price: x.trigger, qty: x.qty, local: true })),
    ];
    // account equity and room to the TOTAL drawdown limit (max drawdown + profit = equity - floor)
    const a = S.accounts[acc],
      v = (acc && store.values(acc)) || {};
    const eqBar = { equity: v.equity, dd: a && a.floor > 0 && v.equity >= 0 ? v.equity - a.floor : NaN, pld: v.sessionPnl, account: a ? a.label : '' };
    // copier accounts card: master + copies, with their total (not all Vest accounts)
    const cs = copier.state();
    const copyIds = cs.master ? [cs.master, ...cs.followers.filter((id) => id !== cs.master)] : [];
    const KEYS = ['upnl', 'dayPnl', 'sessionPnl', 'totalPnl'];
    const copyRows = copyIds.filter((id) => S.accounts[id]).map((id) => {
      const cv = store.values(id) || {};
      // open size on the chart's market (column with the quantities of the current trade)
      const p = ((S.state[id] || {}).positions || []).find((x) => x.symbol === symbol && x.qty > 0);
      // just the account number (little room in the COPY card)
      const lb = S.accounts[id].label;
      const num = (/^(\S{1,3})\s/.exec(lb) || [])[1] || String((S.accounts[id].order ?? 0) + 1); // "3 7fe467" -> 3, "A 7fe467" -> A
      const act = store.activityOf(id);
      return { id, label: lb, num, act: act.lvl, actTip: act.tip, master: id === cs.master, qty: p ? p.qty : 0, side: p ? p.side : null, ...Object.fromEntries(KEYS.map((k) => [k, cv[k]])) };
    });
    // one account without data makes the total unknown, as in the panel
    const copyTot = Object.fromEntries(KEYS.map((k) => [k, copyRows.reduce((t, r) => t + r[k], 0)]));
    copyTot.qty = copyRows.reduce((t, r) => t + r.qty, 0);
    return {
      found,
      eqBar,
      // points realised today by the selected account (closed positions from the history)
      points: (() => {
        let closed = 0,
          open = 0,
          n = 0;
        const ids = pointsIds();
        if (!ids.length) return null;
        for (const id of ids) {
          const h = S.pts && S.pts[id];
          if (!h) return null;
          // only the Vest day (since 20:00 New York time), not the whole history
          const d = DP.sumSince(h.map, vestDayStart(Date.now()));
          closed += d.pts;
          n += d.n; // REALISED only: the open position does not count
        }
        return { closed, open, n, label: (S.accounts[ids[0]] || {}).label || ids[0], master: ids[0] === copier.state().master };
      })(),
      selected: S.selected,
      copy: cs.followers.length && copyRows.length ? { armed: cs.armed, rows: copyRows, tot: copyTot } : null,
      market: { symbol, label: m.label, tick: m.tick, priceDec: m.priceDec, mark: (S.marks[symbol] || {}).px },
      pos,
      lev: size.lev,
      size,
      pct: +ui.sizePct || 0,
      pendings,
      ordersOn: orders.enabled(),
      busy: pos ? orders.busyOn(pos.id) : null,
      closePct: +ui.closePct || 0,
      // third card: margin (positions only / with pending orders) and risk, like the panel's Trade section
      risk: (() => {
        const posColl = ((st && st.positions) || []).reduce((s, p) => s + (p.collateral || 0), 0);
        const all = posColl + ((st && st.ordersCollateral) || 0);
        const mk = S.marks[symbol];
        const upnl = pos && mk ? (pos.side === 'long' ? 1 : -1) * pos.qty * (mk.px - pos.openPrice) : 0;
        return {
          marginPos: v.equity > 0 ? posColl / v.equity : NaN,
          marginAll: v.equity > 0 ? all / v.equity : NaN,
          maxQty: acc ? entry.sizeFor(acc, symbol, 100).max : NaN,
          used: Math.max(0, -upnl),
          upnl,
          left: a && a.dailyFloor > 0 && v.equity >= 0 ? v.equity - a.dailyFloor : v.toFloor, // down to Vest's daily loss limit
        };
      })(),
      // average entry if all entry limits fill (position + limits): AVG label
      // fail price: where the equity reaches the drawdown limit, with the entry limits that fill on the way
      avg: ladder({ pos, orders: pendings.filter((o) => !o.local && o.label === 'LIMIT'), equity: v.equity, mark: (S.marks[symbol] || {}).px }),
      ko: knockout({
        pos,
        orders: pendings.filter((o) => !o.local && o.label === 'LIMIT'),
        equity: v.equity,
        mark: (S.marks[symbol] || {}).px,
        floors: { total: a && a.floor, daily: a && a.dailyFloor },
      }),
      limits: limitsOf(a, v),
      // 50% drawdown label (can be switched off in the panel)
      dd50: panel.ui().dd50 !== false
        ? ddHalf({
            pos,
            orders: pendings.filter((o) => !o.local && o.label === 'LIMIT'),
            equity: v.equity,
            balance: v.balance,
            mark: (S.marks[symbol] || {}).px,
            floors: { total: a && a.floor, daily: a && a.dailyFloor },
            initial: a && a.initial,
            tick: (S.symbols[symbol] || {}).tick,
          })
        : null,
      // LONG / SHORT hover preview: fail price (FAIL NEW) with the size in %, added to the position when it is on the same side;
      // the opposite side has no preview (it would cut the position). Pending orders excluded.
      preview: (() => {
        const px = (S.marks[symbol] || {}).px;
        if (!(size.qty > 0) || !(px > 0)) return null;
        const out = {};
        for (const side of ['long', 'short']) {
          if (pos && pos.side !== side) continue;
          const q = (pos ? pos.qty : 0) + size.qty;
          const avg = ((pos ? pos.qty * pos.openPrice : 0) + size.qty * px) / q;
          const fee = size.qty * px * (m.takerFee || 0); // entry fee: taken off the equity at once
          const ko = knockout({ pos: { side, qty: q, openPrice: avg }, orders: [], equity: v.equity - fee, mark: px, floors: { total: a && a.floor, daily: a && a.dailyFloor } });
          out[side] = { side, add: size.qty, qty: q, avg, entry: px, adding: !!pos, ko };
        }
        return out;
      })(),
      dailyGoal: parseFloat(ui.dailyGoal) > 0 ? parseFloat(ui.dailyGoal) : NaN,
      presets: [0, 1, 2, 3, 4, 5].map((i) => {
        const v = parseFloat(ui['pp' + i]);
        return v > 0 && v <= 100 ? +v.toFixed(2) : [1, 2, 4, 8, 5, 16][i];
      }),
      blockPct: ui.blockPct,
      lineStyles: panel.lineStyles(),
      // positions on the same side on ALL accounts (TP and SL show the P&L of every account in the trade)
      allPos: pos
        ? Object.keys(S.accounts)
            .map((id) => ((S.state[id] || {}).positions || []).find((p) => p.symbol === symbol && p.side === pos.side && p.qty > 0))
            .filter(Boolean)
            .map((p) => ({ side: p.side, qty: p.qty, openPrice: p.openPrice }))
        : [],
      trailView: trail.view(pos), // the three trailing segments (stop, start level, next step)
      // BE+ segment: where the BE button puts the stop, with BE+ on in the panel
      bePrice: (() => {
        if (!pos || !ui.beOn || !(m.tick > 0)) return null;
        const off = toPts(ui.beOff === '' ? 0 : ui.beOff, ui.beUnit, pos.qty);
        return off > 0 ? breakevenPrice(pos.side, pos.openPrice, m.tick, off) : null;
      })(),
      // auto BE trigger segment: entry + "after" threshold, until it has triggered
      beAtPrice: (() => {
        if (!pos || !ui.beAuto || !(m.tick > 0) || trail.beDone(pos)) return null;
        const at = toPts(ui.beAt, ui.beUnit, pos.qty);
        return at > 0 ? breakevenPrice(pos.side, pos.openPrice, m.tick, at) : null;
      })(),
      qtyStyle: panel.qtyStyle(),
      chipPct: ui.chipPct,
      roomPx: ui.roomPx,
      cdOn: ui.cdOn !== false,
      theme: ui.theme === 'sonar' ? 'sonar' : 'classic',
      hlOn: ui.hlOn !== false,
      atrOn: ui.atrOn !== false,
      // out of range -> nearest limit (not the default: a value that silently does nothing is worse); empty -> default
      atrH: clampInt(ui.atrH, 1, 48, 14),
      atrR: clampInt(ui.atrR, 1, 20, 3),
      hlK: clampInt(ui.hlK, 1, 50, 2),
      bePlus: ui.beOn && +ui.beOff > 0 ? `${ui.beOff} ${ui.beUnit}` : null, // BE+ from the panel: text of the BE button
    };
  }
  const curPos = () => {
    const m = tradeModel();
    if (!m || !m.pos) throw new Error('no position on the chart');
    return m.pos;
  };
  // switching orders on (panel and card): switching off is immediate, switching on asks for confirmation with the account name
  function toggleOrders() {
    if (orders.enabled()) return orders.setEnabled(false);
    const acc = S.accounts[S.selected];
    const ok = window.confirm(
      `Switch orders on?

BE, dragged SL/TP, FLAT and the entry buttons will send REAL orders to the account "${acc ? acc.label + ' (' + acc.type + ')' : '?'}".
Vest has no demo: this is real money. Try every new feature at minimum size.

It switches off by itself at every page reload.`,
    );
    if (ok) orders.setEnabled(true);
  }

  const tradeActions = {
    toggleOrders: () => toggleOrders(),
    // FLAT: local stops, pending orders and position on the chart's market; active even when flat and with Orders OFF
    flat: () =>
      Promise.resolve().then(async () => {
        const symbol = chartMarket();
        if (!symbol || !S.selected) throw new Error('chart market not recognised');
        const st = stops.cancelWhere(S.selected, symbol, 'FLAT');
        const acc = S.selected;
        const [r] = await Promise.all([flatten.flattenMarket(acc, symbol), copier.mirrorFlat(acc, symbol)]); // master: FLAT on the copies too
        if (!r.cancelled && !r.closed && !st) throw new Error('nothing to close or cancel on this market');
      }),
    closePct: () => Promise.resolve().then(() => entry.closePct({ accountId: S.selected, symbol: chartMarket(), pct: +panel.ui().closePct || 0 })),
    setClosePct: (v) => panel.setUi('closePct', v),
    // X on the position label: 100% at market, pending orders left in place
    closeAll: () => Promise.resolve().then(() => entry.reduceAll({ accountId: S.selected, symbol: chartMarket() })), // reduce, not /close: the LIMIT orders stay
    breakeven: () =>
      Promise.resolve().then(() => {
        const pos = curPos(),
          ui = panel.ui();
        // BE+: stop at the entry plus the profit chosen in the panel, in points or dollars
        const off = ui.beOn ? toPts(ui.beOff === '' ? 0 : ui.beOff, ui.beUnit, pos.qty) : 0;
        if (!(off >= 0)) throw new Error('BE+: invalid profit in the panel');
        const tick = (S.symbols[pos.symbol] || {}).tick;
        return orders.breakeven(S.selected, pos, off).then((r) => {
          if (tick > 0) trail.markBe(pos, breakevenPrice(pos.side, pos.openPrice, tick, off)); // the BE+ field now moves this stop
          return r;
        });
      }),
    setLeg: (kind, price, existing) => Promise.resolve().then(() => orders.setLeg(S.selected, curPos(), kind, price, existing)),
    removeLeg: (leg) => Promise.resolve().then(() => orders.removeLeg(S.selected, curPos(), leg)),
    // second card
    setPct: (v) => panel.setUi('sizePct', v),
    copyToggle: () => {
      try {
        copyToggle();
      } catch (e) {
        log.warn('Copier: ' + e.message);
      }
    },
    // COPY card row: the tool shows that account (Vest's own account dropdown is not touched)
    select: (id) => {
      if (!S.accounts[id] || S.selected === id) return;
      S.selected = id;
      sync.refreshAccount(id);
      store.changed();
    },
    placeEntry: (kind, price) =>
      Promise.resolve().then(() => {
        const ui = panel.ui(),
          symbol = chartMarket();
        if (!symbol) throw new Error('chart market not recognised');
        if (!orders.enabled()) throw new Error('Orders are off: switch them on from the panel');
        const args = { accountId: S.selected, symbol, price, pct: +ui.sizePct || 0, cap: +ui.capPct || 0 };
        return kind === 'lm' ? entry.placeLimit(args) : stops.arm(args);
      }),
    market: (side) => Promise.resolve().then(() => entry.marketOpen({ accountId: S.selected, symbol: chartMarket(), side, pct: +panel.ui().sizePct || 0, cap: +panel.ui().capPct || 0 })),
    // cancel limits / cancel local stops / cancel both. Cancellations only: allowed with Orders OFF
    cancelOrders: (kind) =>
      Promise.resolve().then(async () => {
        const symbol = chartMarket();
        if (!symbol || !S.selected) throw new Error('chart market not recognised');
        const st = kind === 'lm' ? 0 : stops.cancelWhere(S.selected, symbol, kind === 'all' ? 'cancel all' : 'cancel stops');
        const lm = kind === 'st' ? 0 : await flatten.cancelOrdersOn(S.selected, symbol);
        if (kind !== 'st') copier.mirrorCancelAll(S.selected, symbol).catch((e) => log.error('Copia: ' + e.message));
        if (!st && !lm) throw new Error(kind === 'st' ? 'no local stop to cancel' : kind === 'lm' ? 'no pending order to cancel' : 'no order to cancel');
        return { st, lm };
      }),
    add: () => Promise.resolve().then(() => entry.addMarket({ accountId: S.selected, symbol: chartMarket(), pct: +panel.ui().sizePct || 0, cap: +panel.ui().capPct || 0 })),
    cut: () => Promise.resolve().then(() => entry.cutHalf({ accountId: S.selected, symbol: chartMarket() })),
    cancelPending: (o) =>
      Promise.resolve().then(() => (o.local ? stops.cancel(o.id, 'by hand') : entry.cancelOrder({ accountId: S.selected, orderId: o.id, label: `LIMIT ${o.side === 'long' ? 'BUY' : 'SELL'} @ ${o.price}` }))),
    // LIMIT / STOP already placed and dragged on the chart: the local stop changes price, the Vest limit is replaced (new one, then the old one cancelled)
    movePending: (o, price) =>
      Promise.resolve().then(() =>
        o.local ? stops.move(o.id, price) : entry.moveLimit({ accountId: S.selected, symbol: chartMarket(), order: { ...o, reduceOnly: o.label === 'CLOSE' }, price }),
      ),
  };
  // ── panel Trade section: chart market for the selected account, margin, risk, pending orders
  function tradeInfo() {
    const acc = S.selected,
      symbol = chartMarket(),
      a = acc && S.accounts[acc];
    if (!a) return null;
    const st = S.state[acc] || {},
      v = store.values(acc) || {},
      m = symbol && S.symbols[symbol];
    const size = symbol ? entry.sizeFor(acc, symbol, 100) : {};
    const used = (st.positions || []).reduce((s, p) => s + (p.collateral || 0), 0) + (st.ordersCollateral || 0);
    // risk: $ loss if all stops trigger; a position without a stop makes the risk unknown (unlimited)
    let risk = 0,
      noStop = false;
    for (const p of st.positions || []) {
      const sls = p.triggers.filter((t) => t.kind === 'sl');
      if (!sls.length) noStop = true;
      for (const t of sls) risk += Math.max(0, -calc.triggerUsd(p, t));
    }
    const pendings = [
      ...(st.orders || []).map((o) => ({ id: o.id, kind: o.reduceOnly ? 'close' : 'LIMIT', side: o.side, price: o.price, qty: o.qty, symbol: o.symbol, local: false })),
      ...stops.list().filter((x) => x.accountId === acc).map((x) => ({ id: x.id, kind: 'local STOP', side: x.side, price: x.trigger, qty: x.qty, symbol: x.symbol, local: true })),
    ];
    return {
      account: a.label,
      symbol,
      label: m ? m.label : chartSym || '?',
      priceDec: m ? m.priceDec : 2,
      mark: symbol && S.marks[symbol] ? S.marks[symbol].px : NaN,
      lev: size.lev,
      maxQty: size.max,
      marginPct: v.equity > 0 ? used / v.equity : NaN,
      used,
      risk: noStop ? NaN : risk,
      noStop,
      room: v.toFloor,
      // open trade on the chart's market: size, and drawdown it is using (open loss) against what is left
      pos: (() => {
        const p = (st.positions || []).find((x) => x.symbol === symbol);
        if (!p) return null;
        const mk = S.marks[symbol];
        const upnl = mk ? (p.side === 'long' ? 1 : -1) * p.qty * (mk.px - p.openPrice) : NaN;
        return { side: p.side, qty: p.qty, upnl };
      })(),
      // pending orders on the chart's market (Vest + local stops): count and total size
      pendQty: pendingsOn(symbol, st, acc).reduce((s, o) => s + (o.qty || 0), 0),
      pendCount: pendingsOn(symbol, st, acc).length,
      pendings,
      labels: Object.fromEntries(Object.entries(S.symbols).map(([k, x]) => [k, x.label])),
    };
  }
  function pendingsOn(symbol, st, acc) {
    return [...(st.orders || []).filter((o) => o.symbol === symbol && !o.reduceOnly), ...stops.list().filter((x) => x.accountId === acc && x.symbol === symbol)];
  }
  const cancelPendingAny = (o) =>
    Promise.resolve().then(() => (o.local ? stops.cancel(o.id, 'by hand') : entry.cancelOrder({ accountId: S.selected, orderId: o.id, label: o.kind + ' @ ' + o.price })));

  // local stops: checked at every price, prices every 0.5 s while one exists; when orders are off, they are removed
  sync.onPrices(() => stops.check());
  // trailing and auto BE: native stop moved behind the price, only with Orders ON
  trail.setConfig(() => panel.ui());
  sync.onPrices(() => trail.check());
  sync.setFastPrices(() => stops.count() > 0 || trail.wants());
  orders.onChange(() => {
    if (!orders.enabled() && stops.count()) stops.cancelAll('Orders off');
  });
  // Vest lines to hide: the position line and its SL/TP, only when the overlay shows the same account Vest has on screen
  let screenAcc = null; // account on screen in Vest, followed by the loop below
  const VEST_CLS = new Set(['order', 'pnl', 'leg']);
  function ghostPolicy() {
    const st = overlay.state();
    const same = S.selected && S.selected === (screenAcc || sync.screenAccount(S.accounts));
    vestlines.setPolicy((cls, price) => {
      if (!st.visible || !panel.ui().hideVest) return false;
      // the overlay shows ANOTHER account (e.g. a copy chosen in the panel): Vest's lines belong to Vest's account
      // and next to the overlay's lines they are confusing. All of them are hidden.
      if (!same) return VEST_CLS.has(cls);
      // Vest pending orders: the overlay shows all of them (even when flat) with its own lines
      if (cls === 'order') return true;
      if (!st.posId) return false;
      // every Vest SL/TP of this account: matching by price made them reappear for a moment at every move
      // (Vest redraws its line at the new price before our state knows it). There is one position per market per account.
      return cls === 'pnl' || cls === 'leg';
    });
    // the HTML TP/SL buttons Vest shows when hovering the position line: same condition
    vestdom.setHidden(!!(st.visible && (st.posId || !same) && panel.ui().hideVest));
  }

  // Vest loads the chart a few seconds after the page: "not found" during that window is normal, not a warning.
  const CHART_GRACE_MS = 20000;
  const bootAt = Date.now();
  let lastChartWhy = null,
    chartSeen = false;
  function chartTick() {
    const found = tv.find();
    lastFound = found;
    if (found)
      try {
        vestlines.wrapApi(found.api); // every chart Vest asks for from now on comes out hooked
        vestlines.wrap(found.api.activeChart()); // as early as possible: lines Vest creates later go through us
      } catch {
        /* chart not ready */
      }
    chartSym = found ? tv.chartSymbol(found) : null;
    const mkt = chartSym && tv.marketOfChart(chartSym, S.symbols);
    if (mkt) sync.watchSymbol(mkt);
    S.chart.symbol = chartSym;
    const res = lines.render(found, lineSpecs());
    S.chart.ok = res.ok;
    S.chart.why = res.why;
    overlay.setEnabled(panel.ui().overlay !== false);
    ghostPolicy();
    if (res.ok && !chartSeen) {
      chartSeen = true;
      log.info(`Chart found: "${chartSym || '?'}" after ${((Date.now() - bootAt) / 1000).toFixed(1)} s`);
    }
    if (!chartSeen && Date.now() - bootAt < CHART_GRACE_MS) return; // still loading
    if (res.why !== lastChartWhy) {
      if (res.why) log.warn('Chart: ' + res.why);
      else if (lastChartWhy) log.info('Chart available again');
      lastChartWhy = res.why;
    }
  }

  function diag() {
    // Shapes only (names/types), check results and a cleaned log: no tokens, ids or amounts.
    const report = {
      tool: 'vest-tool',
      version,
      at: new Date().toISOString(),
      accounts: Object.keys(S.accounts).length,
      // per account: type and the kind of each daily field (empty/zero/positive), never the value
      daily: Object.values(S.accounts).map((a) => ({ type: a.type, ...a.dailyInfo })),
      feed: { attached: S.feed.attached, live: store.feedLive(), missing: S.feed.missing },
      chart: { ok: S.chart.ok, why: S.chart.why, symbol: S.chart.symbol, caps: tv.capabilities(tv.find()), overlay: overlay.state().why || 'visible', vestLines: vestlines.stats() },
      rate: { remaining: rate.remaining, limit: rate.limit },
      checks: S.checks,
      shapes: log.shapes(),
      log: log.entries().slice(-150),
    };
    const text = JSON.stringify(report, null, 2);
    navigator.clipboard.writeText(text).then(
      () => log.info(`Diagnostics copied (${(text.length / 1024).toFixed(1)} KB): shapes only, no tokens`),
      () => log.warn('Copy to clipboard failed'),
    );
  }

  function boot() {
    panel.mount(version, {
      trailStatus: () => trail.status(),
      sync: () => sync.full('manual'),
      check: () => check.run(),
      diag,
      calcResult,
      sessionState: () => session.status().state,
      onInput: () => chartTick(),
      toggleOrders,
      tradeInfo,
      cancelPending: cancelPendingAny,
      flattenAll: () => {
        const n = Object.keys(S.accounts).length;
        const ok = window.confirm(
          `FLATTEN ALL

Cancel EVERY pending order and close EVERY position at market on ${n} account${n === 1 ? '' : 's'}.
Works even with Orders OFF. It cannot be undone.`,
        );
        if (ok) {
          stops.cancelAll('FLATTEN ALL'); // local stops first: they must not open anything while closing
          flatten.flattenAll();
        }
      },
      ordersOn: () => orders.enabled(),
      copy: {
        state: () => copier.state(),
        setRole: (id, r) => copier.setRole(id, r),
        setMode: (m) => copier.setMode(m),
        stop: () => copier.stop('from the panel'),
        start: copyStart,
      },
    });
    overlay.mount({ getModel: tradeModel, actions: tradeActions });
    // every 100 ms at first: hook the chart before Vest draws its lines; then every 500 ms
    const fast = setInterval(chartTick, 100);
    setTimeout(() => clearInterval(fast), 15000);
    setInterval(chartTick, 500);
    // points: history read in turn, one account every 5 s; first the ones without it, then the ones whose positions changed
    let ptsTurn = 0;
    const ptsKey = {},
      ptsTried = new Set(); // an account that does not answer does not block the others
    setInterval(() => {
      if (session.status().state !== 'ok') return;
      const ids = pointsIds();
      if (!ids.length) return;
      const key = (id) => ((S.state[id] || {}).positions || []).map((p) => p.id + ':' + p.qty).join(',');
      const id = ids.find((x) => !(S.pts && S.pts[x]) && !ptsTried.has(x)) || ids.find((x) => ptsKey[x] !== undefined && ptsKey[x] !== key(x)) || ids[ptsTurn++ % ids.length];
      ptsTried.add(id);
      ptsKey[id] = key(id);
      sync.readPoints(id);
    }, 5000);
    // copier accounts (master + copies): Vest's feed covers only the account on screen, the others are re-read over REST,
    // in turn, one every 2 s (2 requests: ~60 a minute whatever the number of accounts)
    let copyTurn = 0;
    setInterval(() => {
      const cs = copier.state();
      const ids = cs.master && cs.followers.length ? [cs.master, ...cs.followers] : [];
      if (!ids.length || session.status().state !== 'ok') return;
      sync.refreshAccount(ids[copyTurn++ % ids.length], false);
    }, 2000);
    // the account chosen in Vest's dropdown becomes the overlay's and the panel's account; a click on a panel row holds
    // until the account is changed again in Vest. sessionStorage and localStorage can disagree (one keeps the old account):
    // the one that just changed wins
    let seen = { s: null, l: null };
    setInterval(() => {
      const c = sync.screenCandidates(S.accounts);
      const id = c.s && c.s !== seen.s ? c.s : c.l && c.l !== seen.l ? c.l : null;
      seen = c;
      if (!id || id === screenAcc) return;
      screenAcc = id;
      sync.refreshAccount(id); // the new account's feed sends only changes: the full state is re-read over REST
      if (S.selected !== id) {
        S.selected = id;
        store.changed();
      }
    }, 300);
    setInterval(() => {
      check.checkLive();
      store.changed(); // refreshes "x s ago" and the feed state even without events
    }, 2000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
}

module.exports = { start };
