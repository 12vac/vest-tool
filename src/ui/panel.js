// Panel in a closed Shadow DOM. Minimal look. Orders are sent only from the chart overlay, with the Orders switch on.
const css = require('./panel.css');
const F = require('./format');
const calc = require('./calc');
const { HELP } = require('./help');
const store = require('../core/store');
const log = require('../diag/log');
const dock = require('./dock');
const CS = require('./chartstyle');

const UI_KEY = 'vt1:ui';
const LINE_DEFAULTS = CS.defaults(); // lines and labels on the chart: src/ui/chartstyle.js
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
let ui = { ...LINE_DEFAULTS, ...COL_DEFAULTS, qc: '#ffb402', qsz: '11', qb: true, trOn: false, trUnit: 'pt', trAct: '', trDist: '', trStep: '', beOn: false, beUnit: 'pt', beOff: '', beAuto: false, beAt: '', brOn: false, brSl: '', brTp: '', brDca: false, gdOn: false, gdEnOn: false, gdTpOn: true, gdSlOn: true, gdEnAvg: true, gdTpAvg: true, gdSlAvg: true, gdEnOv: '', gdEnFixPx: '', gdTpOv: '', gdSlOv: '', gdEnMan: '', gdTpMan: '', gdSlMan: '', gdEnSide: 'long', gdEnNear: '', gdEnFar: '', gdEnMid: '2', gdEnPct: '', gdEnDist: 'equal', gdEnSize: 'equal', gdEnCustom: '', gdTpNear: '', gdTpFar: '', gdTpMid: '1', gdTpPct: '100', gdTpDist: 'equal', gdTpSize: 'equal', gdTpCustom: '', gdSlNear: '', gdSlFar: '', gdSlMid: '0', gdSlDist: 'equal', gdSlSize: 'equal', gdSlCustom: '', ocoOn: false, srMode: 'off', srAct: '10', srLock: '1', srTight: '0.3', srRunPct: '33', srRunAtr: '3', srPausePct: '0', srGate: true, srClimax: false, x: null, y: null, min: false, lines: true, overlay: true, dd50: true, dd25On: true, dd75On: true, ddP1: 25, ddP2: 50, ddP3: 75, hideVest: true, blockPct: 125, chipPct: 100, roomPx: 360, cdOn: true, theme: 'console', dock: true, dockW: 420, pstyle: 'console', cardsAt: 'column', hlOn: true, hlK: 2, atrOn: true, atrH: 14, atrR: 3, pp0: 1, pp1: 2, pp2: 4, pp3: 8, pp4: 5, pp5: 16, dailyGoal: '', closePct: 100, sizePct: 1, capPct: 10, mode: 'pos', slUsd: '', tpUsd: '', side: 'long', qty: '', entry: '', symbol: calc.DEFAULT_SYMBOL };

try {
  Object.assign(ui, JSON.parse(localStorage.getItem(UI_KEY) || '{}'));
  ui.gdOn = false; // the grid starts OFF at every reload (never PLAN / ACTIVE by itself)
} catch {
  /* default settings */
}
// v0.10.95: STOP and FLAT colours still at the old defaults -> the new defaults (colours chosen by hand are kept)
if (ui.bc_st_bg === '#eab308' && ui.bc_st_tx === '#1a1405') Object.assign(ui, { bc_st_bg: '#74746b', bc_st_tx: '#ffffff' });
if (ui.bc_flat_bg === '#d4a514' && ui.bc_flat_tx === '#17181b') Object.assign(ui, { bc_flat_bg: '#ec9900', bc_flat_tx: '#ffffff' });
// trailing and auto BE send orders on their own: off after every reload, like Orders (never re-armed automatically)
ui.trOn = false;
ui.beAuto = false;
// safe runner: LIVE sends orders on its own: after a reload it comes back as VIEW (lines only), never live
if (ui.srMode === 'live') ui.srMode = 'view';
const saveUi = () => {
  try {
    localStorage.setItem(UI_KEY, JSON.stringify(ui));
  } catch {
    /* nothing */
  }
};

// ── layout: foldable sections, each with a "?" that opens its explanation (texts in help.js)
// sections open by default; the others start folded. ui.fold remembers what the user opened or closed.
const OPEN_DEFAULT = { overview: true, copier: true };
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
    <span class="title">VestTool</span><span class="hdord" style="display:none"><button class="btn ord" data-act="orders" data-ord>Orders: OFF</button>${info('orders')}</span><span class="muted" data-ver></span><span class="say" data-say></span><span class="hwait" data-hwait style="display:none"></span><span class="htg"><span class="htl">ORDERS</span><button class="htb" data-act="orders" data-hord title="ORDERS ON: the tool's buttons send real orders to the account active on Vest">OFF</button><span class="htl" data-hcpl>COPY</span><button class="htb" data-act="copy" data-hcpy title="COPY ON: every order of the master is copied to the copy accounts">OFF</button></span><span class="hbr"></span>
    <span class="hinfo" data-hinfo></span>
    <div class="dots" data-dots></div>
    <button class="btn" data-act="min" title="Minimise (Alt+Shift+V)">–</button>
    <div class="hpos" data-hpos style="display:none"></div>
    <div class="smw" data-smw style="display:none"><span class="smt" data-smt></span><button class="btn smgo" data-smgo style="display:none"></button><button class="btn smx" data-smx aria-label="Hide">✕</button>${info('selfmatch')}</div>
    <div class="smc" data-smc style="display:none"></div>
  </div>
  <div class="body">
    <div class="group">Accounts</div>
    ${sec('overview', 'Accounts overview', `
      <div class="ovh"><span class="muted" data-ovsub></span>
        <span class="opt"><button class="btn flatall" data-act="flatall" data-flatall>FLATTEN ALL</button>${info('flatall')}</span></div>
      <table class="acct" data-accounts></table>
      <div class="selinfo" data-selinfo></div>
      <h4 style="margin-top:8px">Open positions</h4><div data-positions></div>
      <h4 style="margin-top:8px">Pending orders</h4><div class="pend" data-pend></div>`)}
    <div class="group">Copier</div>
    ${sec('copier', 'Copier accounts', `
      <div class="copy">
        <div class="cprow"><span class="muted">Sizing</span><button class="btn seg" data-cmode="1:1">1:1</button><button class="btn seg" data-cmode="cap">Cap-to-fit</button><button class="btn seg" data-cmode="dd">DD left</button>
          <span class="cpst" data-cpst></span><button class="btn cpgo" data-act="copy" data-cpgo>START</button></div>
        <label class="cpdry"><input type="checkbox" data-cpdry> Test mode: copies are only written in the log, nothing is sent to the copy accounts</label>
        <table class="cpacc" data-cpacc></table>
        <div class="note" data-cplast></div>
      </div>`)}
    <div class="group">Settings of the column sections</div>
    ${sec('size', 'Trade commands settings', `
      <div class="row">
        ${opt('capPct', `size cap ${num('capPct', 38)}%`)}
        ${opt('presets', `presets ${['pp0', 'pp1', 'pp2', 'pp3', 'pp4', 'pp5'].map((k) => num(k, 30)).join('')}%`)}
      </div>`)}
    ${sec('manlim', 'Account limits settings', `
      <div class="row">
        ${opt('manDay', `${chk('mdOn', 'manual daily drawdown limit $')}${num('mdUsd', 56)}`)}
      </div>
      <div class="row">
        ${opt('manTgt', `${chk('mtOn', 'manual account profit target $')}${num('mtUsd', 56)}`)}
      </div>
      <div class="row">
        ${opt('dd50', `drawdown labels ${chk('dd25On', '')}${num('ddP1', 30)}% ${chk('dd50', '')}${num('ddP2', 30)}% ${chk('dd75On', '')}${num('ddP3', 30)}%`)}
      </div>`)}
    <div class="group">Layout</div>
    ${sec('layout', 'Panel and column', `
      <div class="row">
        ${opt('dock', `column width ${num('dockW', 40)} px`)}
        ${opt('pstyle', `panel style <select data-in="pstyle" style="width:88px"><option value="console">Console</option><option value="classic">Classic</option></select>`)}
      </div>`)}
    ${sec('display', 'Chart display', `
      <div class="row">
        ${opt('overlay', chk('overlay', 'trade overlay (column sections)'))}
        ${opt('lines', chk('lines', 'lines on the chart'))}
        ${opt('hideVest', chk('hideVest', 'hide Vest lines'))}
        ${opt('countdown', chk('cdOn', 'candle countdown'))}
      </div>
      <div class="row">
        ${opt('theme', `column style <select data-in="theme" style="width:88px"><option value="console">Console</option><option value="classic">Classic</option><option value="sonar">Sonar</option></select>`)}
        ${opt('chipPct', `label scale ${num('chipPct', 40)}%`)}
      </div>
      <div class="row">
      </div>
      <div class="row">
        ${opt('roomPx', `space between the last candle and the price axis ${num('roomPx', 44)} px`)}
      </div>
      <div class="row">
        ${opt('hilo', `${chk('hlOn', 'swing range: last swing high / low lines, swing =')} ${num('hlK', 30)} candles each side`)}
      </div>
      <div class="note" data-swst></div>`)}
    ${sec('colours', 'Chart lines and labels', `
      <div class="csed">
        <label class="csel">Element <select data-csel>${[...new Set(CS.ELEMENTS.map((e) => e[2]))].map((g) => `<optgroup label="${g}">${CS.ELEMENTS.filter((e) => e[2] === g).map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</optgroup>`).join('')}</select></label>
        <div class="csprev" data-csprev><div class="csline"></div><div class="cschip"><span class="k">NAME</span><b>25,000.00</b><span class="qy">0.5</span><span class="up">+$12.50</span></div></div>
        <div class="csh4">Line</div>
        <div class="csrow">
          <label>colour <input type="color" data-cs="lc"></label>
          <label>style <select data-cs="ls">${CS.DASHES.map((d) => `<option value="${d}">${d === 'dashdot' ? 'dash-dot' : d}</option>`).join('')}</select></label>
          <label>width <select data-cs="lw">${[1, 2, 3, 4, 5, 6].map((w) => `<option value="${w}">${w} px</option>`).join('')}</select></label>
          <label data-csseg>length <input data-cs="ll" inputmode="decimal" placeholder="auto" style="width:52px"> px</label>
        </div>
        <div data-cslab>
          <div class="csh4">Label</div>
          <div class="csrow">
            <label>background <input type="color" data-cs="cbg"></label>
            <label>border <input type="color" data-cs="cbo"></label>
            <label>border width <select data-cs="cbw"><option value="">default</option>${[0, 1, 2, 3, 4].map((w) => `<option value="${w}">${w} px</option>`).join('')}</select></label>
          </div>
          <div class="csrow">
            <label>name colour <input type="color" data-cs="cn"></label>
            <label><input type="checkbox" data-cs="cnbOn"> name filled <input type="color" data-cs="cnb"></label>
          </div>
          <div class="csrow">
            <label>text size <select data-cs="cfs"><option value="">default</option>${[9, 10, 11, 12, 13, 14, 15, 16, 18, 20].map((v) => `<option value="${v}">${v} px</option>`).join('')}</select></label>
            <label>weight <select data-cs="cfw"><option value="">default</option><option value="b">bold</option><option value="n">normal</option></select></label>
          </div>
        </div>
        <div class="csrow"><button class="btn" data-act="csreset">Default for this element</button><button class="btn" data-act="csresetall">All lines and labels to default</button></div>
        <div class="csh4">All labels</div>
        <div class="csrow">
          <label>price <input type="color" data-cc="cpx"></label>
          <label>profit <input type="color" data-cc="cup"></label>
          <label>loss <input type="color" data-cc="cdn"></label>
        </div>
        <div class="csrow">
          ${opt('qty', `quantities <input type="color" data-in="qc"> size <select data-in="qsz" style="width:72px">${[9, 10, 11, 12, 13, 14, 15, 16].map((v) => `<option value="${v}">${v} px</option>`).join('')}</select> ${chk('qb', 'bold')}`)}
        </div>
      </div>`)}
    ${sec('btncol', 'Button and mode colours', `
      <table class="lstyle">
        <tr><td></td><td class="muted">background</td><td class="muted">text</td><td class="muted">size</td></tr>
        ${BTN_COLS.map(([k, name]) => `<tr><td>${name}</td><td><input type="color" data-in="bc_${k}_bg"></td><td><input type="color" data-in="bc_${k}_tx"></td><td><select data-in="bc_${k}_fs"><option value="">default</option>${[10, 11, 12, 13, 14, 15, 16, 17, 18].map((v) => `<option value="${v}">${v} px</option>`).join('')}</select></td></tr>`).join('')}
        <tr><td colspan="5"><h4 style="margin-top:6px">Mode words (next to Trade commands and on the chart labels)</h4></td></tr>
        <tr><td></td><td class="muted">colour</td><td class="muted">size next to Trade commands</td><td class="muted">size on the labels</td><td class="muted">weight</td></tr>
        ${MODE_COLS.map(([k, name]) => `<tr><td>${name}</td><td><input type="color" data-in="mc_${k}"></td><td>${modeSize(`mc_${k}_fs`, [9, 10, 11, 12, 13, 14, 15, 16, 18, 20])}</td><td>${k === 'manual' ? '' : modeSize(`mc_${k}_lfs`, [8, 9, 10, 11, 12, 13, 14, 15, 16])}</td><td><select data-in="mc_${k}_fw"><option value="">default</option><option value="b">bold</option><option value="n">normal</option></select></td></tr>`).join('')}
      </table>
      <div class="row"><button class="btn" data-act="colreset">Default colours</button></div>`)}
    <div class="group">Other</div>
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
  for (const k of ['pend', 'dots', 'ovsub', 'selinfo', 'flatall', 'accounts', 'positions', 'calc', 'checks', 'log', 'sync', 'manual', 'ver', 'ord', 'cpst', 'cpgo', 'cpacc', 'cplast', 'trst', 'srst', 'say', 'hinfo', 'hpos', 'hord', 'hcpy', 'hcpl', 'hwait', 'smw', 'smt', 'smgo', 'smx', 'smc']) els[k] = root.querySelector(`[data-${k}]`);
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
      if (k === 'srMode' && inp.value === 'live' && ui.srMode !== 'live') {
        const ok = window.confirm(`Safe runner LIVE (experimental)?

Once the profit reaches "start after", it moves the stop on Vest and closes parts of the position at market by itself (with Orders ON, while this tab is open).
After a reload it comes back as VIEW.`);
        if (!ok) {
          inp.value = ui.srMode;
          return;
        }
      }
      ui[k] = inp.type === 'checkbox' ? inp.checked : inp.value.trim().replace(',', '.');
      exclusive(k, ui[k]);
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
      const it = lastPend.find((x) => x.key === cx.dataset.cancel);
      if (it) {
        cx.disabled = true;
        handlers.cancelPending(it).catch((err) => log.error('Cancel failed: ' + err.message));
      }
      return;
    }
    if (e.target.closest('[data-smgo]')) return handlers.selfMatch && handlers.selfMatch.run();
    if (e.target.closest('[data-smx]')) return handlers.selfMatch && handlers.selfMatch.dismiss();
    const cm = e.target.closest('[data-cmode]');
    if (cm) return copyTry(() => handlers.copy.setMode(cm.dataset.cmode));
    const b = e.target.closest('[data-act]');
    if (b) return act(b.dataset.act);
  });
  // Chart lines and labels editor
  root.addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-csel]');
    if (sel) {
      csKind = sel.value;
      return csFill();
    }
    const f = e.target.closest('[data-cs]');
    if (f && (f.type === 'checkbox' || f.tagName === 'SELECT')) return csSet(f.dataset.cs, f.type === 'checkbox' ? f.checked : f.value);
    const cc = e.target.closest('[data-cc]');
    if (cc) {
      ui[cc.dataset.cc] = cc.value;
      saveUi();
      csFill();
      handlers.onInput && handlers.onInput();
    }
  });
  root.addEventListener('input', (e) => {
    const f = e.target.closest('[data-cs]');
    if (f && f.type !== 'checkbox' && f.tagName !== 'SELECT') csSet(f.dataset.cs, f.value.trim());
  });
  csFill();
  root.addEventListener('change', (e) => {
    const al = e.target.closest('input[data-alias]');
    if (al) return store.setAlias(al.dataset.alias, al.value);
    const r = e.target.closest('select[data-crole]');
    if (r) return copyTry(() => handlers.copy.setRole(r.dataset.crole, r.value));
    const dr = e.target.closest('input[data-cpdry]');
    if (dr) return copyTry(() => handlers.copy.setDry(dr.checked));
    const mo = e.target.closest('input[data-cmon]');
    if (mo) return copyTry(() => handlers.copy.setMult(mo.dataset.cmon, { on: mo.checked }));
    const mx = e.target.closest('input[data-cmx]');
    if (mx) return copyTry(() => handlers.copy.setMult(mx.dataset.cmx, { x: mx.value }));
    const lm = e.target.closest('input[data-clim]');
    if (lm) copyTry(() => handlers.copy.setLimit(lm.dataset.clim, lm.dataset.k, lm.value));
  });
  // account selected on PRESS: rows are redrawn at every price and a click could get lost
  root.addEventListener('pointerdown', (e) => {
    const tr = e.target.closest('tr[data-id]'); // accounts table row: selects the account
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
  } else if (a === 'csreset' || a === 'csresetall') {
    const kinds = a === 'csreset' ? [csKind] : CS.ELEMENTS.map((e) => e[0]);
    const d = CS.defaults();
    for (const k of kinds) for (const f of CS.FIELDS) {
      const key = f + '_' + k;
      if (key in d) ui[key] = d[key];
      else delete ui[key];
    }
    if (a === 'csresetall') for (const k of ['cpx', 'cup', 'cdn']) delete ui[k];
    saveUi();
    csFill();
    handlers.onInput && handlers.onInput();
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
  const withX = c.followers.filter((id) => c.mult && c.mult[id] && c.mult[id].on && c.mult[id].x > 0);
  for (const b of root.querySelectorAll('[data-cmode]')) b.title = withX.length ? `Not used by ${withX.map((id) => (S.accounts[id] || {}).label || id).join(', ')}: multiplier ON` : '';
  els.cpgo.textContent = c.armed ? 'STOP' : 'START';
  els.cpgo.classList.toggle('on', c.armed);
  const name = (id) => (S.accounts[id] ? S.accounts[id].label : '?');
  els.cpst.innerHTML = c.armed
    ? `<b class="up">ACTIVE</b> ${F.esc(name(c.master))} → ${c.followers.length} cop${c.followers.length === 1 ? 'y' : 'ies'}`
    : '<span class="muted">off</span>';
  // the <select> is rebuilt only when something changes: redrawing it at every price would close an open dropdown
  const dry = root.querySelector('[data-cpdry]');
  if (dry) {
    dry.checked = !!c.dry;
    dry.disabled = c.armed;
  }
  const key = JSON.stringify([ids, c.roles, c.armed, c.lim, c.mult, c.mode, ids.map((id) => S.accounts[id].label), ids.map((id) => store.activityOf(id).tip)]);
  if (els.cpacc.dataset.key !== key) {
    els.cpacc.dataset.key = key;
    const lim = (id, k, ph, tip) =>
      c.roles[id] === 'copy'
        ? `<input class="clim" data-clim="${F.esc(id)}" data-k="${k}" inputmode="decimal" value="${F.esc(String((c.lim[id] || {})[k] ?? ''))}" placeholder="${ph}" title="${tip}">`
        : '';
    // multiplier of a copy: ON + value; ON greys out 1:1 / Cap-to-fit for that account (Gerry 2026-11-23)
    const mult = (id) => {
      if (c.roles[id] !== 'copy') return '';
      const M = (c.mult || {})[id] || {};
      const x = M.x > 0 ? F.mult(M.x) : '';
      return `<span class="cmul"><input type="checkbox" data-cmon="${F.esc(id)}"${M.on ? ' checked' : ''}${c.armed ? ' disabled' : ''} title="ON: this copy uses the multiplier instead of ${c.mode === '1:1' ? '1:1' : c.mode === 'dd' ? 'DD left' : 'Cap-to-fit'}"><span class="cmx">x</span><input class="clim" data-cmx="${F.esc(id)}" inputmode="decimal" value="${x}" placeholder="1.0"${c.armed ? ' disabled' : ''} title="Multiplier, with a dot: 0.5 = half the master size, 2.0 = double"></span>`;
    };
    els.cpacc.innerHTML =
      `<tr class="cph"><th>Account</th><th>Equity</th><th>Role</th><th title="Size of this copy = master size x the multiplier (e.g. 0.5 or 2.0, with a dot). ON replaces 1:1 / Cap-to-fit for this account.">Multiplier</th><th title="Entries are not copied to this account once its P&L today is down this many $ (exits, SL / TP and cancels still are). Empty = no limit.">Max loss</th></tr>` +
      ids
      .map((id) => {
        const r = c.roles[id] || '';
        const opt = (v, t) => `<option value="${v}"${r === v ? ' selected' : ''}>${t}</option>`;
        const a = S.accounts[id];
        return `<tr><td>${adot(id)}<input class="alias" data-alias="${F.esc(id)}" value="${F.esc(store.aliasOf(id) || '')}" placeholder="${F.esc(a.autoLabel || a.label)}" title="Account name in this panel (Enter to save). Empty = automatic name. ${F.esc(a.type)} account, id ${F.esc(id)}."></td><td class="eq" data-cpeq="${F.esc(id)}"></td>
          <td><select data-crole="${F.esc(id)}"${c.armed ? ' disabled' : ''}>${opt('', '—')}${opt('master', 'Master')}${opt('copy', 'Copy')}</select></td>
          <td>${mult(id)}</td>
          <td>${lim(id, 'loss', 'none', 'Max loss today in $: above it entries are not copied to this account')}</td></tr>`;
      })
      .join('');
  }
  for (const td of els.cpacc.querySelectorAll('[data-cpeq]')) td.textContent = F.usd((vals[td.dataset.cpeq] || {}).equity);
  const l = c.last;
  els.cplast.textContent = l ? `Last copy: ${l.action} from ${l.src}, ${l.ok}/${l.n} copies${l.ms != null ? ` in ${l.ms} ms` : ''}, ${F.ago(l.at)}` : c.armed ? 'Copier ON: no order of the master copied yet in this session' : 'After a reload the copier starts switched off.';
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
  // waiting for Vest data after a reload: header says what is missing, panel greyed out, ORDERS / COPY hidden
  const wait = handlers.waitingFor ? handlers.waitingFor() : [];
  panel.classList.toggle('waiting', wait.length > 0);
  els.hwait.style.display = wait.length ? '' : 'none';
  if (wait.length) els.hwait.textContent = `WAITING FOR VEST DATA… (${wait.join(', ')})`;
  // header ORDERS / COPY (Gerry 2026-11-23: moved here from Trade commands, always in sight)
  els.hord.textContent = on ? 'ON' : 'OFF';
  els.hord.classList.toggle('on', !!on);
  const cs = handlers.copy && handlers.copy.state();
  const cOk = !!(cs && cs.master && cs.followers && cs.followers.length);
  els.hcpy.style.display = els.hcpl.style.display = cOk && !wait.length ? '' : 'none';
  root.querySelector('.htg').style.display = wait.length ? 'none' : '';
  els.hcpy.textContent = cs && cs.armed ? 'ON' : 'OFF';
  els.hcpy.classList.toggle('on', !!(cs && cs.armed));
  const ts = handlers.trailStatus ? handlers.trailStatus() : null;
  // warnings for empty fields (BE+ on with an empty profit made the button do a plain BE)
  const warn = [];
  if (ui.beOn && !(+ui.beOff > 0)) warn.push(`BE+ is on but "profit" is empty: the BE button puts the stop at the entry`);
  if (ui.beAuto && !(+ui.beAt > 0)) warn.push(`Auto BE is on but the "after" threshold is empty: it never triggers`);
  if (ui.trOn && !(+ui.trDist > 0)) warn.push('Trailing is on but "pullback" is empty: it does nothing');
  // shown in Trailing & breakeven of the column (trailNote)
  trailTxt = { text: [...warn, ts ? 'Trailing / BE: ' + ts : ''].filter(Boolean).join(' · '), warn: warn.length > 0 };

  // ── Accounts overview: one row per account + total row (no balance / session: balance = equity - open, session ~ today)
  const sum = (k) => {
    let t = 0;
    for (const id of ids) {
      const v = vals[id] && vals[id][k];
      if (!Number.isFinite(v)) return NaN; // one account without data makes the total unknown: never pass off a partial total as complete
      t += v;
    }
    return ids.length ? t : NaN;
  };
  const T = { equity: sum('equity'), upnl: sum('upnl'), dayPnl: sum('dayPnl'), totalPnl: sum('totalPnl') };
  els.flatall.disabled = !!S.flattening || !ids.length;
  els.flatall.textContent = S.flattening ? 'FLATTENING…' : 'FLATTEN ALL';
  const roleTag = (id) => {
    if (!cs || !cs.roles[id]) return '';
    if (cs.roles[id] === 'master') return ' <i class="rtag m" title="Copier master">M</i>';
    const x = cs.mult && cs.mult[id] && cs.mult[id].on && cs.mult[id].x > 0 ? cs.mult[id].x : 0;
    return ` <i class="rtag" title="Copier copy${x ? ': size = master x ' + x : ''}">C${x ? ' x' + F.mult(x) : ''}</i>`;
  };
  const td = (v) => `<td class="${F.cls(v)}">${F.usd(v, true)}</td>`;
  const rows = ids
    .map((id) => {
      const a = S.accounts[id],
        v = vals[id];
      const src = v.source === 'series' ? ' <span class="muted" title="equity from the Vest performance series, about 1 minute late">*</span>' : '';
      const sel = id === S.selected;
      return `<tr data-id="${F.esc(id)}" class="${sel ? 'sel' : ''}">
        <td title="${F.esc(a.type)} account">${adot(id)}${F.esc(a.label)}${roleTag(id)}${sel ? ' <b class="act" title="Active on Vest: the buttons of the tool trade on this account">ACTIVE</b>' : ''}</td>
        <td>${F.usd(v.equity)}${src}</td>${td(v.upnl)}
        <td class="${F.cls(v.dayPnl)}" title="${Number.isFinite(v.dayPnl) ? 'equity minus equity at 20:00 New York time (start of the Vest day)' : 'start of the Vest day not read yet for this account'}">${F.usd(v.dayPnl, true)}</td>
        ${td(v.totalPnl)}<td>${F.usd(v.toFloor)}</td></tr>`;
    })
    .join('');
  els.accounts.innerHTML = `<thead><tr><th>Account</th><th>Equity</th><th>Open</th><th title="equity minus equity at 20:00 New York time (start of the Vest day)">Today</th><th>Total</th><th title="$ of equity left before the drawdown limit (total or daily, whichever is closer)">Room</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="6" class="muted">Waiting for the Vest session…</td></tr>'}</tbody>
    ${ids.length > 1 ? `<tfoot><tr class="sum"><td>Total (${ids.length})</td><td>${F.usd(T.equity)}</td>${td(T.upnl)}${td(T.dayPnl)}${td(T.totalPnl)}<td></td></tr></tfoot>` : ''}`;
  els.ovsub.textContent = ids.length ? `${ids.length} account${ids.length === 1 ? '' : 's'} · click a row to see which one is active on Vest` : '';

  renderCopy(ids, vals);
  renderSelInfo();
  renderPending();

  renderPositions();
  renderCalc();
  els.checks.innerHTML = S.checks.map((c) => `<tr><td>${F.esc(c.name)}</td><td class="lvl ${c.level}">${c.level}</td><td>${F.esc(c.msg)}</td></tr>`).join('') || '<tr><td class="muted">Not run yet</td></tr>';
  els.sync.textContent = S.syncError ? 'Last read failed: ' + S.syncError : `Full read ${F.ago(S.lastSync)} · feed ${store.feedLive() ? 'live' : 'down'}`;
}

let lastPend = [];
let trailTxt = { text: '', warn: false };
// one line about the account active on Vest and the chart's market (margin and size still available)
function renderSelInfo() {
  const t = handlers.tradeInfo && handlers.tradeInfo();
  if (!t) {
    els.selinfo.innerHTML = '<span class="muted">No account active on Vest</span>';
    return;
  }
  const mp = Number.isFinite(t.marginPct) ? Math.round(t.marginPct * 100) + '%' : '—';
  els.selinfo.innerHTML = `Active on Vest: <b>${F.esc(t.account)}</b> · ${F.esc(t.label)}${t.lev > 0 ? ' ' + t.lev + 'x' : ''} <b>${F.priceG(t.mark, t.priceDec)}</b> · margin used <b>${mp}</b> · ${t.maxQty > 0 ? `<b>${F.qty(t.maxQty)}</b> ${F.esc(t.label)} can still be opened` : 'no free margin'}`;
}

// pending orders of EVERY account (Vest limits and local stops); rewritten only when they change (a replaced button loses the click)
function renderPending() {
  const list = (handlers.pendingsAll && handlers.pendingsAll()) || [];
  lastPend = list;
  const html = list.length
    ? list
        .map((o) => {
          const m = S.symbols[o.symbol] || { priceDec: 2, label: o.symbol || '' };
          return `<div class="pr"><span class="pa">${F.esc(o.account)}</span><span class="pk">${F.esc(o.kind)}</span><span class="${o.side === 'long' ? 'up' : 'down'}">${o.side === 'long' ? 'BUY' : o.side === 'short' ? 'SELL' : ''}</span><span>${F.qty(o.qty)} ${F.esc(m.label)}</span><span class="muted">@ ${F.priceG(o.price, m.priceDec)}</span><button class="btn sm" data-cancel="${F.esc(o.key)}">cancel</button></div>`;
        })
        .join('')
    : '<span class="muted">none</span>';
  if (els.pend.dataset.html !== html) {
    els.pend.innerHTML = html;
    els.pend.dataset.html = html;
  }
}

// open positions of EVERY account, one table
function renderPositions() {
  const ids = Object.keys(S.accounts).sort((a, b) => String(S.accounts[a].label).localeCompare(String(S.accounts[b].label), 'en', { numeric: true }));
  const rows = ids
    .flatMap((id) =>
      ((S.state[id] || {}).positions || [])
        .filter((p) => p.qty > 0)
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
          return `<tr class="${id === S.selected ? 'sel' : ''}"><td>${F.esc(S.accounts[id].label)}</td><td>${F.esc(m.label)}</td><td class="${p.side === 'long' ? 'up' : 'down'}">${p.side === 'long' ? 'LONG' : 'SHORT'}</td><td>${F.qty(p.qty)}</td>
            <td>${F.price(p.openPrice, m.priceDec)}${stale}</td>
            <td class="${F.cls(pnl)}">${F.usd(pnl, true)}</td><td>${p.triggers.some((t) => t.kind === 'sl') ? F.usd(risk, true) : '<span class="down">no SL</span>'}</td></tr>
            <tr class="legs"><td></td><td colspan="6" class="muted" style="text-align:left">${legs || 'no stop or target'}</td></tr>`;
        }),
    )
    .join('');
  els.positions.innerHTML = rows
    ? `<table class="acct"><thead><tr><th>Account</th><th>Market</th><th>Side</th><th>Qty</th><th>Entry</th><th>P&L $</th><th>Risk at SL</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<span class="muted">No open position</span>';
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

/** Self-matching block / warning in the header: { text, kind, button } or null. Stays until ✕ or the next check. */
function smShow(v) {
  if (!els.smw) return;
  els.smw.style.display = v ? '' : 'none';
  if (!v) return;
  els.smw.className = 'smw ' + (v.kind || 'err');
  els.smt.textContent = v.text;
  els.smgo.style.display = v.button ? '' : 'none';
  els.smgo.textContent = v.button || '';
}
/** Read-only indicator: your resting orders that already cross each other ('' = hidden). */
let smcText = '';
function smCross(text) {
  if (!els.smc || text === smcText) return;
  smcText = text;
  els.smc.style.display = text ? '' : 'none';
  els.smc.textContent = text;
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
  // trades closed today (one Vest position = one trade, adds and partial closes included), winners / losers, left of "today"
  const T = d.trades;
  const trd = T && T.n >= 0 && d.dpt
    ? `<span class="dtr" title="Trades closed today (Vest day, from 20:00 New York): one position = one trade, adds and partial closes included. Won / lost by points, fees not counted."><b>${T.n}</b><i>trades</i><b class="up">${T.win}▲</b><b class="down">${T.loss}▼</b></span>`
    : '';
  const day = d.dpt ? `${trd}<span class="day"><i>today</i> <b class="${e(d.dptC)}">${e(d.dpt)}</b></span>` : '';
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
  exclusive(k, v);
  saveUi();
  const inp = root && root.querySelector('[data-in="' + k + '"]');
  if (inp) {
    if (inp.type === 'checkbox') inp.checked = !!v;
    else inp.value = v;
  }
  handlers.onInput && handlers.onInput();
  render();
}

/**
 * Functions that cannot work together (Gerry 2026-11-23): switching one ON switches the others OFF.
 *  - Safe runner LIVE  <->  trailing stop, auto BE (they move the same stop), Risk & targets ON (the plan has its own legs)
 *  - Bracket           <->  Risk & targets ON (two sets of SL / TP on the same entry)
 * k = key just changed in ui (or 'risk' when Risk & targets was switched ON in the column). Returns the names switched off.
 */
function exclusive(k, v) {
  const off = [];
  const set = (key, val, name) => {
    if (ui[key] === val) return;
    ui[key] = val;
    off.push(name);
    const inp = root && root.querySelector(`[data-in="${key}"]`);
    if (inp) {
      if (inp.type === 'checkbox') inp.checked = !!val;
      else inp.value = val;
    }
  };
  const risk = () => {
    if (handlers.riskOn && handlers.riskOn()) {
      handlers.riskOff();
      off.push('Risk & targets');
    }
  };
  if ((k === 'trOn' || k === 'beAuto') && v === true && ui.srMode === 'live') set('srMode', 'off', 'Safe runner LIVE');
  if (k === 'srMode' && v === 'live') {
    set('trOn', false, 'Trailing stop');
    set('beAuto', false, 'auto BE');
    risk();
  }
  if (k === 'brOn' && v === true) risk();
  if (k === 'risk') {
    set('brOn', false, 'Bracket');
    if (ui.srMode === 'live') set('srMode', 'off', 'Safe runner LIVE');
  }
  if (off.length) {
    saveUi();
    say(`${off.join(', ')} switched OFF: not compatible with ${{ trOn: 'Trailing stop', beAuto: 'auto BE', srMode: 'Safe runner LIVE', brOn: 'Bracket', risk: 'Risk & targets' }[k]}`, 'warn');
  }
  return off;
}

/** Notes of the Bracket and Safe runner sections of the column. */
function sideNotes() {
  const rs = handlers.runnerStatus ? handlers.runnerStatus() : null;
  const rw = ui.srMode === 'live' && (ui.trOn || ui.beAuto) ? 'LIVE needs trailing and auto BE OFF (they move the same stop)' : '';
  const bw = ui.brOn && !(+ui.brSl > 0);
  return {
    br: bw ? { text: 'Bracket is on but SL is empty: entries go without SL / TP', warn: true } : { text: ui.brOn ? `Every new entry from the tool goes with SL ${ui.brSl} pt${+ui.brTp > 0 ? ' and TP ' + ui.brTp + ' pt' : ''}.${ui.brDca ? ' With a position open, after an add (market or LIMIT filled) and when entry LIMITs are placed or cancelled, SL / TP move to the same distances from AVG ALL (position + LIMITs waiting); the SL never sits between two entries: if a LIMIT is at or past it, it goes SL pt beyond the farthest LIMIT. A SL at breakeven or in profit stays.' : ' Adds have no legs: SL / TP stay where they are.'}` : '' },
    sr: { text: [rw, handlers.runnerTrend ? handlers.runnerTrend().text : '', rs || ''].filter(Boolean).join(' · '), warn: !!rw },
    oco: { text: ui.ocoOn ? 'ON: when a pending entry of a market is executed (LIMIT filled or local STOP touched) the other pending entries of that market are cancelled (Orders ON, tab open). A local STOP can be armed on either side of a pending LIMIT.' : 'OFF: pending LIMITs and local STOPs live independently.', warn: false },
  };
}

/** Trailing / BE status line of the panel (warnings for empty fields + what is running). */
const trailNote = () => trailTxt;

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

/** Lines and labels on the chart (Layout → Chart lines and labels): { kind: { c, s, w, l?, lab } }. */
const lineStyles = () => CS.styles(ui);
/** Colours of every label: price, profit, loss ('' = the card style's). */
const COMMON = { cpx: '#d7dbe3', cup: '#3ecf8e', cdn: '#ff6b61' };
const chartCommon = () => Object.fromEntries(Object.keys(COMMON).map((k) => [k, /^#[0-9a-f]{6}$/i.test(ui[k]) ? ui[k] : '']));

// ── editor of Chart lines and labels: one element at a time (the select), its fields are ui[field + '_' + kind]
let csKind = 'long';
function csFill() {
  if (!root) return;
  const sel = root.querySelector('[data-csel]');
  if (!sel) return;
  sel.value = csKind;
  const st = CS.styleOf(ui, csKind);
  for (const inp of root.querySelectorAll('[data-cs]')) {
    const v = CS.shown(ui, csKind, inp.dataset.cs);
    if (inp.type === 'checkbox') inp.checked = !!v;
    else if (root.activeElement !== inp) inp.value = v;
  }
  root.querySelector('[data-cslab]').style.display = st && st.lab ? '' : 'none';
  root.querySelector('[data-csseg]').style.display = CS.SEGS.has(csKind) ? '' : 'none';
  for (const inp of root.querySelectorAll('[data-cc]')) if (root.activeElement !== inp) inp.value = /^#[0-9a-f]{6}$/i.test(ui[inp.dataset.cc]) ? ui[inp.dataset.cc] : COMMON[inp.dataset.cc];
  // preview: the line and the label as on the chart
  const pv = root.querySelector('[data-csprev]');
  const ln = pv.querySelector('.csline'),
    ch = pv.querySelector('.cschip');
  const dd = st.s === 'dashdot';
  ln.style.borderTop = dd ? '0' : `${st.w}px ${st.s} ${st.c}`;
  ln.style.height = dd ? st.w + 'px' : '0';
  ln.style.background = dd ? `repeating-linear-gradient(90deg, ${st.c} 0 8px, transparent 8px 11px, ${st.c} 11px 13px, transparent 13px 16px)` : '';
  ch.style.display = st.lab ? '' : 'none';
  if (st.lab) {
    const L = st.lab;
    const el = CS.ELEMENTS.find((e) => e[0] === csKind);
    ch.querySelector('.k').textContent = el[1].replace(/ \(.*\)$/, '').toUpperCase();
    ch.style.background = L.bg || '#17181b';
    ch.style.borderColor = L.bo || el[6].bo || '#2a2f3a';
    ch.style.borderWidth = (L.bw == null ? 1 : L.bw) + 'px';
    ch.style.fontSize = (L.fs || 12) + 'px';
    ch.style.fontWeight = L.fw === 'n' ? '400' : L.fw === 'b' ? '700' : '';
    const k = ch.querySelector('.k');
    k.style.color = L.n || st.c;
    k.style.background = L.nb || 'transparent';
    k.style.padding = L.nb ? '0 4px' : '0';
    ch.querySelector('b').style.color = chartCommon().cpx || '';
    ch.querySelector('.up').style.color = chartCommon().cup || '';
  }
}
function csSet(f, v) {
  if (f === 'cnbOn') {
    ui['cnb_' + csKind] = v ? CS.shown(ui, csKind, 'cnb') : 'none';
  } else ui[f + '_' + csKind] = v;
  saveUi();
  csFill();
  handlers.onInput && handlers.onInput();
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

/** Main panel open (false) or folded to its header (true): Trade commands floating = open, docked = folded. */
/** Swing range section: points between the last swing high and low (from the overlay). */
let swingKey = null;
function swingNote(text) {
  if (!root || text === swingKey) return;
  const el = root.querySelector('[data-swst]');
  if (!el) return;
  swingKey = text;
  el.textContent = text;
}

function setMin(v) {
  if (!panel || ui.min === !!v) return;
  showInfo(null);
  ui.min = !!v;
  panel.classList.toggle('min', ui.min);
  saveUi();
  layout(true);
}

module.exports = {
  exclusive,
  setMin,
  swingNote,
  qtyStyle,
  cardsColumn,
  setUiInput,
  say,
  smShow,
  smCross,
  headPos,
  trailNote,
  sideNotes,
  lineStyles, chartCommon, btnColors, mount, render, ui: () => ui, setUi };
