// Startup. Order matters: the hooks (WebSocket, native fetch) must be installed at document-start, before Vest's code.
// Orders: only from the trade overlay (core/orders.js), only with the 'Orders' switch on. transport.js blocks the rest.

const hooks = require('./core/hooks');

/** Whole number from a panel field: empty or not a number -> def, otherwise kept between lo and hi. */
function clampInt(v, lo, hi, def) {
  const n = Math.round(parseFloat(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
}

/**
 * Two VestTool scripts enabled together in Tampermonkey = two copiers, two grids, double orders on the same events.
 * The first one marks the page; any later one does NOT start (no hooks, no panel) and says so at the top of the page.
 * Only versions with this check (v0.20.46+) leave the mark: an older one enabled before this one is not seen.
 */
function alreadyRunning(version) {
  const root = document.documentElement;
  const other = (root && root.getAttribute('data-vesttool')) || window.__vestToolRunning;
  if (!other) {
    const me = `VestTool v${version}`;
    if (root) root.setAttribute('data-vesttool', me);
    window.__vestToolRunning = me;
    return false;
  }
  const text = `VestTool v${version} NOT started: ${other} is already running in this page. Keep only ONE VestTool enabled in Tampermonkey, then reload.`;
  console.warn(text);
  const show = () => {
    if (!document.body || document.getElementById('vt-double')) return;
    const d = document.createElement('div');
    d.id = 'vt-double';
    d.textContent = text;
    d.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:8px 36px 8px 12px;background:#b91c1c;color:#fff;font:700 13px/1.35 system-ui,sans-serif;text-align:center;box-shadow:0 2px 8px #0008';
    const x = document.createElement('span');
    x.textContent = '✕';
    x.style.cssText = 'position:absolute;right:12px;top:7px;cursor:pointer';
    x.onclick = () => d.remove();
    d.appendChild(x);
    document.body.appendChild(d);
  };
  if (document.body) show();
  else document.addEventListener('DOMContentLoaded', show);
  return true;
}

function start(version) {
  if (alreadyRunning(version)) return;
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
  const selfmatch = require('./core/selfmatch');
  const entry = require('./core/entry');
  const stops = require('./core/stops');
  const trail = require('./core/trail');
  const bracketDca = require('./core/bracket');
const oco = require('./core/oco');
  const runner = require('./core/runner');
  const { toPts } = require('./domain/trail');
  const { breakevenPrice, legOrder } = require('./domain/orders');
  const copier = require('./core/copier');
  const { knockout, ladder, ddHalf } = require('./domain/ladder');
const { limitsOf } = require('./domain/account');
  const GD = require('./domain/guards');
  const GR = require('./domain/grid');
  const { legDeleteOrder } = require('./domain/orders');
  const { decimalsOf } = require('./domain/num');
  const panel = require('./ui/panel');
  const calc = require('./ui/calc');
  const F = require('./ui/format');
  const { rate } = require('./core/transport');
  const { S } = store;
  const DP = require('./domain/daypts');
  const Z = require('./domain/sizing');
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
    // safe runner (experimental): one line per tranche stop, or the start level before it takes over
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
  // ── ACCOUNT LIMITS guard: each row of Account limits can FLAT everything when its level is reached. ON states in memory
  // only (OFF after every reload); levels saved in the panel (lg_<row>). Selected account, plus its copies when it is the
  // copier master. One shot: a row that fires switches itself OFF.
  const guardOn = {};
  let guardBusy = false;
  // DAILY PROFIT TARGET uses the panel's daily goal; the others their own saved level. Never beyond the account's limit (GD.caps).
  // manual daily drawdown limit / profit target from the panel (ON + amount): they replace Vest's (Instant accounts)
  const manLim = () => {
    const u = panel.ui();
    return { day: u.mdOn ? parseFloat(u.mdUsd) : NaN, goal: u.mtOn ? parseFloat(u.mtUsd) : NaN };
  };
  // ACCOUNT PROFIT TARGET has no level of its own any more: the target itself (an old saved lg_tg is ignored)
  const guardRaw = (k) => (k === 'dg' ? panel.ui().dailyGoal : k === 'tg' ? '' : panel.ui()['lg_' + k]);
  const guardLevels = (g) => {
    const c = GD.caps(g);
    return Object.fromEntries(GD.KEYS.map((k) => [k, GD.levelOf(k, guardRaw(k), c[k])]));
  };
  function guardInputs(acc) {
    const a = S.accounts[acc],
      v = (acc && store.values(acc)) || {},
      st = S.state[acc];
    const posColl = ((st && st.positions) || []).reduce((t, p) => t + (p.collateral || 0), 0);
    const all = posColl + ((st && st.ordersCollateral) || 0);
    const openLoss = Number.isFinite(v.upnl) ? Math.max(0, -v.upnl) : NaN; // whole account, every market
    const limits = limitsOf(a, v, manLim());
    const left = limits.dayManual ? limits.dayLeft : a && a.dailyFloor > 0 && v.equity >= 0 ? v.equity - a.dailyFloor : v.toFloor;
    const risk = { marginPos: v.equity > 0 ? posColl / v.equity : NaN, marginAll: v.equity > 0 ? all / v.equity : NaN, used: openLoss, left };
    const openProfit = Number.isFinite(v.upnl) ? Math.max(0, v.upnl) : NaN;
    const base = { dayPl: limits.dayPl, upnl: v.upnl, dayLeft: limits.dayLeft, maxLeft: limits.maxLeft, pl: limits.pl };
    return { risk, limits, base, vals: GD.values({ risk, limits, openLoss, openProfit }), open: !!(((st && st.positions) || []).some((p) => p.qty > 0) || ((st && st.orders) || []).length || stops.list().some((x) => x.accountId === acc)) };
  }
  function guardModel() {
    const acc = S.selected;
    if (!acc) return null;
    const g = guardInputs(acc);
    const lv = guardLevels(g);
    const c = GD.caps(g);
    return Object.fromEntries(
      GD.KEYS.map((k) => {
        const raw = guardRaw(k);
        const auto = k === 'tg' && !(parseFloat(raw) > 0) && lv[k] > 0 ? (g.limits.goalManual ? 'manual target' : 'Vest target') : '';
        return [k, { kind: GD.KIND[k], eye: panel.ui()['ue_' + k] !== false, on: !!guardOn[k], level: lv[k], raw: raw == null ? '' : String(raw), cap: c[k], step: GD.stepOf(k, c[k]), text: GD.tooHigh(k, raw, c[k]) ? `must be below the limit $${c[k].toFixed(2)}` : GD.levelText(k, lv[k], auto), auto, hit: GD.reached(k, g.vals[k], lv[k]) }];
      }),
    );
  }
  function guardCheck() {
    const acc = S.selected;
    if (!acc || guardBusy || S.flattening || !GD.KEYS.some((k) => guardOn[k])) return;
    const g = guardInputs(acc);
    const f = GD.firing(g.vals, guardOn, guardLevels(g));
    if (!f.length || !g.open) return; // nothing open: nothing to close (the row stays ON)
    for (const x of f) guardOn[x.k] = false; // one shot
    const cs = copier.state();
    const ids = [acc, ...(cs.master === acc ? cs.followers.filter((id) => id !== acc) : [])];
    const why = f.map((x) => `${GD.ROWS[x.k].name} ${GD.ROWS[x.k].unit === '%' ? x.value.toFixed(1) + ' %' : '$' + x.value.toFixed(2)} (${GD.levelText(x.k, x.level)})`).join(', ');
    log.warn(`ACCOUNT LIMITS: ${why} -> FLAT ${ids.length} account${ids.length === 1 ? '' : 's'}`);
    panel.say(`ACCOUNT LIMITS: ${f.map((x) => GD.ROWS[x.k].name).join(', ')} reached -> FLAT`, 'warn');
    guardBusy = true;
    for (const x of stops.list()) if (ids.includes(x.accountId)) stops.cancel(x.id, 'ACCOUNT LIMITS'); // local entries first: they must not open anything
    Promise.resolve(flatten.flattenAll(ids, 'ACCOUNT LIMITS', { auto: true }))
      .catch((e) => log.error(`ACCOUNT LIMITS FLAT: ${e.message}`))
      .finally(() => (guardBusy = false));
  }
  setInterval(guardCheck, 500);
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
    const gBase = ui.gdOn ? gridBase(acc, symbol, m) : null;
    const gLive = gdLiveOn(acc, symbol);
    const gGrid = gBase && (ui.gdTpOn || ui.gdSlOn) ? gridOf(gBase, m) : null;
    if (gGrid && gLive && gBase.src === 'position') gridDiff(gBase.pos, gGrid, m, ui); // marks the legs already on Vest
    // pending orders on this market (Vest: entry limits; local: entry stops) for the lines with X
    const pendings = [
      ...((st && st.orders) || [])
        .filter((o) => o.symbol === symbol && o.price > 0) // all of them: Vest's own order lines are hidden
        .map((o) => ({ id: o.id, kind: 'lm', label: o.reduceOnly ? 'CLOSE' : 'LIMIT', side: o.side, price: o.price, qty: o.qty, local: false })),
      ...stops
        .list()
        .filter((x) => x.accountId === acc && x.symbol === symbol)
        .map((x) => ({ id: x.id, kind: 'st', label: x.lim ? 'LIMIT' : undefined, lim: !!x.lim, br: x.br || null, side: x.side, price: x.trigger, qty: x.qty, local: true, plan: x.plan ? { sl: x.plan.sl, targets: x.plan.targets } : null })),
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
      const sy = copier.syncOf(id, symbol);
      return { id, label: lb, num, mult: copier.multOf(id), act: act.lvl, actTip: act.tip, sync: sy, master: id === cs.master, qty: p ? p.qty : 0, side: p ? p.side : null, ...Object.fromEntries(KEYS.map((k) => [k, cv[k]])) };
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
          n = 0,
          win = 0,
          loss = 0;
        const ids = pointsIds();
        if (!ids.length) return null;
        for (const id of ids) {
          const h = S.pts && S.pts[id];
          if (!h) return null;
          // only the Vest day (since 20:00 New York time), not the whole history
          const d = DP.sumSince(h.map, vestDayStart(Date.now()));
          closed += d.pts;
          n += d.n; // REALISED only: the open position does not count
          win += d.win;
          loss += d.loss;
        }
        return { closed, open, n, win, loss, label: (S.accounts[ids[0]] || {}).label || ids[0], master: ids[0] === copier.state().master };
      })(),
      selected: S.selected,
      copy: cs.followers.length && copyRows.length ? { armed: cs.armed, dry: cs.dry, rows: copyRows, tot: copyTot } : null,
      market: { symbol, label: m.label, tick: m.tick, step: m.step, fee: m.takerFee, priceDec: m.priceDec, mark: (S.marks[symbol] || {}).px },
      pos,
      lev: size.lev,
      size,
      capPct: +ui.capPct || 0, // per-order cap: also limits the Risk & targets plan
      tb: { trOn: !!ui.trOn, trUnit: ui.trUnit, trAct: ui.trAct, trDist: ui.trDist, trStep: ui.trStep, beOn: !!ui.beOn, beUnit: ui.beUnit, beOff: ui.beOff, beAuto: !!ui.beAuto, beAt: ui.beAt, note: panel.trailNote(), brOn: !!ui.brOn, brSl: ui.brSl, brTp: ui.brTp, brDca: !!ui.brDca, ocoOn: !!ui.ocoOn, srMode: ui.srMode, srAct: ui.srAct, srLock: ui.srLock, srTight: ui.srTight, srPausePct: ui.srPausePct, srRunPct: ui.srRunPct, srRunAtr: ui.srRunAtr, srGate: !!ui.srGate, srClimax: !!ui.srClimax, notes: { ...panel.sideNotes(), gd: gridNote(m) }, srTrend: runner.trend(chartMarket()), ...gridKeys(ui) },
      grid: gGrid,
      gridEn: ui.gdOn ? gridEnOf(acc, symbol, m).g : null,
      gdLive: gLive,
      gdHide: gLive && pos ? { tp: !!ui.gdTpOn, sl: !!ui.gdSlOn } : null, // ACTIVE: the grid labels stand for the legs on Vest
      gdFar: gBase ? { ref: gBase.tpRef, tpRef: gBase.tpRef, slRef: gBase.slRef, side: gBase.side, tp: !!ui.gdTpOn, sl: !!ui.gdSlOn } : null,
      pct: +ui.sizePct || 0,
      pendings,
      phLegs: (((st && st.placeholders) || []).find((p) => p.symbol === symbol) || {}).triggers || null, // legs Vest keeps on the pending LIMIT
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
          // down to the daily loss limit (Vest's, or the manual one from the panel)
          left: (() => {
            const L = limitsOf(a, v, manLim());
            return L.dayManual ? L.dayLeft : a && a.dailyFloor > 0 && v.equity >= 0 ? v.equity - a.dailyFloor : v.toFloor;
          })(),
        };
      })(),
      // average entry if all entry limits fill (position + limits): AVG label
      // fail price: where the equity reaches the drawdown limit, with the entry limits that fill on the way
      sr: runner.lineSpecs(isChartSym), // safe runner levels: labels in the overlay column, like SL / TP
      avg: ladder({ pos, orders: pendings.filter((o) => !o.local && o.label === 'LIMIT'), equity: v.equity, mark: (S.marks[symbol] || {}).px }),
      ko: knockout({
        pos,
        orders: pendings.filter((o) => !o.local && o.label === 'LIMIT'),
        equity: v.equity,
        mark: (S.marks[symbol] || {}).px,
        floors: { total: a && a.floor, daily: a && a.dailyFloor },
      }),
      limits: limitsOf(a, v, manLim()),
      guards: guardModel(), // Account limits: ON / OFF and level of each row (FLAT when reached)
      // Account limits switched ON: the price of this market where each $ row fires, drawn as a USER line (Gerry 2026-11-23)
      userLines: (() => {
        const mk = (S.marks[symbol] || {}).px;
        if (!acc || !pos || !(mk > 0) || !GD.KEYS.some((k) => guardOn[k])) return [];
        const g = guardInputs(acc);
        const lv = guardLevels(g);
        return GD.KEYS.filter((k) => guardOn[k] && panel.ui()['ue_' + k] !== false)
          .map((k) => ({ k, name: GD.ROWS[k].name, level: lv[k], price: GD.priceOf(k, lv[k], g.base, pos, mk) }))
          .filter((x) => x.price > 0);
      })(),
      // drawdown levels: three labels, each ON / OFF with its own % (panel, Chart display); dd50 = the middle one's switch
      ddLv: [
        ['dd25On', 'ddP1', 25],
        ['dd50', 'ddP2', 50],
        ['dd75On', 'ddP3', 75],
      ].map(([on, pk, def]) => {
        const u = panel.ui();
        const pct = parseFloat(u[pk]);
        const p = pct > 0 && pct < 100 ? pct : def;
        return u[on] !== false
          ? ddHalf({
              pos,
              orders: pendings.filter((o) => !o.local && o.label === 'LIMIT'),
              equity: v.equity,
              balance: v.balance,
              mark: (S.marks[symbol] || {}).px,
              floors: { total: a && a.floor, daily: a && a.dailyFloor },
              initial: a && a.initial,
              tick: (S.symbols[symbol] || {}).tick,
              pct: p,
            })
          : null;
      }),
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
      chartCommon: panel.chartCommon(),
      btnColors: panel.btnColors(),
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
      theme: ui.theme === 'sonar' || ui.theme === 'classic' ? ui.theme : 'console',
      cardsCol: panel.cardsColumn(), // cards in the docked column (null = next to the price axis)
      hlOn: ui.hlOn !== false,
      atrOn: false, // multi-timeframe volatility removed (Gerry 2026-11-23): swing range only, in the panel
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
  // Vest data needed before the tool can be used (Gerry 2026-11-23: after a reload the panel looked ready but was not).
  // Once everything has arrived it stays ready (a later session blip must not grey out FLAT in the middle of a trade).
  let vestReady = false;
  function waitingFor() {
    if (vestReady) return [];
    const w = [];
    if (session.status().state !== 'ok') w.push('session');
    if (!Object.keys(S.accounts).length || !S.selected || !S.accounts[S.selected]) w.push('accounts');
    else if (!S.state[S.selected]) w.push('positions');
    if (!w.length) vestReady = true;
    return w;
  }
  // ── Grid (column section, experimental): entry LIMITs + SL / TP ladders. Gerry 2026-11-23.
  // OFF / PLAN (lines on the chart, nothing sent) / ACTIVE (after START: entries placed once, SL / TP follow every change).
  // ACTIVE lives in this tab only and is never restored after a reload (like Risk ON).
  const GD_KEYS = ['gdTpFixPx', 'gdSlFixPx', 'gdOn', 'gdEnOn', 'gdTpOn', 'gdSlOn', 'gdEnAvg', 'gdTpAvg', 'gdSlAvg', 'gdEnSide', 'gdEnNear', 'gdEnFar', 'gdEnMid', 'gdEnPct', 'gdEnDist', 'gdEnSize', 'gdEnCustom', 'gdEnOv', 'gdEnMan', 'gdEnFixPx', 'gdTpNear', 'gdTpFar', 'gdTpMid', 'gdTpPct', 'gdTpDist', 'gdTpSize', 'gdTpCustom', 'gdTpOv', 'gdTpMan', 'gdSlNear', 'gdSlFar', 'gdSlMid', 'gdSlDist', 'gdSlSize', 'gdSlCustom', 'gdSlOv', 'gdSlMan'];
  const GD_BOOL = new Set(['gdOn', 'gdEnOn', 'gdTpOn', 'gdSlOn', 'gdEnAvg', 'gdTpAvg', 'gdSlAvg']);
  const gridKeys = (ui) => Object.fromEntries(GD_KEYS.map((k) => [k, GD_BOOL.has(k) ? !!ui[k] : ui[k]]));
  const gnum = (v) => parseFloat(String(v ?? '').replace(',', '.'));
  let gdLive = null; // ACTIVE: { acc, symbol, enSent, hadPos, t0, sig, since, until, tries, busy, msg }
  const gdLiveOn = (acc, symbol) => !!(gdLive && gdLive.acc === acc && gdLive.symbol === symbol);
  const gdCfg = (u, p) => ({ off: !u[`gd${p}On`], near: u[`gd${p}Near`], far: u[`gd${p}Far`], mid: u[`gd${p}Mid`], dist: u[`gd${p}Dist`], size: u[`gd${p}Size`], custom: u[`gd${p}Custom`], ov: u[`gd${p}Ov`], man: u[`gd${p}Man`], pct: p === 'Tp' ? u.gdTpPct : 100 });
  // what the SL / TP ladders are computed on: the open position; without one, the entries waiting on this market (LIMITs on
  // Vest, local STOPs and, in PLAN, the grid's own entries) as if they all filled
  function gridBase(acc, symbol, m) {
    const st = (acc && S.state[acc]) || {};
    const pos = (st.positions || []).find((p) => p.symbol === symbol && p.qty > 0);
    const ent = [
      ...(st.orders || []).filter((o) => o.symbol === symbol && o.price > 0 && !o.reduceOnly).map((o) => ({ side: o.side, price: o.price, qty: o.qty })),
      ...stops.list().filter((x) => x.accountId === acc && x.symbol === symbol).map((x) => ({ side: x.side, price: x.trigger, qty: x.qty })),
    ];
    const live = gdLiveOn(acc, symbol);
    if (!live) for (const l of gridEnOf(acc, symbol, m).g.legs) ent.push({ side: l.side, price: l.price, qty: l.qty });
    // SL beyond the farthest entry (also the ones already filled: kept from START), never between two entries
    const worst = (side, prices) => (side === 'long' ? Math.min(...prices) : Math.max(...prices));
    if (pos) {
      const more = ent.filter((e) => e.side === pos.side).map((e) => e.price);
      if (live && gdLive.slRef > 0) more.push(gdLive.slRef);
      return { side: pos.side, qty: pos.qty, openPrice: pos.openPrice, tpRef: pos.openPrice, slRef: worst(pos.side, [pos.openPrice, ...more]), symbol, src: 'position', pos };
    }
    if (!ent.length) {
      // nothing open or waiting: as if opened now at the market price with the Trade commands size, on the grid's Side
      const mark = (S.marks[symbol] || {}).px;
      const sz = acc && mark > 0 ? entry.sizeFor(acc, symbol, +panel.ui().sizePct || 0) : null;
      if (!sz || sz.why || !(sz.qty > 0)) return null;
      const side = panel.ui().gdEnSide === 'short' ? 'short' : 'long';
      // FIX on TP / SL: measured from the price frozen when FIX was pressed (Gerry 2026-11-23)
      const fT = gnum(panel.ui().gdTpFixPx), fS = gnum(panel.ui().gdSlFixPx);
      return { side, qty: sz.qty, openPrice: mark, tpRef: fT > 0 ? fT : mark, slRef: fS > 0 ? fS : mark, symbol, src: 'market', fixTp: fT > 0, fixSl: fS > 0 };
    }
    const side = ent[0].side;
    const same = ent.filter((e) => e.side === side && e.qty > 0);
    const qty = same.reduce((a, e) => a + e.qty, 0);
    if (!(qty > 0)) return null;
    const px = same.map((e) => e.price);
    if (live && gdLive.slRef > 0) px.push(gdLive.slRef);
    // TP from the entry that fills first (the position starts there; after each fill they follow the position average)
    const first = side === 'long' ? Math.max(...same.map((e) => e.price)) : Math.min(...same.map((e) => e.price));
    return { side, qty: +qty.toFixed(decimalsOf(m.step)), openPrice: same.reduce((a, e) => a + e.price * e.qty, 0) / qty, tpRef: first, slRef: worst(side, px), symbol, src: 'pending', n: same.length, mixed: same.length < ent.length };
  }
  function gridOf(base, m) {
    const u = panel.ui();
    const g = GR.grid({ pos: base, m, mark: (S.marks[base.symbol] || {}).px, tp: gdCfg(u, 'Tp'), sl: gdCfg(u, 'Sl') });
    for (const l of [...g.tp, ...g.sl]) {
      l.ref = l.kind === 'tp' ? base.tpRef : base.slRef;
      l.side = base.side;
      if (base.src !== 'position') delete l.bad; // on entries still waiting the current price says nothing
    }
    return g;
  }
  // entry LIMITs of the grid: total = % of the maximum size (as Trade commands), split over the levels
  function gridEnOf(acc, symbol, m) {
    const u = panel.ui();
    const none = (why) => ({ g: { legs: [], avg: NaN, qty: 0, why, warn: [] } });
    if (!u.gdEnOn || (gdLiveOn(acc, symbol) && gdLive.enSent)) return none('');
    const pct = gnum(u.gdEnPct);
    if (!(pct > 0)) return none(u.gdEnNear ? 'ENTRIES: set the total size %' : '');
    const sz = acc && symbol ? entry.sizeFor(acc, symbol, pct) : { why: 'no market' };
    if (sz.why) return { ...none('ENTRIES: ' + sz.why), sz };
    // FIX: the entries are measured from the price frozen when FIX was pressed, not from the market price (Gerry 2026-11-23)
    const mark = (S.marks[symbol] || {}).px;
    const fix = gnum(u.gdEnFixPx);
    const g = GR.entries({ side: u.gdEnSide === 'short' ? 'short' : 'long', mark: fix > 0 ? fix : mark, total: sz.qty, m, cfg: { near: u.gdEnNear, far: u.gdEnFar, mid: u.gdEnMid, dist: u.gdEnDist, size: u.gdEnSize, custom: u.gdEnCustom, ov: u.gdEnOv, man: u.gdEnMan } });
    if (fix > 0 && mark > 0)
      for (const l of g.legs) {
        // a LIMIT on the wrong side of the price now would fill at once (or be refused): marked, START refuses it
        const ok = l.side === 'long' ? l.price <= mark - 2 * m.tick : l.price >= mark + 2 * m.tick;
        if (!ok) l.bad = 'the price has already gone past it';
      }
    g.fix = fix > 0 ? fix : NaN;
    return { g, sz };
  }
  // grid legs vs the legs on Vest (only the kinds whose ladder is on): what to add, what to remove. Marks the matched ones (on).
  function gridDiff(pos, g, m, u) {
    const want = [...(u.gdSlOn ? g.sl : []), ...(u.gdTpOn ? g.tp : [])];
    const free = pos.triggers.filter((t) => (t.kind === 'tp' ? u.gdTpOn : u.gdSlOn));
    const add = [];
    // size of a leg: from Vest when it gives it, else the one this grid sent at that price (Vest may not echo it)
    const sent = (gdLive && gdLive.sent) || {};
    const qOf = (t) => (t.qty > 0 ? t.qty : sent[t.kind + '|' + t.price]);
    for (const l of want) {
      const j = free.findIndex((t) => {
        if (t.kind !== l.kind || Math.abs(t.price - l.price) >= m.tick / 2) return false;
        const q = qOf(t);
        return l.all ? q === undefined || q === 'all' || Math.abs(q - pos.qty) < m.step / 2 : q > 0 && Math.abs(q - l.qty) < m.step / 2;
      });
      if (j >= 0) {
        l.on = true;
        free.splice(j, 1);
      } else add.push(l);
    }
    return { add, del: free };
  }
  // new legs first (SL before TP), then the old ones removed: the position is never left without its stop in between
  async function gridSend(acc, pos, d, m) {
    const dec = decimalsOf(m.step);
    for (const l of d.add) {
      const o = legOrder(pos, l.kind, l.price, m.tick);
      if (!l.all) o.body.quantity = l.qty.toFixed(dec);
      if (gdLive) (gdLive.sent = gdLive.sent || {})[l.kind + '|' + +o.body.triggerPrice] = l.all ? 'all' : l.qty;
      await orders.send(acc, o, `GRID ${l.kind.toUpperCase()}${l.n} at ${l.price}${l.all ? ' (rest)' : ' x ' + l.qty}`, pos.id);
    }
    for (const t of d.del) await orders.send(acc, legDeleteOrder(pos, t), `GRID: ${t.kind.toUpperCase()} at ${t.price} removed`, pos.id);
  }
  function gridEnd(why) {
    log.warn(`GRID: ACTIVE ended — ${why}. Orders left as they are on Vest; the grid is back to PLAN.`);
    panel.say(`GRID ACTIVE ended: ${why}`, 'warn');
    gdLive = null;
  }
  // ACTIVE: every second, SL / TP on Vest brought back to the grid (after 1.5 s of no change, 4 s pause after each update)
  async function gridFollow() {
    if (!gdLive || gdLive.busy) return;
    const u = panel.ui();
    if (!u.gdOn) return void (gdLive = null);
    const { acc, symbol } = gdLive;
    const m = S.symbols[symbol];
    const st = S.state[acc] || {};
    const pos = (st.positions || []).find((p) => p.symbol === symbol && p.qty > 0);
    const now = Date.now();
    const pause = (why) => void (gdLive.msg = 'ACTIVE but PAUSED: ' + why);
    if (!pos) {
      const waiting = (st.orders || []).some((o) => o.symbol === symbol && !o.reduceOnly) || stops.list().some((x) => x.accountId === acc && x.symbol === symbol);
      if (gdLive.hadPos) return gridEnd('the position was closed');
      if (!waiting && !gdLive.market && now - gdLive.t0 > 15000) return gridEnd('no position and no entry waiting on this market');
      gdLive.msg = waiting
        ? 'ACTIVE: waiting for the fill — the SL / TP are placed on the position as soon as it opens.'
        : 'ACTIVE: waiting for a position on this market (open it with LONG / SHORT): the grid SL / TP go on it at once.';
      return;
    }
    gdLive.hadPos = true;
    if (!m) return;
    if (!(u.gdTpOn || u.gdSlOn)) return void (gdLive.msg = 'ACTIVE: TP and SL ladders both off, nothing to follow.');
    if (u.trOn || u.beAuto || u.srMode === 'live') return pause('trailing / auto BE / Safe runner LIVE move one stop: switch them off');
    if (u.brOn && u.brDca) return pause('Bracket "follow adds" is on: switch it off');
    if (!orders.enabled()) return pause('ORDERS are off');
    if (now < gdLive.until || orders.busyOn(pos.id)) return;
    const g = gridOf(gridBase(acc, symbol, m), m);
    if (g.why.length) return pause(g.why[0]);
    const bad = [...(u.gdTpOn ? g.tp : []), ...(u.gdSlOn ? g.sl : [])].find((l) => l.bad);
    if (bad) return pause(`${bad.kind.toUpperCase()}${bad.n} at ${bad.price}: ${bad.bad}`);
    const d = gridDiff(pos, g, m, u);
    if (!d.add.length && !d.del.length) {
      Object.assign(gdLive, { sig: '', tries: 0, msg: 'ACTIVE: the SL / TP on Vest match the grid.' });
      return;
    }
    const sig = JSON.stringify([d.add.map((l) => [l.kind, l.price, l.all ? 0 : l.qty]), d.del.map((t) => t.id)]);
    if (sig !== gdLive.sig) return void Object.assign(gdLive, { sig, since: now, msg: 'ACTIVE: grid changed, SL / TP updated in a moment…' });
    if (now - gdLive.since < 1500) return;
    if (++gdLive.tries > 2) return gridEnd('the SL / TP on Vest still differ from the grid after 2 updates: check them by hand');
    gdLive.busy = true;
    try {
      await gridSend(acc, pos, d, m);
      if (gdLive) Object.assign(gdLive, { until: Date.now() + 4000, msg: 'ACTIVE: SL / TP updated.' });
    } catch (e) {
      gridEnd('update refused (' + e.message + ')');
    } finally {
      if (gdLive) gdLive.busy = false;
    }
  }
  setInterval(() => gridFollow().catch((e) => log.error('GRID: ' + e.message)), 1000);
  function gridNote(m) {
    const u = panel.ui();
    if (!u.gdOn) return { text: 'OFF. Press OFF in the title for PLAN: the grid is drawn on the chart, nothing is sent until START.', warn: false };
    if (!m) return { text: '', warn: false };
    const acc = S.selected,
      symbol = chartMarket();
    const live = gdLiveOn(acc, symbol);
    const dec = m.priceDec;
    const en = gridEnOf(acc, symbol, m).g;
    const tx = [live ? gdLive.msg || 'ACTIVE' : 'PLAN: nothing is sent. START places it; from then on the SL / TP follow every change.'];
    let warn = false;
    if (live && gdLive.enSent && u.gdEnOn) tx.push('ENTRIES: placed — they are normal LIMITs now (move or cancel them on the chart).');
    else if (u.gdEnOn) {
      tx.push(en.fix > 0 ? `ENTRIES FIXED at ${F.price(en.fix, dec)} (they no longer follow the price)` : '', en.why, en.legs.length ? `ENTRIES: ${en.legs.map((l) => `${l.side === 'long' ? 'BUY' : 'SELL'}${l.n} ${l.price} ${F.qty(l.qty)}`).join(' · ')} — total ${F.qty(en.qty)}, average if all fill ${F.price(en.avg, dec)}` : '', ...en.warn);
      warn = !!en.why;
    }
    if (u.gdTpOn || u.gdSlOn) {
      const b = gridBase(acc, symbol, m);
      if (!b) tx.push('SL / TP: no position, no entry waiting and no grid entry on this market to compute them on.');
      else {
        const g = gridOf(b, m);
        const line = (l) => `${l.kind.toUpperCase()}${l.n} ${l.price} ${l.all ? 'ALL ' : ''}${F.qty(l.qty)}${l.bad ? ' (wrong side!)' : ''}`;
        tx.push(
          b.src === 'position'
            ? `SL / TP on the position ${b.side.toUpperCase()} ${F.qty(b.qty)} @ ${F.price(b.openPrice, dec)}`
            : b.src === 'market'
            ? `SL / TP at the market price ${F.price(b.openPrice, dec)}${b.fixTp ? `, TP FIXED from ${F.price(b.tpRef, dec)}` : ''}${b.fixSl ? `, SL FIXED from ${F.price(b.slRef, dec)}` : ''}, ${b.side.toUpperCase()} (Side) with the Trade commands size ${F.qty(b.qty)} — after START they go on the next position you open with LONG / SHORT (from its entry price, FIX no longer counts)`
            : `SL / TP on the ${b.n} entr${b.n > 1 ? 'ies' : 'y'} waiting (${b.side.toUpperCase()} ${F.qty(b.qty)} if all fill, average ${F.price(b.openPrice, dec)}): TP from the first entry ${F.price(b.tpRef, dec)}, SL from the farthest ${F.price(b.slRef, dec)} — placed on the position after the fill, then TP follow the average and the sizes follow the position`,
          b.mixed ? `entries on both sides: only the ${b.side.toUpperCase()} ones counted` : '',
          b.src !== 'market' && (gnum(u.gdTpFixPx) > 0 || gnum(u.gdSlFixPx) > 0) ? 'FIX on TP / SL ignored: they are measured from the position / entries' : '',
          ...g.why,
          g.tp.length ? 'TP: ' + g.tp.map(line).join(' · ') : '',
          g.sl.length ? 'SL: ' + g.sl.map(line).join(' · ') : '',
          ...g.warn,
        );
        warn = warn || g.why.length > 0 || [...g.tp, ...g.sl].some((l) => l.bad);
      }
      if (u.trOn || u.beAuto || u.srMode === 'live') {
        tx.push('Trailing / auto BE / Safe runner LIVE move ONE stop: switch them off before START.');
        warn = true;
      }
      if (u.brOn && u.brDca) {
        tx.push('Bracket "follow adds" is on: it would move SL / TP back after every grid update. Switch it off.');
        warn = true;
      }
    }
    tx.push('Drag a GRID level on the chart to move it (the others stay where they are, the sizes are recalculated); a TP / SL dragged from Trade commands becomes the farthest level. Typing in a box recalculates the in-between levels.');
    return { text: tx.filter(Boolean).join('  —  '), warn };
  }
  function toggleOrders() {
    if (orders.enabled()) return orders.setEnabled(false);
    if (waitingFor().length) return panel.say('Wait for Vest data: ORDERS can be switched on in a moment', 'warn');
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
    guardToggle: (k) => {
      if (!GD.ROWS[k]) return;
      if (!guardOn[k]) {
        const g = guardInputs(S.selected);
        const lv = guardLevels(g)[k];
        if (!(lv > 0)) throw new Error(`${GD.ROWS[k].name}: set the level first`);
        if (GD.reached(k, g.vals[k], lv) && !window.confirm(`${GD.ROWS[k].name}: the level (${GD.levelText(k, lv)}) is ALREADY reached.\n\nSwitch it ON anyway? Everything open on this account${copier.state().master === S.selected ? ' and its copies' : ''} is closed at once.`)) return;
      }
      guardOn[k] = !guardOn[k];
      log.info(`ACCOUNT LIMITS ${GD.ROWS[k].name}: ${guardOn[k] ? 'ON, ' + GD.levelText(k, guardLevels(guardInputs(S.selected))[k]) : 'OFF'}`);
    },
    // eye of an Account limits row: its USER line on the chart or not (saved)
    guardEye: (k) => GD.ROWS[k] && panel.setUiInput('ue_' + k, panel.ui()['ue_' + k] === false),
    guardLevel: (k, v) => GD.ROWS[k] && panel.setUiInput(k === 'dg' ? 'dailyGoal' : 'lg_' + k, String(v).trim().replace(',', '.')),
    panelOpen: (open) => panel.setMin(!open), // Trade commands floating: the main panel is shown in the column
    toggleOrders: () => toggleOrders(),
    // Grid: title button OFF <-> PLAN; ACTIVE -> asks, then OFF (orders stay on Vest)
    gridMode: () => {
      if (gdLive) {
        if (!window.confirm('Grid ACTIVE: stop following?\n\nThe orders already on Vest (entry LIMITs, SL, TP) STAY as they are: the grid only stops updating them.')) return;
        gdLive = null;
        log.info('GRID: ACTIVE stopped by hand (orders left on Vest)');
        return panel.setUiInput('gdOn', false);
      }
      panel.setUiInput('gdOn', !panel.ui().gdOn);
    },
    gridStart: () =>
      Promise.resolve().then(async () => {
        if (gdLive) throw new Error('the grid is already ACTIVE');
        const u = panel.ui();
        if (!u.gdOn) throw new Error('the grid is OFF');
        if (!orders.enabled()) throw new Error('Orders are off: switch ORDERS on');
        const symbol = chartMarket();
        const acc = S.selected;
        const m = symbol && S.symbols[symbol];
        if (!m) throw new Error('chart market not recognised');
        const exits = u.gdTpOn || u.gdSlOn;
        if (!u.gdEnOn && !exits) throw new Error('Entries, TP and SL are all off');
        if (exits && (u.trOn || u.beAuto || u.srMode === 'live')) throw new Error('switch off trailing, auto BE and Safe runner LIVE first: they move one stop');
        if (exits && u.brOn && u.brDca) throw new Error('Bracket "follow adds" is on: it would move SL / TP back after every grid update. Switch it off first');
        let en = null;
        if (u.gdEnOn) {
          en = gridEnOf(acc, symbol, m);
          if (en.g.why) throw new Error(en.g.why);
          if (!en.g.legs.length) throw new Error('the entry grid is empty');
          if (u.ocoOn) throw new Error('OCO is on: the first fill would cancel the other grid LIMITs. Switch OCO off first');
          const cap = +u.capPct;
          const big = en.g.legs.find((l) => en.sz.max > 0 && (l.qty / en.sz.max) * 100 > cap + 1e-9);
          if (big) throw new Error(`${big.side === 'long' ? 'BUY' : 'SELL'}${big.n} is ${+((big.qty / en.sz.max) * 100).toFixed(2)}% of the max size, above the per-order cap (${cap}%)`);
          const past = en.g.legs.find((l) => l.bad);
          if (past) throw new Error(`${past.side === 'long' ? 'BUY' : 'SELL'}${past.n} at ${past.price}: ${past.bad} (entries FIXED at ${en.g.fix})`);
        }
        const base = gridBase(acc, symbol, m);
        if (exits && !base && !en) throw new Error('no position and no entry waiting on this market: nothing to put SL / TP on');
        const g = exits && base ? gridOf(base, m) : null;
        if (g && g.why.length) throw new Error(g.why[0]);
        const pos = base && base.src === 'position' ? base.pos : null;
        const bad = g && pos && [...(u.gdTpOn ? g.tp : []), ...(u.gdSlOn ? g.sl : [])].find((l) => l.bad);
        if (bad) throw new Error(`${bad.kind.toUpperCase()}${bad.n} at ${bad.price}: ${bad.bad}`);
        const a = S.accounts[acc];
        const line = (l) => `  ${l.kind.toUpperCase()}${l.n}  ${l.price}  ${l.all ? 'the rest of the position' : F.qty(l.qty)}  (${F.usd(l.usd, true)})`;
        const sl = g && u.gdSlOn ? g.sl : [],
          tp = g && u.gdTpOn ? g.tp : [];
        const enTx = en ? `\nENTRY LIMITs, now\n${en.g.legs.map((l) => `  ${l.side === 'long' ? 'BUY' : 'SELL'}${l.n}  LIMIT ${F.qty(l.qty)} @ ${l.price}`).join('\n')}\n  total ${F.qty(en.g.qty)}, average if all fill ${F.price(en.g.avg, m.priceDec)}\n` : '';
        const exTx = exits ? `\n${pos ? 'SL / TP on the position, now (the SL / TP already on it are REPLACED)' : base && base.src === 'market' ? 'SL / TP placed on the NEXT position you open on this market (LONG / SHORT), sized on it' : 'SL / TP placed on the position as soon as an entry fills (sizes then follow the position)'}\n${[...sl, ...tp].map(line).join('\n') || '  (computed after the entries)'}\n` : '';
        const ok = window.confirm(`Grid START (experimental) on ${a ? a.label : acc}, ${m.label || symbol}:
${enTx}${exTx}
Then the grid stays ACTIVE: when you change a box or drag a level, and when the position size changes, its SL / TP on Vest are updated (about 2 s later). The entry LIMITs are placed once: after that they are normal LIMITs.
OFF in the title stops it (orders stay). ACTIVE is never restored after a reload.
${u.brOn && en && !pos ? 'Bracket ON: its SL / TP go on the first LIMIT, then the grid replaces them after the fill.\n' : ''}${copier.state().armed ? 'Copier ON: everything is copied.\n' : ''}Try at minimum size first.`);
        if (!ok) throw new Error('not sent');
        gdLive = { acc, symbol, market: !!(base && base.src === 'market' && !en), slRef: base && base.src !== 'market' ? base.slRef : NaN, enSent: !!en, hadPos: !!pos, t0: Date.now(), sig: '', since: 0, until: 0, tries: 0, busy: true, msg: 'ACTIVE: starting…' };
        try {
          if (en) await entry.placeGrid({ accountId: acc, symbol, legs: en.g.legs, lev: en.sz.lev });
          if (pos && g) {
            await gridSend(acc, pos, gridDiff(pos, g, m, u), m);
            gdLive.until = Date.now() + 4000;
          }
        } catch (e) {
          gdLive = null;
          throw e;
        }
        gdLive.busy = false;
        gdLive.t0 = Date.now();
        log.info(`GRID: ACTIVE on ${a ? a.label : acc} ${symbol}${en ? `, ${en.g.legs.length} entry LIMIT(s) sent` : ''}${exits ? (pos ? ', SL / TP on the position' : ', SL / TP after the fill') : ''}`);
        return 'GRID ACTIVE';
      }),
    // a GRID level dropped on the chart: that level goes there, the others stay where they are (their distances are kept)
    gridDrag: (kind, i, of, price, which, other) => {
      const P = kind === 'en' ? 'En' : kind === 'tp' ? 'Tp' : 'Sl';
      const u = panel.ui();
      const symbol = chartMarket();
      const m = symbol && S.symbols[symbol];
      if (!m || !(of >= 1) || !(i >= 0 && i < of)) return '';
      let ref, sgn;
      if (kind === 'en') {
        ref = gnum(u.gdEnFixPx) > 0 ? gnum(u.gdEnFixPx) : (S.marks[symbol] || {}).px;
        sgn = u.gdEnSide === 'short' ? 1 : -1;
      } else {
        const b = gridBase(S.selected, symbol, m);
        if (!b) return '';
        ref = kind === 'tp' ? b.tpRef : b.slRef;
        sgn = (b.side === 'long' ? 1 : -1) * (kind === 'tp' ? 1 : -1);
      }
      const d = +(sgn * (price - ref)).toFixed(decimalsOf(m.tick) + 2);
      if (!(d > 0)) throw new Error(`GRID ${kind.toUpperCase()}: wrong side of ${kind === 'en' ? 'the price' : 'the entry'}`);
      const near = gnum(u[`gd${P}Near`]);
      const far = gnum(u[`gd${P}Far`]) > 0 ? gnum(u[`gd${P}Far`]) : near;
      panel.setUiInput(`gd${P}Ov`, ''); // no level is kept aside any more (Gerry: the curve must follow)
      const realEnd = (k) => k === 0 || k === of - 1;
      if (which && of > 2 && other >= 0 && other < of && other !== i && !(realEnd(i) && realEnd(other))) {
        // the first / last level DRAWN is not level 1 / last (that one was merged, too small, Gerry 2026-11-23): every
        // distance is near + (far - near) * c, so Nearest and Farthest are solved to put the dragged level where it was
        // dropped and keep the other end drawn where it is; the curve stays
        const c = GR.distances(0, 1, of, u[`gd${P}Dist`], u[`gd${P}Man`]);
        const dOther = near + (far - near) * c[other];
        const span = (d - dOther) / (c[i] - c[other]);
        const nn = d - span * c[i], ff = nn + span;
        if (!(nn > 0) || !(ff > nn) || !Number.isFinite(nn) || !Number.isFinite(ff))
          throw new Error(`GRID ${kind === 'en' ? 'entry' : kind.toUpperCase()}: that level cannot go there with this curve (set Nearest / Farthest in the section)`);
        panel.setUiInput(`gd${P}Near`, String(+nn.toFixed(6)));
        panel.setUiInput(`gd${P}Far`, String(+ff.toFixed(6)));
        return `GRID ${kind === 'en' ? 'entry' : kind.toUpperCase()} ${which === 'near' ? 'nearest' : 'farthest'} level at ${d} pt, the other end stays at ${+dOther.toFixed(2)} pt, the levels in between follow the ${u[`gd${P}Dist`] === 'manual' ? 'Manual slider' : 'curve'}`;
      }
      if (of <= 2 || i === 0 || i === of - 1) {
        // nearest or farthest moved: only that end changes, the levels in between follow the curve (or the Manual slider,
        // in proportion)
        let nn = of === 1 || i === 0 ? d : near,
          ff = of === 1 || i === of - 1 ? d : far;
        if (nn > ff) [nn, ff] = [ff, nn]; // dragged past the other end
        panel.setUiInput(`gd${P}Near`, String(+nn.toFixed(6)));
        panel.setUiInput(`gd${P}Far`, of > 1 && ff > nn ? String(+ff.toFixed(6)) : '');
        return `GRID ${kind === 'en' ? 'entry' : kind.toUpperCase()} ${i === 0 ? 'nearest' : 'farthest'} level at ${d} pt: the others follow the ${u[`gd${P}Dist`] === 'manual' ? 'Manual slider' : 'curve'}`;
      }
      // a level in between: the ladder becomes Manual with the levels where they are now (the slider shows them)
      const cur = GR.withOv(GR.distances(near, far, of, u[`gd${P}Dist`], u[`gd${P}Man`]), u[`gd${P}Ov`]);
      cur[i] = Math.min(far - 1e-9, Math.max(near + 1e-9, d)); // between the two ends
      const s = cur.sort((a, b) => a - b);
      const span = far - near;
      const pc = s.slice(1, -1).map((x) => Math.min(99.9, Math.max(0.1, +(((x - near) / span) * 100).toFixed(1))));
      panel.setUiInput(`gd${P}Man`, pc.join(', '));
      panel.setUiInput(`gd${P}Dist`, 'manual');
      return `GRID ${kind === 'en' ? 'entry' : kind.toUpperCase()} level ${i + 1} at ${+cur[i].toFixed(2)} pt: Distances set to Manual (slider)`;
    },
    // TP / SL dragged from Trade commands while the grid is on: it becomes the farthest level of that ladder (nothing sent)
    gridFar: (kind, price) => {
      const P = kind === 'tp' ? 'Tp' : 'Sl';
      const u = panel.ui();
      const symbol = chartMarket();
      const m = symbol && S.symbols[symbol];
      const b = m && gridBase(S.selected, symbol, m);
      if (!b) throw new Error('GRID: no position or entry to measure from');
      const d = +((b.side === 'long' ? 1 : -1) * (kind === 'tp' ? 1 : -1) * (price - (kind === 'tp' ? b.tpRef : b.slRef))).toFixed(decimalsOf(m.tick) + 2);
      if (!(d > 0)) throw new Error(`GRID ${kind.toUpperCase()}: wrong side of the entry`);
      const near = gnum(u[`gd${P}Near`]);
      if (!(near > 0) || d <= near) {
        panel.setUiInput(`gd${P}Near`, String(d));
        panel.setUiInput(`gd${P}Far`, '');
      } else panel.setUiInput(`gd${P}Far`, String(d));
      panel.setUiInput(`gd${P}Ov`, ''); // the levels in between follow the curve
      return `GRID ${kind.toUpperCase()}: farthest level at ${price} (${d} pt)`;
    },
    // FLAT: local stops, pending orders and position on the chart's market; active even when flat and with Orders OFF
    flat: () =>
      Promise.resolve().then(async () => {
        const symbol = chartMarket();
        if (!symbol || !S.selected) throw new Error('chart market not recognised');
        const st = stops.cancelWhere(S.selected, symbol, 'FLAT');
        const acc = S.selected;
        // SELF-MATCHING: with the copier ON the master's close must not fill against a copy's order still being
        // cancelled by its own FLAT: the orders of master and copies on this market are cancelled first
        const cs = copier.state();
        const grp = cs.armed && !cs.dry && cs.master === acc ? [acc, ...cs.followers.filter((id) => id !== acc)] : [];
        const pre = grp.length > 1 ? (await Promise.allSettled(grp.map((id) => flatten.cancelOrdersOn(id, symbol)))).reduce((a, x) => a + (x.status === 'fulfilled' ? x.value : 0), 0) : 0;
        const [r] = await Promise.all([flatten.flattenMarket(acc, symbol), copier.mirrorFlat(acc, symbol)]); // master: FLAT on the copies too
        const cp = await copier.flatIdleCopies(acc, symbol); // copier OFF: copies still open on this market -> asked (after the master)
        if (!r.cancelled && !r.closed && !st && !cp && !pre) throw new Error('nothing to close or cancel on this market');
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
    setSetting: (k, v) => {
      panel.setUiInput(k, v); // Trailing & breakeven, Bracket, Grid... sections of the column
      // a grid box typed by hand: the in-between levels follow the curve again (those moved on the chart are dropped)
      const g = /^gd(En|Tp|Sl)(Near|Far|Mid|Dist|Side|Man)$/.exec(k);
      if (g) panel.setUiInput(`gd${g[1]}Ov`, '');
    },
    exclusive: (k) => panel.exclusive(k, true), // Risk & targets switched ON: incompatible functions OFF
    setLeg: (kind, price, existing) => Promise.resolve().then(() => orders.setLeg(S.selected, curPos(), kind, price, existing)),
    removeLeg: (leg) => Promise.resolve().then(() => orders.removeLeg(S.selected, curPos(), leg)),
    // second card
    setPct: (v) => {
      panel.setUi('sizePct', v);
      // Grid on with Entries: the % buttons of Trade commands also set the grid's total size (Gerry 2026-11-23)
      const u = panel.ui();
      if (u.gdOn && u.gdEnOn) panel.setUiInput('gdEnPct', String(v));
    },
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
        if (!orders.enabled()) throw new Error('Orders are off: switch ORDERS on (Trade commands)');
        const args = { accountId: S.selected, symbol, price, pct: +ui.sizePct || 0, cap: +ui.capPct || 0 };
        if (kind === 'lm') {
          // OCO: a LIMIT on the side opposite to a pending Vest LIMIT (Vest keeps one side per market) is kept LOCAL
          const ph = entry.placeholderOn(S.selected, symbol);
          const side = Z.entrySide('lm', price, (S.marks[symbol] || {}).px);
          if (ui.ocoOn && ph && side && ph.side !== side && !entry.positionOn(S.selected, symbol)) return stops.arm({ ...args, lim: true });
          return entry.placeLimit(args);
        }
        return stops.arm(args);
      }),
    // Risk & targets, Active mode: entries with the plan's size and SL / TP (in place of the % size)
    planEntry: (type, side, price, plan) =>
      Promise.resolve().then(async () => {
        const symbol = chartMarket(),
          acc = S.selected;
        if (!symbol || !acc) throw new Error('chart market not recognised');
        const r = await entry.planOpen({ accountId: acc, symbol, side, type, price, plan });
        guardPlan(acc, symbol, plan.sl, type);
        return r;
      }),
    // plan STOP: LOCAL (Vest has no entry stop), when touched it sends the market entry with the plan's SL / TP
    planStop: (side, price, plan) =>
      Promise.resolve().then(() => {
        const symbol = chartMarket(),
          acc = S.selected;
        if (!symbol || !acc) throw new Error('chart market not recognised');
        if (!orders.enabled()) throw new Error('Orders are off: switch ORDERS on (Trade commands)');
        const st = stops.arm({ accountId: acc, symbol, price, plan });
        if (st.side !== side) {
          stops.cancel(st.id, 'wrong side');
          throw new Error(`a ${side === 'long' ? 'BUY stop goes above' : 'SELL stop goes below'} the price`);
        }
        return st;
      }),
    planStopMove: (o, price, plan) => Promise.resolve().then(() => stops.move(o.id, price, plan)),
    planMove: (o, price, plan) =>
      Promise.resolve().then(async () => {
        const symbol = chartMarket(),
          acc = S.selected;
        if (!symbol || !acc) throw new Error('chart market not recognised');
        const r = await entry.planMove({ accountId: acc, symbol, order: o, price, plan });
        guardPlan(acc, symbol, plan.sl, 'limit');
        return r;
      }),
    say: (text, kind) => panel.say(text, kind),
    head: (d) => panel.headPos(d),
    swing: (t) => panel.swingNote(t),
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
    // SL / TP of a PENDING entry dragged on the chart (Gerry 2026-11-21). prices = { sl, tp } (tp NaN = none).
    // Local entry: its own distances, used when it fires. Vest LIMIT: cancelled and placed again at the same price and size
    // with these legs (Vest attaches legs to /open only).
    pendingBracket: (o, prices) =>
      Promise.resolve().then(() => {
        const d = o.side === 'long' ? 1 : -1;
        if (!(d * (o.price - prices.sl) > 0)) throw new Error('SL on the wrong side of the entry');
        if (prices.tp > 0 && !(d * (prices.tp - o.price) > 0)) throw new Error('TP on the wrong side of the entry');
        if (o.local) return stops.setBracketOf(o.id, { sl: +Math.abs(o.price - prices.sl).toFixed(8), tp: prices.tp > 0 ? +Math.abs(prices.tp - o.price).toFixed(8) : NaN });
        if (!orders.enabled()) throw new Error('Orders are off: switch ORDERS on (Trade commands)');
        const plan = { qty: o.qty, sl: prices.sl, targets: prices.tp > 0 ? [{ price: prices.tp, qty: o.qty }] : [], each: false };
        return entry.planMove({ accountId: S.selected, symbol: chartMarket(), order: o, price: o.price, plan });
      }),
    cancelPending: (o) =>
      Promise.resolve().then(() => (o.local ? stops.cancel(o.id, 'by hand') : entry.cancelOrder({ accountId: S.selected, orderId: o.id, label: `LIMIT ${o.side === 'long' ? 'BUY' : 'SELL'} @ ${o.price}` }))),
    // LIMIT / STOP already placed and dragged on the chart: the local stop changes price, the Vest limit is replaced (new one, then the old one cancelled)
    movePending: (o, price) =>
      Promise.resolve().then(() =>
        o.local ? stops.move(o.id, price) : entry.moveLimit({ accountId: S.selected, symbol: chartMarket(), order: { ...o, reduceOnly: o.label === 'CLOSE' }, price }),
      ),
  };
  // ── safety net of the Active plan: if the position appears WITHOUT a stop (legs refused or lost), the stop is added
  // with the single-stop request already in use (whole position). In memory only: after a reload it is not watched.
  const planGuards = new Map(); // 'acc|symbol' -> { sl, until, seen, sending }
  // plan STOP touched: market entry with the plan, watched like the others
  stops.setPlanFire((st) =>
    entry.planOpen({ accountId: st.accountId, symbol: st.symbol, side: st.side, type: 'market', price: null, plan: st.plan }).then((r) => {
      guardPlan(st.accountId, st.symbol, st.plan.sl, 'market');
      return r;
    }),
  );
  function guardPlan(acc, symbol, sl, type) {
    planGuards.set(acc + '|' + symbol, { sl, until: Date.now() + (type === 'limit' ? 7 * 864e5 : 20000), seen: 0, sending: false, t0: Date.now() });
  }
  setInterval(() => {
    const now = Date.now();
    for (const [k, g] of planGuards) {
      const [acc, symbol] = k.split('|');
      const pos = entry.positionOn(acc, symbol);
      if (!pos) {
        // market: not filled within 20 s / limit: cancelled (no pending slot any more) -> nothing to watch
        if (g.seen || now > g.until || (now - g.t0 > 5000 && !entry.placeholderOn(acc, symbol))) planGuards.delete(k);
        continue;
      }
      if (!g.seen) g.seen = now;
      if (pos.triggers.some((t) => t.kind === 'sl')) {
        planGuards.delete(k);
        continue;
      }
      if (now - g.seen < 5000 || g.sending) continue;
      g.sending = true;
      const m = S.symbols[symbol];
      orders
        .send(acc, legOrder(pos, 'sl', g.sl, m.tick), `PLAN: the position had NO stop, stop added at ${g.sl}`, pos.id)
        .then(
          () => panel.say(`The position had no stop: stop added at ${g.sl}`, 'err'),
          (e) => panel.say(`POSITION WITHOUT STOP: adding it at ${g.sl} failed (${e.message}). Set the SL now`, 'err'),
        )
        .finally(() => planGuards.delete(k));
    }
  }, 1000);

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
    Promise.resolve().then(() => (o.local ? stops.cancel(o.id, 'by hand') : entry.cancelOrder({ accountId: o.accountId || S.selected, orderId: o.id, label: o.kind + ' @ ' + o.price })));
  // pending orders of every account for the panel's Accounts overview (Vest limits + local stops)
  function pendingsAll() {
    const ids = Object.keys(S.accounts).sort((a, b) => String(S.accounts[a].label).localeCompare(String(S.accounts[b].label), 'en', { numeric: true }));
    return ids.flatMap((id) => {
      const st = S.state[id] || {};
      const account = S.accounts[id].label;
      return [
        ...(st.orders || []).map((o) => ({ key: id + '|' + o.id, accountId: id, account, id: o.id, kind: o.reduceOnly ? 'close' : 'LIMIT', side: o.side, price: o.price, qty: o.qty, symbol: o.symbol, local: false })),
        ...stops.list().filter((x) => x.accountId === id).map((x) => ({ key: id + '|' + x.id, accountId: id, account, id: x.id, kind: 'local STOP', side: x.side, price: x.trigger, qty: x.qty, symbol: x.symbol, local: true })),
      ];
    });
  }

  // KILL SWITCH (Gerry 2026-11-20): Ctrl+Shift+K twice within 2 s = FLATTEN ALL on every account, local stops removed,
  // copier off. Two presses instead of a confirm: fast, but one stray keystroke does nothing. Works even with Orders OFF.
  let killAt = 0;
  const killKey = (e) => {
      if (e.repeat || !e.ctrlKey || !e.shiftKey || e.altKey || e.code !== 'KeyK') return;
      e.preventDefault();
      e.stopPropagation();
      const now = Date.now();
      if (now - killAt > 2000) {
        killAt = now;
        log.warn('KILL SWITCH: press Ctrl+Shift+K again within 2 s to FLATTEN ALL');
        panel.say('KILL SWITCH: press Ctrl+Shift+K again within 2 s to FLATTEN ALL', 'warn');
        return;
      }
      killAt = 0;
      if (S.flattening) return;
      log.warn('KILL SWITCH: FLATTEN ALL');
      panel.say('KILL SWITCH: FLATTEN ALL sent', 'warn');
      stops.cancelAll('KILL SWITCH');
      copier.stop('KILL SWITCH');
      flatten.flattenAll();
  };
  window.addEventListener('keydown', killKey, true);
  // the chart is a same-origin iframe: with the focus on it the keys go to its document
  const killDocs = new WeakSet();
  setInterval(() => {
    for (const f of document.querySelectorAll('iframe')) {
      let d = null;
      try {
        d = f.contentDocument;
      } catch {
        /* other origin */
      }
      if (d && !killDocs.has(d)) {
        killDocs.add(d);
        d.addEventListener('keydown', killKey, true);
      }
    }
  }, 3000);

  // local stops: checked at every price, prices every 0.5 s while one exists; when orders are off, they are removed
  sync.onPrices(() => stops.check());
  // trailing and auto BE: native stop moved behind the price, only with Orders ON
  trail.setConfig(() => panel.ui());
  sync.onPrices(() => trail.check());
  // safe runner (experimental): tranche stops from the 1m candles, native stop + local tranche exits
  runner.setConfig(() => panel.ui());
  // bracket: fixed SL / TP in points on every new position opened from the tool (Risk & targets OFF only: plans have their own)
  bracketDca.setConfig(() => {
    const u = panel.ui();
    const sl = parseFloat(u.brSl),
      tp = parseFloat(u.brTp);
    return u.brOn && sl > 0 ? { sl, tp: tp > 0 ? tp : NaN, follow: !!u.brDca } : null;
  });
  sync.onPrices(() => bracketDca.check());
  oco.setConfig(() => !!panel.ui().ocoOn);
  // copier "DD left" sizing: $ left before an account fails = the smaller of daily and max drawdown left (equity with open P&L)
  copier.setRoom((id) => {
    const L = limitsOf(S.accounts[id], store.values(id) || {}, manLim());
    const r = [L.dayLeft, L.maxLeft].filter(Number.isFinite);
    return r.length ? Math.min(...r) : NaN;
  });
  stops.setOco(() => !!panel.ui().ocoOn);
  entry.setBracket(() => {
    const u = panel.ui();
    if (!u.brOn) return null; // Risk & targets plans go through planOpen / planMove: no bracket there
    const sl = parseFloat(u.brSl),
      tp = parseFloat(u.brTp);
    return sl > 0 ? { sl, tp: tp > 0 ? tp : NaN } : null;
  });
  sync.onPrices(() => runner.check());
  sync.setFastPrices(() => stops.count() > 0 || trail.wants() || runner.wants());
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
      selfMatch: { run: () => selfmatch.run(), dismiss: () => selfmatch.dismiss() },
      riskOn: () => overlay.riskOn(),
      riskOff: () => overlay.riskOff(),
      trailStatus: () => trail.status(),
      runnerStatus: () => runner.status(),
      runnerTrend: () => runner.trend(chartMarket()),
      sync: () => sync.full('manual'),
      check: () => check.run(),
      diag,
      calcResult,
      sessionState: () => session.status().state,
      waitingFor,
      onInput: () => chartTick(),
      toggleOrders,
      tradeInfo,
      pendingsAll,
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
        setDry: (v) => copier.setDry(v),
        setLimit: (id, k, v) => copier.setLimit(id, k, v),
        setMult: (id, p) => copier.setMult(id, p),
        stop: () => copier.stop('from the panel'),
        start: copyStart,
      },
    });
    // SELF-MATCHING: block / warning of the last order, and resting orders that already cross (checked at most twice a second)
    selfmatch.subscribe((v) => panel.smShow(v));
    selfmatch.setRoles(() => {
      const c = copier.state();
      return c.armed && c.master ? { master: c.master, followers: c.followers } : null;
    });
    let smAt = 0;
    store.subscribe(() => {
      if (Date.now() - smAt < 500) return;
      smAt = Date.now();
      panel.smCross(selfmatch.crossingText());
    });
    overlay.mount({ getModel: tradeModel, actions: tradeActions });
    // start: the panel (right column, header says what is missing) is there at once; the sections and the chart lines are
    // invisible until Vest data are in, then they fade in; after 10 s still waiting they are shown anyway, not clickable.
    // Gerry 2026-11-23: no grey see-through start.
    const t0show = Date.now();
    const showNow = () => {
      const w = waitingFor().length > 0;
      overlay.setWaiting(w);
      const vis = !w || Date.now() - t0show > 10000;
      overlay.reveal(vis);
    };
    showNow();
    setInterval(showNow, 150);
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
