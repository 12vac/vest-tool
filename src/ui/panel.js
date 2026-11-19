// Panel in a closed Shadow DOM. Minimal look. Orders are sent only from the chart overlay, with the Orders switch on.
const css = require('./panel.css');
const F = require('./format');
const calc = require('./calc');
const { HELP } = require('./help');
const store = require('../core/store');
const log = require('../diag/log');
const dock = require('./dock');

const UI_KEY = 'vt1:ui';
// chart overlay lines: [kind, name, default colour] (colour, dash and width of each one can be changed)
const LINE_KINDS = [
  ['long', 'LONG', '#3ecf8e'],
  ['short', 'SHORT', '#ff6b61'],
  ['avg', 'AVG ALL', '#5ad1e6'],
  ['avg1', 'AVG NEXT', '#5ad1e6'],
  ['avgn', 'AVG NEW', '#5ad1e6'],
  ['ko', 'FAIL', '#c58cff'],
  ['dd50', '50% DRAWDOWN', '#f472b6'],
  ['mfp', 'FAIL NEW', '#ff9f43'],
  ['tp', 'TP', '#3ecf8e'],
  ['sl', 'SL', '#ff6b61'],
  ['lm', 'LIMIT', '#7fb2ff'],
  ['st', 'STOP', '#e8b84a'],
];
// trailing and BE segments between candles and labels: [kind, name, colour, dash]; width 3, automatic length
const SEG_KINDS = [
  ['tstop', 'Trailing: stop', '#ff9f43', 'solid'],
  ['tact', 'Trailing: start level', '#5ad1e6', 'solid'],
  ['tnext', 'Trailing: next step', '#a3e635', 'solid'],
  ['beplus', 'BE+', '#e879f9', 'solid'],
  ['beauto', 'Auto BE', '#e879f9', 'dashed'],
];
// last swing high / low: short lines between the cards and the price axis (fixed length)
const HL_KINDS = [
  ['hhigh', 'Last swing high', '#3ecf8e', 'solid'],
  ['hlow', 'Last swing low', '#ff6b61', 'solid'],
];
const LINE_DEFAULTS = Object.fromEntries([
  ...LINE_KINDS.flatMap(([k, , c]) => [['lc_' + k, c], ['ls_' + k, 'dashed'], ['lw_' + k, '1']]),
  ...SEG_KINDS.flatMap(([k, , c, s]) => [['lc_' + k, c], ['ls_' + k, s], ['lw_' + k, '3'], ['ll_' + k, '']]),
  ...HL_KINDS.flatMap(([k, , c, s]) => [['lc_' + k, c], ['ls_' + k, s], ['lw_' + k, '2']]),
]);
// colours of the entry buttons and FLAT in Trade commands, and of the mode words: [key, name, default]
const BTN_COLS = [
  ['lm', 'LIMIT', '#1d4ed8', '#e0ecff'],
  ['st', 'STOP', '#74746b', '#ffffff'],
  ['long', 'LONG', '#15803d', '#ffffff'],
  ['short', 'SHORT', '#b91c1c', '#ffffff'],
  ['flat', 'FLAT', '#ec9900', '#ffffff'],
];
const MODE_COLS = [
  ['manual', 'MANUAL (Risk & targets OFF)', '#cbd5e1'],
  ['view', 'RISK PLAN (ON, nothing placed yet)', '#fb923c'],
  ['act', 'RISK ACTIVE (ON, order or position there)', '#c084fc'],
];
const COL_DEFAULTS = Object.fromEntries([
  ...BTN_COLS.flatMap(([k, , bg, tx]) => [['bc_' + k + '_bg', bg], ['bc_' + k + '_tx', tx], ['bc_' + k + '_fs', '']]),
  ...MODE_COLS.flatMap(([k, , c]) => [['mc_' + k, c], ['mc_' + k + '_fs', ''], ['mc_' + k + '_lfs', ''], ['mc_' + k + '_fw', '']]),
]);
const { S } = store;

let root = null,
  panel = null,
  els = {},
  handlers = {};
let ui = { ...LINE_DEFAULTS, ...COL_DEFAULTS, qc: '#ffb402', qsz: '11', qb: true, trOn: false, trUnit: 'pt', trAct: '', trDist: '', trStep: '', beOn: false, beUnit: 'pt', beOff: '', beAuto: false, beAt: '', x: null, y: null, min: false, lines: true, overlay: true, dd50: true, hideVest: true, blockPct: 125, chipPct: 100, roomPx: 360, cdOn: true, theme: 'console', dock: true, dockW: 420, pstyle: 'console', cardsAt: 'column', hlOn: true, hlK: 2, atrOn: true, atrH: 14, atrR: 3, pp0: 1, pp1: 2, pp2: 4, pp3: 8, pp4: 5, pp5: 16, dailyGoal: '', closePct: 100, sizePct: 1, capPct: 10, mode: 'pos', slUsd: '', tpUsd: '', side: 'long', qty: '', entry: '', symbol: calc.DEFAULT_SYMBOL };

try {
  Object.assign(ui, JSON.parse(localStorage.getItem(UI_KEY) || '{}'));
} catch {
  /* default settings */
}
// v0.10.95: STOP and FLAT colours still at the old defaults -> the new defaults (colours chosen by hand are kept)
if (ui.bc_st_bg === '#eab308' && ui.bc_st_tx === '#1a1405') Object.assign(ui, { bc_st_bg: '#74746b', bc_st_tx: '#ffffff' });
if (ui.bc_flat_bg === '#d4a514' && ui.bc_flat_tx === '#17181b') Object.assign(ui, { bc_flat_bg: '#ec9900', bc_flat_tx: '#ffffff' });
// trailing and auto BE send orders on their own: off after every reload, like Orders (never re-armed automatically)
ui.trOn = false;
ui.beAuto = false;
const saveUi = () => {
  try {
    localStorage.setItem(UI_KEY, JSON.stringify(ui));
  } catch {
    /* nothing */
  }
};

// ── layout: foldable sections, each with a "?" that opens its explanation (texts in help.js)
// sections open by default; the others start folded. ui.fold remembers what the user opened or closed.
const OPEN_DEFAULT = { overview: true, trade: true, copier: true, accounts: true };
const isOpen = (k) => (ui.fold && k in ui.fold ? !!ui.fold[k] : !!OPEN_DEFAULT[k]);
const info = (k) => `<button class="qi" data-info="${k}" aria-label="What is this?">?</button>`;
const sec = (k, title, body) =>
  `<section class="sec${isOpen(k) ? '' : ' folded'}" data-sec="${k}"><div class="sh"><button class="fold" data-fold="${k}">${title}</button>${HELP[k] ? info(k) : ''}</div><div class="sb">${body}</div></section>`;
// one setting: label + its "?"
const opt = (k, inner) => `<span class="opt"><label class="il">${inner}</label>${info(k)}</span>`;
const chk = (k, text) => `<input type="checkbox" data-in="${k}"> ${text}`;
const num = (k, w, ph = '') => `<input data-in="${k}" inputmode="decimal"${ph ? ` placeholder="${ph}"` : ''} style="width:${w}px">`;
const unit = (k) => `<select data-in="${k}" style="width:44px"><option value="pt">pt</option><option value="$">$</option></select>`;

const modeSize = (k, list) => `<select data-in="${k}"><option value="">default</option>${list.map((v) => `<option value="${v}">${v} px</option>`).join('')}</select>`;

const SKELETON = `
<div class="dockbg" data-dockbg></div>
<div class="panel">
  <div class="head" data-drag>
    <span class="title">VestTool</span><span class="hdord" style="display:none"><button class="btn ord" data-act="orders" data-ord>Orders: OFF</button>${info('orders')}</span><span class="muted" data-ver></span><span class="say" data-say></span><span class="hbr"></span>
    <span class="hinfo" data-hinfo></span>
    <div class="dots" data-dots></div>
    <button class="btn" data-act="min" title="Minimise (Alt+Shift+V)">–</button>
    <div class="hpos" data-hpos style="display:none"></div>
  </div>
  <div class="body">
    ${sec('overview', 'Overview', `
      <div class="tot" data-totals></div>
      <div class="pl">
        <div class="plhead"><div><div class="plbig" data-plbig></div><div class="plsub" data-plsub></div></div>
          <span class="opt"><button class="btn flatall" data-act="flatall" data-flatall>FLATTEN ALL</button>${info('flatall')}</span></div>
        <div class="placc" data-placc></div>
      </div>`)}
    ${sec('trade', '<span data-trtitle>Trade</span>', `
      <div class="trd">
        <div class="trh"><b data-trsym></b><span class="lev" data-trlev></span><b class="trpx" data-trpx></b></div>
        <div class="trs" data-trsize></div>
        <div class="bars">
          <div class="bar"><div class="bl"><span>MARGIN</span><span data-mtxt></span></div><div class="track"><i data-mfill></i></div></div>
          <div class="bar"><div class="bl"><span>RISK</span><span data-rtxt></span></div><div class="track"><i data-rfill></i></div></div>
        </div>
        <h4>Pending orders</h4>
        <div class="pend" data-pend></div>
      </div>`)}
    ${sec('copier', 'Copier', `
      <div class="copy">
        <div class="cprow"><span class="muted">Sizing</span><button class="btn seg" data-cmode="1:1">1:1</button><button class="btn seg" data-cmode="cap">Cap-to-fit</button>
          <span class="cpst" data-cpst></span><button class="btn cpgo" data-act="copy" data-cpgo>START</button></div>
        <table class="cpacc" data-cpacc></table>
        <div class="note" data-cplast></div>
      </div>`)}
    ${sec('accounts', 'Accounts and positions', `
      <table data-accounts></table>
      <h4 data-pos-title style="margin-top:8px">Positions</h4><div data-positions></div>`)}
    <div class="group">Settings</div>
    ${sec('layout', 'Panel layout', `
      <div class="row">
        ${opt('dock', `column width ${num('dockW', 40)} px`)}
        ${opt('pstyle', `panel style <select data-in="pstyle" style="width:88px"><option value="console">Console</option><option value="classic">Classic</option></select>`)}
      </div>`)}
    ${sec('size', 'Order size and daily goal', `
      <div class="row">
        ${opt('capPct', `size cap ${num('capPct', 38)}%`)}
        ${opt('presets', `presets ${['pp0', 'pp1', 'pp2', 'pp3', 'pp4', 'pp5'].map((k) => num(k, 30)).join('')}%`)}
        ${opt('dailyGoal', `daily goal $${num('dailyGoal', 56)}`)}
      </div>`)}
    ${sec('stops', 'Trailing stop and breakeven', `
      <div class="row">
        ${opt('trailing', `${chk('trOn', 'trailing')} &nbsp;unit ${unit('trUnit')} &nbsp;start after ${num('trAct', 44, 'empty')} &nbsp;pullback ${num('trDist', 44, 'empty')} &nbsp;step ${num('trStep', 44, 'empty')}`)}
      </div>
      <div class="row">
        ${opt('breakeven', `${chk('beOn', 'BE+')} &nbsp;unit ${unit('beUnit')} &nbsp;profit ${num('beOff', 44, 'empty')} &nbsp;${chk('beAuto', 'auto BE after')} ${num('beAt', 44, 'empty')}`)}
      </div>
      <div class="note" data-trst></div>`)}
    ${sec('display', 'Chart display', `
      <div class="row">
        ${opt('overlay', chk('overlay', 'trade overlay (cards)'))}
        ${opt('lines', chk('lines', 'lines on the chart'))}
        ${opt('dd50', chk('dd50', '50% drawdown label'))}
        ${opt('hideVest', chk('hideVest', 'hide Vest lines'))}
        ${opt('countdown', chk('cdOn', 'candle countdown'))}
        ${opt('hilo', `${chk('hlOn', 'last swing high/low lines, swing =')} ${num('hlK', 30)} candles each side`)}
        ${opt('atr', `${chk('atrOn', 'volatility heatmap: last')} ${num('atrR', 30)} candles vs last ${num('atrH', 34)} hours`)}
      </div>
      <div class="row">
        ${opt('theme', `card style <select data-in="theme" style="width:88px"><option value="console">Console</option><option value="classic">Classic</option><option value="sonar">Sonar</option></select>`)}
        ${opt('blockPct', `card scale ${num('blockPct', 40)}%`)}
        ${opt('chipPct', `label scale ${num('chipPct', 40)}%`)}
        ${opt('roomPx', `label space ${num('roomPx', 40)}px`)}
      </div>
      <div class="row">
        ${opt('qty', `quantities: colour <input type="color" data-in="qc" style="width:34px;height:20px;padding:0 2px"> size <select data-in="qsz" style="width:64px">${[9, 10, 11, 12, 13, 14, 15, 16].map((v) => `<option value="${v}">${v} px</option>`).join('')}</select> ${chk('qb', 'bold')}`)}
      </div>`)}
    ${sec('colours', 'Line colours', `
      <table class="lstyle">
        ${LINE_KINDS.map(([k, name]) => `<tr><td>${name}</td><td><input type="color" data-in="lc_${k}"></td><td><select data-in="ls_${k}"><option value="dashed">dashed</option><option value="dotted">dotted</option><option value="solid">solid</option></select></td><td><select data-in="lw_${k}">${[1, 2, 3, 4].map((w) => `<option value="${w}">${w} px</option>`).join('')}</select></td><td></td></tr>`).join('')}
        <tr><td colspan="5"><h4 style="margin-top:6px">Trailing and BE segments (length in px, empty = automatic)</h4></td></tr>
        ${SEG_KINDS.map(([k, name]) => `<tr><td>${name}</td><td><input type="color" data-in="lc_${k}"></td><td><select data-in="ls_${k}"><option value="solid">solid</option><option value="dashed">dashed</option><option value="dotted">dotted</option></select></td><td><select data-in="lw_${k}">${[1, 2, 3, 4, 5, 6].map((w) => `<option value="${w}">${w} px</option>`).join('')}</select></td><td><input data-in="ll_${k}" inputmode="decimal" placeholder="auto" style="width:44px"> px</td></tr>`).join('')}
        <tr><td colspan="5"><h4 style="margin-top:6px">Last swing high / low</h4></td></tr>
        ${HL_KINDS.map(([k, name]) => `<tr><td>${name}</td><td><input type="color" data-in="lc_${k}"></td><td><select data-in="ls_${k}"><option value="solid">solid</option><option value="dashed">dashed</option><option value="dotted">dotted</option></select></td><td><select data-in="lw_${k}">${[1, 2, 3, 4].map((w) => `<option value="${w}">${w} px</option>`).join('')}</select></td><td></td></tr>`).join('')}
      </table>`)}
    ${sec('btncol', 'Button and mode colours', `
      <table class="lstyle">
        <tr><td></td><td class="muted">background</td><td class="muted">text</td><td class="muted">size</td></tr>
        ${BTN_COLS.map(([k, name]) => `<tr><td>${name}</td><td><input type="color" data-in="bc_${k}_bg"></td><td><input type="color" data-in="bc_${k}_tx"></td><td><select data-in="bc_${k}_fs"><option value="">default</option>${[10, 11, 12, 13, 14, 15, 16, 17, 18].map((v) => `<option value="${v}">${v} px</option>`).join('')}</select></td></tr>`).join('')}
        <tr><td colspan="5"><h4 style="margin-top:6px">Mode words (next to Trade commands and on the chart labels)</h4></td></tr>
        <tr><td></td><td class="muted">colour</td><td class="muted">size next to Trade commands</td><td class="muted">size on the labels</td><td class="muted">weight</td></tr>
        ${MODE_COLS.map(([k, name]) => `<tr><td>${name}</td><td><input type="color" data-in="mc_${k}"></td><td>${modeSize(`mc_${k}_fs`, [9, 10, 11, 12, 13, 14, 15, 16, 18, 20])}</td><td>${k === 'manual' ? '' : modeSize(`mc_${k}_lfs`, [8, 9, 10, 11, 12, 13, 14, 15, 16])}</td><td><select data-in="mc_${k}_fw"><option value="">default</option><option value="b">bold</option><option value="n">normal</option></select></td></tr>`).join('')}
      </table>
      <div class="row"><button class="btn" data-act="colreset">Default colours</button></div>`)}
    ${sec('calc', 'SL / TP calculator', `
      <div class="calc">
        <label>Base<select data-in="mode"><option value="pos">Account position</option><option value="man">Manual</option></select></label>
        <label>Stop loss $<input data-in="slUsd" inputmode="decimal" placeholder="e.g. 100"></label>
        <label>Take profit $<input data-in="tpUsd" inputmode="decimal" placeholder="e.g. 200"></label>
      </div>
      <div class="calc" data-manual>
        <label>Side<select data-in="side"><option value="long">Long</option><option value="short">Short</option></select></label>
        <label>Quantity (units)<input data-in="qty" inputmode="decimal"></label>
        <label>Entry (empty = mark)<input data-in="entry" inputmode="decimal"></label>
        <label>Symbol<input data-in="symbol"></label>
      </div>
      <div class="out" data-calc></div>`)}
    ${sec('guide', HELP.guide[0], `<div class="helptext">${HELP.guide[1]}</div>`).replace(info('guide'), '')}
    ${sec('diag', 'Diagnostics', `
      <h4>Startup check</h4><table class="checks" data-checks></table>
      <h4 style="margin-top:8px">Log</h4><div class="log" data-log></div>
      <div class="row" style="margin-top:8px">
        <button class="btn" data-act="sync">Reload all data</button>
        <button class="btn" data-act="check">Run check again</button>
        <button class="btn" data-act="session">Reset session P&L</button>
        <button class="btn" data-act="diag">Copy diagnostics</button>
        <span class="note" data-sync></span>
      </div>`)}
  </div>
  <div class="pop" data-pop style="display:none"><div class="pt" data-popt></div><div class="ph" data-poph></div></div>
</div>`;

function mount(version, h) {
  handlers = h;
  const host = document.createElement('div');
  root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>${css}</style>${SKELETON}`;
  document.documentElement.appendChild(host);
  panel = root.querySelector('.panel');
  for (const k of ['trsize', 'trtitle', 'trsym', 'trlev', 'trpx', 'mtxt', 'mfill', 'rtxt', 'rfill', 'pend', 'dots', 'totals', 'plbig', 'plsub', 'placc', 'flatall', 'accounts', 'positions', 'calc', 'checks', 'log', 'sync', 'manual', 'ver', 'ord', 'cpst', 'cpgo', 'cpacc', 'cplast', 'trst', 'say', 'hinfo', 'hpos']) els[k] = root.querySelector(`[data-${k}]`);
  els.posTitle = root.querySelector('[data-pos-title]');
  els.pop = root.querySelector('[data-pop]');
  els.popt = root.querySelector('[data-popt]');
  els.poph = root.querySelector('[data-poph]');
  els.body = root.querySelector('.body');
  els.ver.textContent = 'v' + version;
  // always docked with the cards in the column (only Trade commands can float): the panel opens folded at the top
  ui.dock = true;
  ui.cardsAt = 'column';
  ui.min = true;
  if (ui.min) panel.classList.add('min');
  if (ui.x != null) place(ui.x, ui.y);
  layout(true);

  // inputs: state kept in ui, recalculated at once
  for (const inp of root.querySelectorAll('[data-in]')) {
    const k = inp.dataset.in;
    if (inp.type === 'checkbox') inp.checked = !!ui[k];
    else inp.value = ui[k] ?? '';
    inp.addEventListener(inp.type === 'checkbox' || inp.tagName === 'SELECT' ? 'change' : 'input', () => {
      ui[k] = inp.type === 'checkbox' ? inp.checked : inp.value.trim().replace(',', '.');
      saveUi();
      if (k === 'dock' || k === 'dockW' || k === 'pstyle' || k === 'cardsAt') layout(k !== 'dockW'); // width: wait for the typing to stop
      handlers.onInput && handlers.onInput();
      render();
    });
  }
  root.addEventListener('click', (e) => {
    const inf = e.target.closest('[data-info]');
    if (inf) return showInfo(inf);
    if (!e.target.closest('[data-pop]')) showInfo(null);
    const fo = e.target.closest('[data-fold]');
    if (fo) return fold(fo.dataset.fold);
    const cx = e.target.closest('[data-cancel]');
    if (cx) {
      const it = lastPend.find((x) => String(x.id) === cx.dataset.cancel);
      if (it) {
        cx.disabled = true;
        handlers.cancelPending(it).catch((err) => log.error('Cancel failed: ' + err.message));
      }
      return;
    }
    const cm = e.target.closest('[data-cmode]');
    if (cm) return copyTry(() => handlers.copy.setMode(cm.dataset.cmode));
    const b = e.target.closest('[data-act]');
    if (b) return act(b.dataset.act);
  });
  root.addEventListener('change', (e) => {
    const al = e.target.closest('input[data-alias]');
    if (al) return store.setAlias(al.dataset.alias, al.value);
    const r = e.target.closest('select[data-crole]');
    if (r) copyTry(() => handlers.copy.setRole(r.dataset.crole, r.value));
  });
  // account selected on PRESS: rows are redrawn at every price and a click could get lost
  root.addEventListener('pointerdown', (e) => {
    const tr = e.target.closest('tr[data-id], .pla[data-id]'); // table or P&L row: selects the account
    if (!tr) return;
    S.selected = tr.dataset.id;
    handlers.onInput && handlers.onInput();
    render();
  });
  drag(root.querySelector('[data-drag]'));
  // the explanation closes on Esc, on a click outside the panel and when the panel scrolls (it would point at the wrong place)
  window.addEventListener('pointerdown', (e) => e.target !== host && showInfo(null), true);
  els.body.addEventListener('scroll', () => showInfo(null));
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape') showInfo(null);
      if (e.repeat || !e.altKey || !e.shiftKey || e.code !== 'KeyV') return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      act('min');
    },
    true,
  );
  log.onLog(() => renderLog());
  store.subscribe(render);
  render();
}

// opens or closes a section and remembers it
function fold(k) {
  const s = root.querySelector(`[data-sec="${k}"]`);
  if (!s) return;
  const open = s.classList.toggle('folded') === false;
  ui.fold = { ...(ui.fold || {}), [k]: open };
  saveUi();
}

// explanation popover under the clicked "?"; a second click on the same "?" closes it
let infoKey = null;
function showInfo(btn) {
  if (!els.pop) return;
  const k = btn && btn.dataset.info;
  if (!k || k === infoKey || !HELP[k]) {
    els.pop.style.display = 'none';
    infoKey = null;
    return;
  }
  infoKey = k;
  els.popt.textContent = HELP[k][0];
  els.poph.innerHTML = HELP[k][1];
  els.pop.style.display = '';
  const pr = panel.getBoundingClientRect(),
    br = btn.getBoundingClientRect();
  const w = Math.min(420, pr.width - 16);
  els.pop.style.width = w + 'px';
  els.pop.style.left = Math.max(8, Math.min(br.left - pr.left - w + br.width, pr.width - w - 8)) + 'px';
  // under the button; above it if there is no room below
  const h = els.pop.offsetHeight;
  const below = br.bottom - pr.top + 4;
  els.pop.style.top = (below + h > pr.height - 4 && br.top - pr.top - h - 4 > 0 ? br.top - pr.top - h - 4 : below) + 'px';
}

function act(a) {
  if (a === 'min') {
    showInfo(null);
    ui.min = !ui.min;
    panel.classList.toggle('min', ui.min);
    saveUi();
    layout(true);
  } else if (a === 'colreset') {
    for (const [k, v] of Object.entries(COL_DEFAULTS)) {
      ui[k] = v;
      const inp = root.querySelector(`[data-in="${k}"]`);
      if (inp) inp.value = v;
    }
    saveUi();
    handlers.onInput && handlers.onInput();
    render();
  } else if (a === 'sync') handlers.sync();
  else if (a === 'check') handlers.check();
  else if (a === 'session') store.resetSession();
  else if (a === 'diag') handlers.diag();
  else if (a === 'flatall') handlers.flattenAll();
  else if (a === 'copy') copyTry(() => (handlers.copy.state().armed ? handlers.copy.stop() : handlers.copy.start()));
  else if (a === 'orders') {
    handlers.toggleOrders();
    render();
  }
}

function copyTry(fn) {
  try {
    fn();
  } catch (e) {
    log.warn('Copier: ' + e.message);
  }
  render();
}

function renderCopy(ids, vals) {
  const c = handlers.copy && handlers.copy.state();
  if (!c) return;
  for (const b of root.querySelectorAll('[data-cmode]')) {
    b.classList.toggle('on', b.dataset.cmode === c.mode);
    b.disabled = c.armed;
  }
  els.cpgo.textContent = c.armed ? 'STOP' : 'START';
  els.cpgo.classList.toggle('on', c.armed);
  const name = (id) => (S.accounts[id] ? S.accounts[id].label : '?');
  els.cpst.innerHTML = c.armed
    ? `<b class="up">ACTIVE</b> ${F.esc(name(c.master))} → ${c.followers.length} cop${c.followers.length === 1 ? 'y' : 'ies'}`
    : '<span class="muted">off</span>';
  // the <select> is rebuilt only when something changes: redrawing it at every price would close an open dropdown
  const key = JSON.stringify([ids, c.roles, c.armed, ids.map((id) => S.accounts[id].label), ids.map((id) => store.activityOf(id).tip)]);
  if (els.cpacc.dataset.key !== key) {
    els.cpacc.dataset.key = key;
    els.cpacc.innerHTML = ids
      .map((id) => {
        const r = c.roles[id] || '';
        const opt = (v, t) => `<option value="${v}"${r === v ? ' selected' : ''}>${t}</option>`;
        const a = S.accounts[id];
        return `<tr><td>${adot(id)}<input class="alias" data-alias="${F.esc(id)}" value="${F.esc(store.aliasOf(id) || '')}" placeholder="${F.esc(a.autoLabel || a.label)}" title="Account name in this panel (Enter to save). Empty = automatic name."> <span class="muted">${F.esc(a.type)}</span>
          <span class="idt" title="Account id: ${F.esc(id)}. Compare it with the one copied by the icon next to the account name on Vest.">…${F.esc(String(id).slice(-6))}</span></td><td class="eq" data-cpeq="${F.esc(id)}"></td>
          <td><select data-crole="${F.esc(id)}"${c.armed ? ' disabled' : ''}>${opt('', '—')}${opt('master', 'Master')}${opt('copy', 'Copy')}</select></td></tr>`;
      })
      .join('');
  }
  for (const td of els.cpacc.querySelectorAll('[data-cpeq]')) td.textContent = F.usd((vals[td.dataset.cpeq] || {}).equity);
  const l = c.last;
  els.cplast.textContent = l ? `Last copy: ${l.action} from ${l.src}, ${l.ok}/${l.n} copies${l.ms != null ? ` in ${l.ms} ms` : ''}, ${F.ago(l.at)}` : c.armed ? 'No copies yet' : 'After a reload the copier starts switched off.';
}

// docked (full-height column on the right, Vest's page narrowed) or floating. Docked and minimised: only the header at the top,
// the column stays (with the cards in it when they are set to live there).
const DOCK_MIN = 320,
  DOCK_MAX = 900;
let layoutT = 0;
function layout(now) {
  clearTimeout(layoutT);
  if (!now) {
    layoutT = setTimeout(() => layout(true), 500);
    return;
  }
  const w = Math.min(DOCK_MAX, Math.max(DOCK_MIN, Math.round(parseFloat(ui.dockW)) || 420));
  const on = !!ui.dock;
  panel.classList.toggle('console', ui.pstyle === 'console');
  panel.classList.toggle('dock', on);
  panel.style.setProperty('--dw', w + 'px');
  const col = on && ui.cardsAt !== 'chart';
  panel.classList.toggle('withcards', col); // folded panel: the cards under it; open: full height, cards hidden
  const bg = root.querySelector('[data-dockbg]');
  bg.style.display = on ? 'block' : 'none';
  bg.style.width = w + 'px';
  const db = root.querySelector('[data-dockbtn]');
  if (db) db.classList.toggle('on', on);
  if (on || ui.x == null) {
    panel.style.left = '';
    panel.style.top = '';
    panel.style.right = '';
  } else place(ui.x, ui.y);
  dock.apply(on ? w : 0);
}

function place(x, y) {
  const maxX = window.innerWidth - 80,
    maxY = window.innerHeight - 40;
  panel.style.left = Math.max(0, Math.min(x, maxX)) + 'px';
  panel.style.top = Math.max(0, Math.min(y, maxY)) + 'px';
  panel.style.right = 'auto';
}

function drag(handle) {
  let start = null;
  handle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button') || panel.classList.contains('dock')) return;
    const r = panel.getBoundingClientRect();
    start = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!start) return;
    ui.x = e.clientX - start.dx;
    ui.y = e.clientY - start.dy;
    place(ui.x, ui.y);
  });
  handle.addEventListener('pointerup', () => {
    if (start) saveUi();
    start = null;
  });
}

// ── rendering
function dots() {
  const lvl = (k) => (S.checks.find((c) => c.key === k) || {}).level || '';
  const sess = handlers.sessionState();
  const worst = S.checks.some((c) => c.level === 'fail') ? 'fail' : S.checks.some((c) => c.level === 'warn' || c.level === 'wait') ? 'warn' : S.checks.length ? 'pass' : '';
  return [
    ['Session', sess === 'ok' ? 'pass' : sess === 'expired' ? 'fail' : 'warn'],
    ['Feed', store.feedLive() ? 'pass' : S.feed.attached ? 'warn' : 'fail'],
    ['Chart', lvl('chart')],
    ['Checks', worst],
  ]
    .map(([n, l]) => `<span class="dot ${l}">${n}</span>`)
    .join('');
}

// dot next to the account name: green free, red positions/orders, yellow empty placeholder, grey not read yet
const adot = (id) => {
  const a = store.activityOf(id);
  return `<i class="adot ${a.lvl}" title="${F.esc(a.tip)}"></i>`;
};

function render() {
  if (!root) return;
  // sorted by name (A, B, C... or 1, 2, 10 as numbers), then by opening order
  const ids = Object.keys(S.accounts).sort((a, b) => String(S.accounts[a].label).localeCompare(String(S.accounts[b].label), 'en', { numeric: true }) || S.accounts[a].order - S.accounts[b].order);
  const vals = Object.fromEntries(ids.map((id) => [id, store.values(id)]));
  els.dots.innerHTML = dots();
  const on = handlers.ordersOn && handlers.ordersOn();
  els.ord.textContent = on ? 'Orders: ON' : 'Orders: OFF';
  els.ord.classList.toggle('on', !!on);
  const ts = handlers.trailStatus ? handlers.trailStatus() : null;
  // warnings for empty fields (BE+ on with an empty profit made the button do a plain BE)
  const warn = [];
  if (ui.beOn && !(+ui.beOff > 0)) warn.push(`BE+ is on but "profit" is empty: the BE button puts the stop at the entry`);
  if (ui.beAuto && !(+ui.beAt > 0)) warn.push(`Auto BE is on but the "after" threshold is empty: it never triggers`);
  if (ui.trOn && !(+ui.trDist > 0)) warn.push('Trailing is on but "pullback" is empty: it does nothing');
  els.trst.textContent = [...warn, ts ? 'Trailing / BE: ' + ts : ''].filter(Boolean).join(' · ');
  els.trst.classList.toggle('warn', warn.length > 0);
  if (panel) panel.classList.toggle('stopscol', stopsInColumn()); // the section is in the column: not shown twice

  // totals of all accounts
  const sum = (k) => {
    let s = 0;
    for (const id of ids) {
      const v = vals[id] && vals[id][k];
      if (!Number.isFinite(v)) return NaN; // one account without data makes the total unknown: never pass off a partial total as complete
      s += v;
    }
    return ids.length ? s : NaN;
  };
  const T = { balance: sum('balance'), equity: sum('equity'), upnl: sum('upnl'), dayPnl: sum('dayPnl'), sessionPnl: sum('sessionPnl'), totalPnl: sum('totalPnl') };
  els.totals.innerHTML = [
    ['Total equity', F.usd(T.equity), ''],
    ['Total balance', F.usd(T.balance), ''],
    ['Open P&L', F.usd(T.upnl, true), F.cls(T.upnl)],
    ['Vest day P&L', F.usd(T.dayPnl, true), F.cls(T.dayPnl)],
    ['Session P&L', F.usd(T.sessionPnl, true), F.cls(T.sessionPnl)],
    ['Total P&L', F.usd(T.totalPnl, true), F.cls(T.totalPnl)],
  ]
    .map(([n, v, c]) => `<div><span>${n}</span><b class="${c}">${v}</b></div>`)
    .join('');

  // P&L: today in large type, open and total for all accounts; each account on two lines
  els.plbig.textContent = F.usd(T.dayPnl, true);
  els.plbig.className = 'plbig ' + F.cls(T.dayPnl);
  els.plsub.innerHTML = `Today on ${ids.length} account${ids.length === 1 ? '' : 's'} · open <b class="${F.cls(T.upnl)}">${F.usd(T.upnl, true)}</b> · total <b class="${F.cls(T.totalPnl)}">${F.usd(T.totalPnl, true)}</b>`;
  els.flatall.disabled = !!S.flattening || !ids.length;
  els.flatall.textContent = S.flattening ? 'FLATTENING…' : 'FLATTEN ALL';
  els.placc.innerHTML = ids
    .map((id) => {
      const a = S.accounts[id],
        v = vals[id];
      return `<div class="pla" data-id="${F.esc(id)}">
        <div class="plr"><b>${adot(id)}${F.esc(a.label)}</b><b class="${F.cls(v.dayPnl)}" title="Today's P&L (since 20:00 New York time)">${F.usd(v.dayPnl, true)}</b></div>
        <div class="plr muted"><span>${F.esc(a.type)}</span><span><span title="Equity">${F.usd(v.equity)}</span> · open <span class="${F.cls(v.upnl)}">${F.usd(v.upnl, true)}</span> · tot <span class="${F.cls(v.totalPnl)}">${F.usd(v.totalPnl, true)}</span></span></div>
      </div>`;
    })
    .join('');

  renderCopy(ids, vals);
  renderTrade();

  // accounts table
  const rows = ids
    .map((id) => {
      const a = S.accounts[id],
        v = vals[id],
        st = S.state[id];
      const pos = st && st.positions.length ? st.positions.map((p) => `${p.side === 'long' ? 'L' : 'S'} ${F.qty(p.qty)} ${(S.symbols[p.symbol] || {}).label || p.symbol}`).join(', ') : '<span class="muted">flat</span>';
      const src = v.source === 'series' ? ' <span class="muted" title="equity from the Vest performance series, about 1 minute late">*</span>' : '';
      return `<tr data-id="${F.esc(id)}" class="${id === S.selected ? 'sel' : ''}">
        <td>${adot(id)}${F.esc(a.label)} <span class="muted">${F.esc(a.type)}</span></td>
        <td>${F.usd(v.balance)}</td><td>${F.usd(v.equity)}${src}</td>
        <td class="${F.cls(v.upnl)}">${F.usd(v.upnl, true)}</td>
        <td class="${F.cls(v.dayPnl)}" title="${Number.isFinite(v.dayPnl) ? 'equity minus equity at 20:00 New York time (start of the Vest day)' : 'start of the Vest day not read yet for this account'}">${F.usd(v.dayPnl, true)}</td>
        <td class="${F.cls(v.sessionPnl)}">${F.usd(v.sessionPnl, true)}</td>
        <td class="${F.cls(v.totalPnl)}">${F.usd(v.totalPnl, true)}</td>
        <td>${F.usd(v.toFloor)}</td><td>${pos}</td></tr>`;
    })
    .join('');
  els.accounts.innerHTML = `<thead><tr><th>Account</th><th>Balance</th><th>Equity</th><th>Open</th><th title="equity minus equity at 20:00 New York time (start of the Vest day)">Today</th><th title="equity minus the first equity this panel read today">Session</th><th>Total</th><th title="$ of equity left before the drawdown limit (total or daily, whichever is closer)">Room to DD limit</th><th>Position</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="9" class="muted">Waiting for the Vest session…</td></tr>'}</tbody>`;

  renderPositions();
  renderCalc();
  els.checks.innerHTML = S.checks.map((c) => `<tr><td>${F.esc(c.name)}</td><td class="lvl ${c.level}">${c.level}</td><td>${F.esc(c.msg)}</td></tr>`).join('') || '<tr><td class="muted">Not run yet</td></tr>';
  els.sync.textContent = S.syncError ? 'Last read failed: ' + S.syncError : `Full read ${F.ago(S.lastSync)} · feed ${store.feedLive() ? 'live' : 'down'}`;
}

let lastPend = [];
const heat = (f) => (f >= 1 ? 'hot' : f >= 0.8 ? 'warn' : '');
function renderTrade() {
  const t = handlers.tradeInfo && handlers.tradeInfo();
  if (!t) {
    els.trtitle.textContent = 'Trade';
    els.trsym.textContent = '—';
    els.trlev.textContent = els.trpx.textContent = els.mtxt.textContent = els.rtxt.textContent = '';
    els.pend.innerHTML = '<span class="muted">no account</span>';
    return;
  }
  els.trtitle.textContent = 'Trade · ' + t.account;
  els.trsym.textContent = t.label;
  els.trlev.textContent = t.lev > 0 ? t.lev + 'x' : '';
  els.trpx.textContent = F.priceG(t.mark, t.priceDec);
  // margin
  const mf = Number.isFinite(t.marginPct) ? t.marginPct : 0;
  els.mfill.style.width = Math.min(100, mf * 100).toFixed(1) + '%';
  els.mfill.className = heat(mf);
  els.mtxt.innerHTML = Number.isFinite(t.marginPct) ? `<b>${Math.round(mf * 100)}%</b> · ${t.maxQty > 0 ? F.qty(t.maxQty) + ' ' + F.esc(t.label) + ' can still be opened' : 'no free margin'}` : '—';
  // size of the open trade and of the pending orders on the chart's market
  const lbl = F.esc(t.label);
  els.trsize.innerHTML = `Trade: ${t.pos ? `<b class="${t.pos.side === 'long' ? 'up' : 'down'}">${t.pos.side === 'long' ? 'LONG' : 'SHORT'} ${F.qty(t.pos.qty)} ${lbl}</b>` : '<span class="muted">flat</span>'} · Pending: ${t.pendCount ? `<b>${F.qty(+t.pendQty.toFixed(8))} ${lbl}</b> <span class="muted">(${t.pendCount} order${t.pendCount === 1 ? '' : 's'})</span>` : '<span class="muted">none</span>'}`;
  // RISK: drawdown used by the open trade (its open loss) and drawdown left before the limit
  const used = t.pos && Number.isFinite(t.pos.upnl) ? Math.max(0, -t.pos.upnl) : 0;
  const left = t.room;
  const rf = left > 0 || used > 0 ? used / (used + Math.max(0, left)) : 0;
  els.rfill.style.width = Math.min(100, rf * 100).toFixed(1) + '%';
  els.rfill.className = heat(rf);
  els.rtxt.innerHTML = Number.isFinite(left)
    ? `used <b class="${used > 0 ? 'hot' : ''}">${F.usd(used)}</b> · left <b class="${heat(rf)}">${F.usd(left)}</b>`
    : '—';
  // pending orders (all the account's markets) and local stops
  lastPend = t.pendings;
  // rewritten only when it changes: the panel redraws at every price and a replaced button loses the click
  const pendHtml = t.pendings.length
    ? t.pendings
        .map(
          (o) => `<div class="pr"><span class="pk">${F.esc(o.kind)}</span><span class="${o.side === 'long' ? 'up' : 'down'}">${o.side === 'long' ? 'BUY' : o.side === 'short' ? 'SELL' : ''}</span><span>${F.qty(o.qty)} ${F.esc(t.labels[o.symbol] || o.symbol || '')}</span><span class="muted">@ ${F.priceG(o.price, t.priceDec)}</span><button class="btn sm" data-cancel="${F.esc(o.id)}">cancel</button></div>`,
        )
        .join('')
    : '<span class="muted">none</span>';
  if (els.pend.dataset.html !== pendHtml) {
    els.pend.innerHTML = pendHtml;
    els.pend.dataset.html = pendHtml;
  }
}

function renderPositions() {
  const id = S.selected,
    a = S.accounts[id],
    st = S.state[id];
  els.posTitle.textContent = a ? `Positions · ${a.label}` : 'Positions';
  if (!st || !st.positions.length) {
    els.positions.innerHTML = '<span class="muted">No open position</span>';
    return;
  }
  const rows = st.positions
    .map((p) => {
      const m = S.symbols[p.symbol] || { priceDec: 2, label: p.symbol };
      const mk = S.marks[p.symbol];
      const pnl = mk ? (p.side === 'long' ? 1 : -1) * p.qty * (mk.px - p.openPrice) : NaN;
      const stale = mk && Date.now() - mk.at > 5000 ? ' <span class="muted" title="stale price">!</span>' : '';
      const legs = p.triggers
        .slice()
        .sort((x, y) => x.price - y.price)
        .map((t) => `${t.kind.toUpperCase()} ${F.price(t.price, m.priceDec)} <span class="${F.cls(calc.triggerUsd(p, t))}">${F.usd(calc.triggerUsd(p, t), true)}</span>`)
        .join(' · ');
      const risk = p.triggers.filter((t) => t.kind === 'sl').reduce((s, t) => s + Math.min(0, calc.triggerUsd(p, t)), 0);
      return `<tr><td>${F.esc(m.label)}</td><td class="${p.side === 'long' ? 'up' : 'down'}">${p.side.toUpperCase()}</td><td>${F.qty(p.qty)}</td>
        <td>${F.price(p.openPrice, m.priceDec)}</td><td>${mk ? F.price(mk.px, m.priceDec) : '—'}${stale}</td>
        <td class="${F.cls(pnl)}">${F.usd(pnl, true)}</td><td>${p.triggers.some((t) => t.kind === 'sl') ? F.usd(risk, true) : '<span class="down">no SL</span>'}</td></tr>
        <tr><td colspan="7" class="muted" style="text-align:left">${legs || 'no stop or target'}</td></tr>`;
    })
    .join('');
  els.positions.innerHTML = `<table><thead><tr><th>Market</th><th>Side</th><th>Qty</th><th>Entry</th><th>Mark</th><th>P&L $</th><th>Risk at SL</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderCalc() {
  els.manual.style.display = ui.mode === 'man' ? '' : 'none';
  const r = handlers.calcResult();
  if (!r) return (els.calc.innerHTML = '');
  if (!r.ok) return (els.calc.innerHTML = `<span class="muted">${F.esc(r.err)}</span>`);
  const p = (x) => F.price(x, r.priceDec);
  const parts = [
    `${r.side.toUpperCase()} ${F.qty(r.qty)} ${F.esc(r.label)} @ ${p(r.entry)} <span class="muted">(${r.source}; 1 tick = ${F.usdFine(r.tickUsd)})</span>`,
    r.sl ? `SL <b>${p(r.sl.price)}</b> → <span class="down">${F.usd(r.sl.usd, true)}</span>` : '',
    r.tp ? `TP <b>${p(r.tp.price)}</b> → <span class="up">${F.usd(r.tp.usd, true)}</span>` : '',
    Number.isFinite(r.rr) ? `R:R 1 : ${r.rr.toFixed(2)}` : '',
    ...r.errs.map((e) => `<span class="down">${F.esc(e)}</span>`),
  ].filter(Boolean);
  els.calc.innerHTML = parts.join('<br>') + '<div class="note">Fees and slippage excluded: with a market stop the real loss can exceed the amount.</div>';
}

function renderLog() {
  if (!els.log) return;
  els.log.innerHTML = log
    .entries()
    .slice(-60)
    .reverse()
    .map((e) => `<div class="${e.level}">${new Date(e.t).toLocaleTimeString('en-GB')} ${F.esc(e.msg)}</div>`)
    .join('');
}

/** Changes a value from the chart cards (e.g. the size %) and saves it. */
/** Result of the last command (docked column): in the header, so nothing below moves when it appears. */
let sayTimer = null;
function say(text, kind) {
  if (!els.say) return;
  els.say.textContent = text || '';
  els.say.title = text || '';
  els.say.className = 'say ' + (kind || '');
  clearTimeout(sayTimer);
  sayTimer = setTimeout(() => {
    els.say.textContent = '';
    els.say.title = '';
  }, kind === 'err' ? 9000 : 4000);
}

/** Position data of the chart card, shown in the header (docked column). null = hidden. Rewritten only when they change. */
let headKey = '';
function headPos(d) {
  if (!els.hinfo || !els.hpos) return;
  const key = d ? JSON.stringify(d) : '';
  if (key === headKey) return;
  headKey = key;
  els.hpos.style.display = d ? '' : 'none';
  if (!d) {
    els.hinfo.innerHTML = '';
    els.hpos.innerHTML = '';
    return;
  }
  const e = F.esc;
  // row 2, left of the status dots: timeframe + candle countdown, clock, account
  els.hinfo.innerHTML =
    `<b>${e(d.tf)}</b>` + (d.cd ? `<i class="cd">${e(d.cd)}</i>` : '') + `<i>${e(d.clk)}</i>` + (d.acc ? `<span class="acc">${e(d.acc)}</span>` : '');
  // the position on two rows:
  //   1) side, size, entry price ............ open P&L in $
  //   2) points from the entry, contracts and $ per point ............ points of the day
  // flat: one row, FLAT ............ points of the day
  const flat = d.side === 'flat';
  const day = d.dpt ? `<span class="day"><i>today</i> <b class="${e(d.dptC)}">${e(d.dpt)}</b></span>` : '';
  els.hpos.className = 'hpos ' + d.side;
  els.hpos.innerHTML = flat
    ? `<div class="r1"><span class="sd">FLAT</span>${day}</div>`
    : `<div class="r1"><span class="sd">${d.side.toUpperCase()}</span><span class="q">${e(d.qty)}</span>` +
      (d.entry ? `<span class="en"><i>entry</i> ${e(d.entry)}</span>` : '') +
      (d.pnl ? `<span class="pl ${e(d.pnlC)}">${e(d.pnl)}</span>` : '') +
      `</div><div class="r2">` +
      (d.gap ? `<span class="gp ${e(d.gapC)}">${e(d.gap)}</span>` : '') +
      (d.mic ? `<span class="mic">${e(d.mic)}</span>` : '') +
      day +
      `</div>`;
}

/** A setting changed from the column (Trailing & breakeven): same effect as typing it in the panel. */
function setUiInput(k, v) {
  ui[k] = v;
  saveUi();
  const inp = root && root.querySelector('[data-in="' + k + '"]');
  if (inp) {
    if (inp.type === 'checkbox') inp.checked = !!v;
    else inp.value = v;
  }
  handlers.onInput && handlers.onInput();
  render();
}

/** Trailing / BE status line of the panel (warnings for empty fields + what is running). */
const trailNote = () => (els.trst ? { text: els.trst.textContent, warn: els.trst.classList.contains('warn') } : { text: '', warn: false });

/** True when the Trailing & breakeven settings live in the docked column instead of the panel. */
const stopsInColumn = () => !!(ui.dock && ui.cardsAt !== 'chart' && ui.overlay && dock.width());

function setUi(k, v) {
  ui[k] = v;
  saveUi();
  const inp = root && root.querySelector('[data-in="' + k + '"]');
  if (inp && inp.type !== 'checkbox') inp.value = v;
}

/** Line style per kind: { kind: { c, s, w } }; invalid values -> default. */
/** Colours of the Trade commands buttons and of the mode words, as CSS variables for the overlay. */
function btnColors() {
  const ok = (k) => (/^#[0-9a-f]{6}$/i.test(ui[k]) ? ui[k] : COL_DEFAULTS[k]);
  const out = {};
  for (const [k] of BTN_COLS) {
    out[`--b-${k}-bg`] = ok(`bc_${k}_bg`);
    out[`--b-${k}-tx`] = ok(`bc_${k}_tx`);
    const fs = Math.round(+ui[`bc_${k}_fs`]);
    out[`--b-${k}-fs`] = fs >= 8 && fs <= 24 ? fs + 'px' : ''; // '' = default (the property is removed)
  }
  for (const [k] of MODE_COLS) {
    out[`--m-${k}`] = ok('mc_' + k);
    // size next to Trade commands / on the chart labels, weight of both ('' = default: the property is removed)
    const fs = Math.round(+ui[`mc_${k}_fs`]),
      lfs = Math.round(+ui[`mc_${k}_lfs`]),
      fw = ui[`mc_${k}_fw`];
    out[`--m-${k}-fs`] = fs >= 8 && fs <= 24 ? fs + 'px' : '';
    out[`--m-${k}-lfs`] = lfs >= 8 && lfs <= 20 ? lfs + 'px' : '';
    out[`--m-${k}-fw`] = fw === 'b' ? '800' : fw === 'n' ? '400' : '';
  }
  return out;
}

function lineStyles() {
  const out = {};
  for (const [k, , c] of LINE_KINDS) {
    const col = /^#[0-9a-f]{6}$/i.test(ui['lc_' + k]) ? ui['lc_' + k] : c;
    const st = ['dashed', 'dotted', 'solid'].includes(ui['ls_' + k]) ? ui['ls_' + k] : 'dashed';
    const w = Math.min(4, Math.max(1, Math.round(+ui['lw_' + k]) || 1));
    out[k] = { c: col, s: st, w };
  }
  for (const [k, , c, s0] of SEG_KINDS) {
    const col = /^#[0-9a-f]{6}$/i.test(ui['lc_' + k]) ? ui['lc_' + k] : c;
    const st = ['dashed', 'dotted', 'solid'].includes(ui['ls_' + k]) ? ui['ls_' + k] : s0;
    const w = Math.min(6, Math.max(1, Math.round(+ui['lw_' + k]) || 3));
    const l = Math.round(+ui['ll_' + k]);
    out[k] = { c: col, s: st, w, l: l >= 4 && l <= 400 ? l : 0 }; // l = 0: automatic length
  }
  for (const [k, , c, s0] of HL_KINDS) {
    const col = /^#[0-9a-f]{6}$/i.test(ui['lc_' + k]) ? ui['lc_' + k] : c;
    const st = ['dashed', 'dotted', 'solid'].includes(ui['ls_' + k]) ? ui['ls_' + k] : s0;
    out[k] = { c: col, s: st, w: Math.min(4, Math.max(1, Math.round(+ui['lw_' + k]) || 2)) };
  }
  return out;
}

/** Style of the quantities on the chart: { c, s (px), b (bold) }. */
function qtyStyle() {
  return { c: /^#[0-9a-f]{6}$/i.test(ui.qc) ? ui.qc : '#ffb402', s: Math.min(16, Math.max(9, Math.round(+ui.qsz) || 11)), b: ui.qb !== false };
}

/** Where the chart cards go when they live in the docked column: the free part of the column under the folded panel
 *  (hidden: true while the panel is open and fills the column), or null = on the chart. */
function cardsColumn() {
  if (!panel || !ui.dock || ui.cardsAt === 'chart' || !ui.overlay) return null;
  const w = dock.width();
  if (!w) return null;
  const top = Math.ceil(panel.getBoundingClientRect().bottom);
  return { left: window.innerWidth - w, width: w, top, height: Math.max(0, window.innerHeight - top), hidden: !ui.min };
}

module.exports = {
  qtyStyle,
  cardsColumn,
  setUiInput,
  say,
  headPos,
  trailNote,
  lineStyles, btnColors, mount, render, ui: () => ui, setUi };
