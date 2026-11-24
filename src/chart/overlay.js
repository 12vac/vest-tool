// Trade overlay on the chart: HTML on top of the TradingView iframe, in the free area right of the last candle.
// - main card ALWAYS visible: when flat, instrument and price; with a position, side, P&L, size, entry, FLAT
// - second card: size in %, LIMIT and STOP to drag onto the chart (order on release, no confirmation),
//   cancel buttons, TP SL to drag, BE, LONG SHORT (at market)
// - third card: partial close, margin, daily goal, drawdown bars; fourth card: copier accounts
// - position SL and TP: lines + draggable labels with X; pending orders and local stops: lines + labels with X
// Geometry: visible price range of the right price scale + the main pane's canvas inside the chart iframe.

const css = require('./overlay.css');
const G = require('../domain/geometry');
const { roundToTick } = require('../domain/num');
const { checkLeg } = require('../domain/orders');
const { entrySide, tooClose } = require('../domain/sizing');
const { pnlUsd } = require('../domain/money');
const { microOf } = require('../domain/micro');
const Fmt = require('../ui/format');
const F = { ...Fmt, usd: Fmt.usdUS }; // same US dollar format as the panel
const log = require('../diag/log');
const bars = require('./bars');
const OM = require('../domain/plan');
const GR = require('../domain/grid');
const { HELP } = require('../ui/help');

// RESERVED AREA on the right. Distances from the right edge of the chart (start of the price axis):
//   cards 232 px wide, 20 px from the axis; labels right next to the cards.
// The block of cards sits at the vertical CENTRE of the chart: it does not follow the price. Measurements in overlay.css.
// side arrow (10.4 x 16.3, head 11.2 high, stem 2.6)
const ARROW_UP = '<svg viewBox="0 0 10.4 16.3" fill="currentColor"><path d="M5.2 0L10.4 11.2H6.5V16.3H3.9V11.2H0Z"/></svg>';
const ARROW_DOWN = '<svg viewBox="0 0 10.4 16.3" fill="currentColor"><path d="M5.2 16.3L10.4 5.1H6.5V0H3.9V5.1H0Z"/></svg>';
// SCALE from the main panel: cards and labels are enlarged with a CSS transform, so text, radii, borders and
// alignment stay in proportion. overlay.css keeps the design measurements (cards at 100%).
const CARD_W = 232; // CSS width (on screen: x card scale)
const SCALE_MIN = 50,
  SCALE_MAX = 250;
const scaleOf = (v, def) => {
  const n = +v;
  return (n >= SCALE_MIN && n <= SCALE_MAX ? n : def) / 100;
};
const CARD_RIGHT = 20; // cards from the price axis
const ROOM_MIN = 50, ROOM_MAX = 900, ROOM_DEF = 360; // space between the last candle and the cards (px)
const LEAD_W = 24; // slanted stroke between the line end and a shifted label
const CHIP_GAP = 19; // SL/TP/LIMIT/STOP labels aligned to the RIGHT, this far from the cards
const CANDLE_RIGHT = 535; // centre of the last candle, from the price axis (candles and indicators stop there)
const CARD2_GAP = 6; // gap between the cards
const ROOM_IDLE_MS = 500; // the chart margin is restored half a second after zoom/drag
const CLICK_PX = 3;
const GRAB_HALF = 4; // SL/TP/LIMIT/STOP lines can be grabbed: invisible band of 2*4+1 px around the line
const PRESETS = [1, 2, 4, 8, 5, 16]; // defaults of the 6 % buttons; changed from the panel (presets), ascending on the card
const FRACS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]; // fixed top row: fractions of 1%
const COLORS = { gdavg: '#e5e7eb', gdenE: '#3b82f6', gdtpE: '#22c55e', gdslE: '#ef4444', gden: '#7dd3fc', gdtp: '#a3e635', gdsl: '#fb7185', usr: '#f97316', avg: '#5ad1e6', avg1: '#5ad1e6', ko: '#c58cff', dd50: '#f472b6', mfp: '#ff9f43', avgn: '#5ad1e6', long: '#3ecf8e', short: '#ff6b61', tp: '#3ecf8e', sl: '#ff6b61', lm: '#7fb2ff', st: '#e8b84a' };
// names shown for the order kinds (labels, messages)
const NAME = { tp: 'TP', sl: 'SL', lm: 'LIMIT', st: 'STOP' };
// line style per kind (colour, dash, width): from the panel (m.lineStyles), otherwise the defaults
let lineStyles = null;
const LS = (k) => (lineStyles && lineStyles[k]) || { c: COLORS[k] || '#8b93a3', s: 'dashed', w: 1 };

let root = null,
  els = {},
  getModel = () => null,
  actions = {},
  enabled = true;
let legEls = new Map(); // id -> { line, chip, html } (position SL/TP and pending orders)
let drag = null; // { kind, existing, startY, moved, price, ok, g }
let pending = null; // { kind, legId, price, until }
let msgTimer = null;
let state = { visible: false, why: 'not started', posId: null };
let room = null; // { orig, set }
let lastTouch = 0;
let hoverSide = null; // 'long' | 'short' while the mouse is over LONG / SHORT: fail price preview on the chart
const hookedDocs = new WeakSet();

function mount(opts) {
  getModel = opts.getModel;
  actions = opts.actions;
  const host = document.createElement('div');
  root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>${css}</style><div class="root">
    <div class="hl" data-el="dragLine" style="display:none"></div>
    <div class="tseg stop" data-el="trS" style="display:none" title="Trailing: stop"></div>
    <div class="tseg act" data-el="trA" style="display:none" title="Trailing: start level"></div>
    <div class="tseg next" data-el="trN" style="display:none" title="Trailing: next step"></div>
    <div class="tseg be" data-el="trB" style="display:none" title="BE+"></div>
    <div class="tseg bet" data-el="trT" style="display:none" title="Auto BE"></div>
    <div class="tseg hl" data-el="hlH" style="display:none"></div>
    <div class="tseg hl" data-el="hlL" style="display:none"></div>
    <div class="chip" data-el="dragChip" style="display:none"></div>
    <div class="card" data-el="card">
      <span class="side" data-el="side"><b data-el="sym"></b><i class="cd" data-el="cd"></i><i data-el="clk"></i></span>
      <span class="pnl" data-el="pnl"></span>
      <span class="gap" data-el="gap"></span>
      <span class="w q" data-el="qty"></span>
      <span class="w vs" data-el="sideTxt"></span>
      <span class="w e" data-el="entry"></span>
      <span class="acc" data-el="acc"></span>
      <span class="dpt" data-el="dpt"></span>
      <span class="tgl ordl" data-el="ordl">ORDERS</span><button class="ordc" data-a="orders" data-el="ordc">OFF</button>
      <span class="tgl cpl" data-el="cpl">COPY</span><button class="cpc" data-a="copy" data-el="cpc">OFF</button>
      <span class="mic" data-el="mic"></span>
      <button class="flat" data-a="flat" data-el="flatB">FLAT</button>
    </div>
    <div class="card2" data-el="card2">
      ${FRACS.map((p, i) => `<button class="pp pf f${i}" data-p="${p}">${p}%</button>`).join('')}
      ${PRESETS.map((p, i) => `<button class="pp p${i}" data-p="${p}">${p}%</button>`).join('')}
      <label class="pctbox"><input data-el="pctIn" inputmode="decimal" autocomplete="off"><span>%</span></label>
      <span class="sz" data-el="sz"></span>
      <button class="lm" data-a="lm">LIMIT</button>
      <button class="st" data-a="st">STOP</button>
      <button class="cx cxb" data-a="cxmenu">CANCEL ▾</button>
      <div class="cxm" data-el="cxm" style="display:none">
        <button data-cx="lm" data-el="cxLm">Pending limits</button>
        <button data-cx="st" data-el="cxSt">Local stops</button>
        <button data-cx="all" data-el="cxAll">All orders</button>
      </div>
      <button class="tp" data-a="tp">TP</button>
      <button class="sl" data-a="sl">SL</button>
      <button class="be" data-a="be">BE</button>
      <button class="long" data-a="long">LONG</button>
      <button class="short" data-a="short">SHORT</button>
    </div>
    <div class="card3" data-el="card3">
      <label class="pctbox cp" data-el="cpBox"><input data-el="cpIn" inputmode="decimal" autocomplete="off"><span>%</span></label>
      <button class="close" data-a="close" data-el="closeB">PARTIAL CLOSE</button>
      <button class="close all" data-a="closeall" data-el="closeAllB">CLOSE</button>
      <div class="bars">
        <div class="bar"><div class="bl"><span>MARGIN USED</span><span data-el="m1t"></span></div><div class="track"><i data-el="m1f"></i></div></div>
        <div class="bar"><div class="bl"><span>MARGIN USED + ORDERS</span><span data-el="m2t"></span></div><div class="track"><i data-el="m2f"></i></div></div>
        <div class="bar" data-g="dg"><div class="bl"><span>DAILY PROFIT TARGET</span><span data-el="dgt"></span></div><div class="track"><i data-el="dgf"></i></div><div class="gl"><button class="gon" data-gk="dg">OFF</button><button class="geye" data-ek="dg" title="Show / hide this level on the chart (USER line)"><svg viewBox="0 0 24 24" width="15" height="15"><path d="M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3.2" fill="currentColor"/><line class="sl" x1="3" y1="21" x2="21" y2="3" stroke="currentColor" stroke-width="2.2"/></svg></button><label class="gn">FLAT at ≥ $<input class="gv" data-gk="dg" inputmode="decimal" autocomplete="off"></label><span class="gt"></span></div></div>
        <div class="bar" data-g="dl"><div class="bl"><span>DAILY LOSS LIMIT</span><span data-el="dlt"></span></div><div class="track"><i data-el="dlf"></i></div><div class="gl"><button class="gon" data-gk="dl">OFF</button><button class="geye" data-ek="dl" title="Show / hide this level on the chart (USER line)"><svg viewBox="0 0 24 24" width="15" height="15"><path d="M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3.2" fill="currentColor"/><line class="sl" x1="3" y1="21" x2="21" y2="3" stroke="currentColor" stroke-width="2.2"/></svg></button><label class="gn">FLAT at loss ≥ $<input class="gv" data-gk="dl" inputmode="decimal" autocomplete="off"></label><span class="gt"></span></div></div>
        <div class="bar" data-g="cp"><div class="bl"><span>MAX OPEN PROFIT</span><span data-el="cpt2"></span></div><div class="track gs"><i data-el="cpf"></i><input type="range" class="gr" data-gk="cp" min="0" aria-label="FLAT level"></div><div class="gl"><button class="gon" data-gk="cp">OFF</button><button class="geye" data-ek="cp" title="Show / hide this level on the chart (USER line)"><svg viewBox="0 0 24 24" width="15" height="15"><path d="M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3.2" fill="currentColor"/><line class="sl" x1="3" y1="21" x2="21" y2="3" stroke="currentColor" stroke-width="2.2"/></svg></button><span class="gt"></span></div></div>
        <div class="bar" data-g="rk"><div class="bl"><span>MAX OPEN LOSS</span><span data-el="rkt"></span></div><div class="track gs"><i data-el="rkf"></i><input type="range" class="gr" data-gk="rk" min="0" aria-label="FLAT level"></div><div class="gl"><button class="gon" data-gk="rk">OFF</button><button class="geye" data-ek="rk" title="Show / hide this level on the chart (USER line)"><svg viewBox="0 0 24 24" width="15" height="15"><path d="M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3.2" fill="currentColor"/><line class="sl" x1="3" y1="21" x2="21" y2="3" stroke="currentColor" stroke-width="2.2"/></svg></button><span class="gt"></span></div></div>
        <div class="bar" data-g="dd"><div class="bl"><span data-el="ddl">DAILY DRAWDOWN BUFFER</span><span data-el="ddt"></span></div><div class="track"><i data-el="ddf"></i></div><div class="gl"><button class="gon" data-gk="dd">OFF</button><button class="geye" data-ek="dd" title="Show / hide this level on the chart (USER line)"><svg viewBox="0 0 24 24" width="15" height="15"><path d="M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3.2" fill="currentColor"/><line class="sl" x1="3" y1="21" x2="21" y2="3" stroke="currentColor" stroke-width="2.2"/></svg></button><label class="gn">FLAT at ≤ $<input class="gv" data-gk="dd" inputmode="decimal" autocomplete="off"></label><span class="gt"></span></div></div>
        <div class="bar" data-g="dm"><div class="bl"><span data-el="dml">MAX DRAWDOWN BUFFER</span><span data-el="dmt"></span></div><div class="track"><i data-el="dmf"></i></div><div class="gl"><button class="gon" data-gk="dm">OFF</button><button class="geye" data-ek="dm" title="Show / hide this level on the chart (USER line)"><svg viewBox="0 0 24 24" width="15" height="15"><path d="M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3.2" fill="currentColor"/><line class="sl" x1="3" y1="21" x2="21" y2="3" stroke="currentColor" stroke-width="2.2"/></svg></button><label class="gn">FLAT at ≤ $<input class="gv" data-gk="dm" inputmode="decimal" autocomplete="off"></label><span class="gt"></span></div></div>
        <div class="bar" data-g="tg"><div class="bl"><span data-el="tgl">ACCOUNT PROFIT TARGET</span><span data-el="tgt"></span></div><div class="track"><i data-el="tgf" class="goal"></i></div><div class="gl"><button class="gon" data-gk="tg">OFF</button><button class="geye" data-ek="tg" title="Show / hide this level on the chart (USER line)"><svg viewBox="0 0 24 24" width="15" height="15"><path d="M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3.2" fill="currentColor"/><line class="sl" x1="3" y1="21" x2="21" y2="3" stroke="currentColor" stroke-width="2.2"/></svg></button><span class="gt"></span></div></div>
      </div>
      <div class="msg" data-el="msg"></div>
    </div>
    <div class="card4" data-el="card4"><table data-el="cpt"></table></div>
    <div class="card5" data-el="card5">
      <div class="c5r" data-el="swRow"><span>SWING RANGE</span><b data-el="swg"></b></div>
      <div class="c5r" data-el="atrRow"><span>VOLATILITY</span><i data-el="atrHd"></i></div>
      <div class="hm" data-el="hm"></div>
    </div>
    <div class="colw" data-el="colw" style="display:none">
      <div class="csec om" data-el="sOm" data-sec="om"><div class="csh">Risk &amp; targets<button class="omtgl" data-a="omtoggle" data-el="omTgl">OFF</button><b class="sact" data-el="actOm" style="display:none">ACTIVE</b></div>
        <div class="omb">
          <label class="omf"><span>Size by</span><select data-om="sizeBy"><option value="risk">Risk $</option><option value="pct">% of max</option><option value="qty">Quantity</option></select></label>
          <label class="omf"><span data-el="omSzL">Risk ($)</span><input data-om="sizeVal" inputmode="decimal" autocomplete="off"></label>
          <label class="omf omck"><span>Fees</span><span class="omcb"><input type="checkbox" data-om="fees"> count fees</span></label>
          <div class="omf"><span>Leverage (Vest)</span><b class="omro" data-el="omLev">—</b></div>
          <div class="omt">
            <div class="omtg"><label><input type="checkbox" data-om="on0"> T1</label><select data-om="by0"><option value="r">R multiple</option><option value="ticks">Ticks</option><option value="dist">Points</option><option value="atr">ATR multiple</option><option value="trail">Trailing</option></select><span class="omsp"><input data-om="val0" inputmode="decimal" autocomplete="off"><span class="spb"><button type="button" tabindex="-1" data-sp="1">▲</button><button type="button" tabindex="-1" data-sp="-1">▼</button></span></span></div>
            <div class="omtg"><label><input type="checkbox" data-om="on1"> T2</label><select data-om="by1"><option value="r">R multiple</option><option value="ticks">Ticks</option><option value="dist">Points</option><option value="atr">ATR multiple</option><option value="trail">Trailing</option></select><span class="omsp"><input data-om="val1" inputmode="decimal" autocomplete="off"><span class="spb"><button type="button" tabindex="-1" data-sp="1">▲</button><button type="button" tabindex="-1" data-sp="-1">▼</button></span></span></div>
            <div class="omtg"><label><input type="checkbox" data-om="on2"> T3</label><select data-om="by2"><option value="r">R multiple</option><option value="ticks">Ticks</option><option value="dist">Points</option><option value="atr">ATR multiple</option><option value="trail">Trailing</option></select><span class="omsp"><input data-om="val2" inputmode="decimal" autocomplete="off"><span class="spb"><button type="button" tabindex="-1" data-sp="1">▲</button><button type="button" tabindex="-1" data-sp="-1">▼</button></span></span></div>
            <div class="omtg"><label><input type="checkbox" data-om="on3"> T4</label><select data-om="by3"><option value="r">R multiple</option><option value="ticks">Ticks</option><option value="dist">Points</option><option value="atr">ATR multiple</option><option value="trail">Trailing</option></select><span class="omsp"><input data-om="val3" inputmode="decimal" autocomplete="off"><span class="spb"><button type="button" tabindex="-1" data-sp="1">▲</button><button type="button" tabindex="-1" data-sp="-1">▼</button></span></span></div>
          </div>
          <label class="omf"><span>Stop by</span><select data-om="stopBy"><option value="dist">Points</option><option value="ticks">Ticks</option><option value="bar">Prev. candle</option><option value="atr">ATR multiple</option></select></label>
          <label class="omf"><span data-el="omStL">Distance</span><input data-om="stopVal" inputmode="decimal" autocomplete="off"></label>
          <label class="omf"><span>Stops</span><select data-om="stops"><option value="one">One stop</option><option value="each">Per target</option></select></label>
          <label class="omf"><span>Split</span><select data-om="split"><option value="even">Equal</option><option value="front">T1 most</option><option value="back">Last most</option></select></label>
          <div class="ompv"><span>Side on the chart</span><button class="ompl" data-a="omside" data-v="long" data-el="omL">LONG SIDE</button><button class="omps" data-a="omside" data-v="short" data-el="omS">SHORT SIDE</button></div>
          <div class="omout" data-el="omOut"></div>
        </div>
      </div>
      <div class="csec" data-el="sPos" data-sec="pos"><div class="csh">Position</div></div>
      <div class="csec tb" data-el="sTb" data-sec="tb"><div class="csh">Trailing &amp; breakeven<b class="sact" data-el="actTb" style="display:none">ACTIVE</b></div>
        <div class="tbb">
          <label class="omcb tbon"><input type="checkbox" data-tb="trOn"> Trailing stop</label>
          <label class="omf"><span>Unit</span><select data-tb="trUnit"><option value="pt">pt</option><option value="$">$</option></select></label>
          <label class="omf"><span>Starts after</span><input data-tb="trAct" inputmode="decimal" autocomplete="off" placeholder="empty"></label>
          <label class="omf"><span>Pullback</span><input data-tb="trDist" inputmode="decimal" autocomplete="off" placeholder="empty"></label>
          <label class="omf"><span>Step</span><input data-tb="trStep" inputmode="decimal" autocomplete="off" placeholder="empty"></label>
          <label class="omcb tbon"><input type="checkbox" data-tb="beOn"> BE+</label>
          <label class="omf"><span>Unit</span><select data-tb="beUnit"><option value="pt">pt</option><option value="$">$</option></select></label>
          <label class="omf"><span>Profit</span><input data-tb="beOff" inputmode="decimal" autocomplete="off" placeholder="empty"></label>
          <label class="omcb tbauto"><input type="checkbox" data-tb="beAuto"> auto BE</label>
          <label class="omf"><span>after</span><input data-tb="beAt" inputmode="decimal" autocomplete="off" placeholder="empty"></label>
          <div class="tbnote" data-el="tbNote"></div>
        </div>
      </div>
      <div class="csec" data-el="sLim" data-sec="lim"><div class="csh">Account limits<b class="sact" data-el="actLim" style="display:none">ACTIVE</b></div></div>
      <div class="csec" data-el="sCopy" data-sec="copy"><div class="csh">Copier accounts<b class="sact" data-el="actCopy" style="display:none">ACTIVE</b></div></div>
      <div class="csec tb" data-el="sBr" data-sec="br"><div class="csh">Bracket (SL / TP on every new entry)<b class="sact" data-el="actBr" style="display:none">ACTIVE</b></div>
        <div class="tbb">
          <label class="omcb tbon"><input type="checkbox" data-tb="brOn"> Bracket</label>
          <label class="omf"><span>SL (pt)</span><input data-tb="brSl" inputmode="decimal" autocomplete="off" placeholder="empty"><input type="range" class="brr" data-tb="brSl" min="0" aria-label="SL distance"></label>
          <label class="omf"><span>TP (pt)</span><input data-tb="brTp" inputmode="decimal" autocomplete="off" placeholder="none"><input type="range" class="brr" data-tb="brTp" min="0" aria-label="TP distance"></label>
          <label class="omcb srwide"><input type="checkbox" data-tb="brDca"> SL / TP follow adds (DCA)</label>
          <div class="tbnote" data-note="br"></div>
        </div>
      </div>
      <div class="csec tb" data-el="sGd" data-sec="gd"><div class="csh">Grid (experimental)<button class="omtgl gdtgl" data-a="gdmode" data-el="gdTgl">OFF</button><b class="sact" data-el="actGd" style="display:none">ACTIVE</b></div>
        <div class="tbb gdb">
                    <label class="omf gdw"><span>Side (entries, or SL / TP at the market price)</span><select data-tb="gdEnSide"><option value="long">LONG</option><option value="short">SHORT</option></select></label><button class="gdgo" data-a="gdstart" data-el="gdStart">START</button><div class="gdsec en"><div class="gdh"><label><input type="checkbox" data-tb="gdEnOn"> Entries</label><span>LIMIT orders from the current price</span><button type="button" class="gdfixb" data-gdfix="En" data-el="gdFixEn" title="Entries measured from the price frozen now instead of the live price">FIX</button><button type="button" class="gdeye" data-gdeye="En" aria-label="Average line on the chart">AVG <svg viewBox="0 0 24 24" width="15" height="15"><path d="M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3.2" fill="currentColor"/><line class="sl" x1="3" y1="21" x2="21" y2="3" stroke="currentColor" stroke-width="2.2"/></svg></button></div><label class="omf"><span>Nearest (pt)</span><input data-tb="gdEnNear" inputmode="decimal" autocomplete="off" placeholder="empty"></label><label class="omf"><span>Farthest (pt)</span><input data-tb="gdEnFar" inputmode="decimal" autocomplete="off" placeholder="= nearest"></label><label class="omf"><span>Levels between</span><input data-tb="gdEnMid" inputmode="decimal" autocomplete="off" placeholder="0"></label><label class="omf"><span>Total size % of max</span><input data-tb="gdEnPct" inputmode="decimal" autocomplete="off" placeholder="empty"></label><label class="omf"><span>Distances</span><select data-tb="gdEnDist"><option value="equal">All equal</option><option value="linear">Linear (growing)</option><option value="invlin">Inverse linear (shrinking)</option><option value="hyper">Hyperbolic (faster at the far end)</option><option value="inv">Inverse hyperbolic (faster at the near end)</option><option value="manual">Manual (slider)</option></select></label><div class="gsl" data-gsl="En" data-gk="Man"><div class="gslh"><span>Levels from nearest ▸ to farthest (5 % steps of the way)</span><button type="button" data-gslinv>⇄ invert</button></div><div class="gbar"></div></div><label class="omf gdw"><span>Sizes</span><select data-tb="gdEnSize"><option value="equal">All equal</option><option value="linear">Linear (growing)</option><option value="invlin">Inverse linear (shrinking)</option><option value="hyper">Hyperbolic (faster at the far end)</option><option value="inv">Inverse hyperbolic (faster at the near end)</option><option value="custom">Custom %</option></select></label><label class="omf gdc" data-gdc="En"><span>Custom % of each level, nearest to farthest</span><input data-tb="gdEnCustom" autocomplete="off" placeholder="e.g. 20, 30, 50"></label><div class="gsl" data-gsl="En" data-gk="Custom"><div class="gslh"><span>Size of each level, nearest ▸ farthest (5 % steps)</span><button type="button" data-gslinv>⇄ invert</button></div><div class="gbar"></div></div></div>
          <div class="gdsec tp"><div class="gdh"><label><input type="checkbox" data-tb="gdTpOn"> Targets (TP)</label><span>on the position, or on the entries waiting</span><button type="button" class="gdfixb" data-gdfix="Tp" data-el="gdFixTp" title="Only with nothing open or waiting (TP at the market price): TP measured from the price frozen now">FIX</button><button type="button" class="gdeye" data-gdeye="Tp" aria-label="Average line on the chart">AVG <svg viewBox="0 0 24 24" width="15" height="15"><path d="M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3.2" fill="currentColor"/><line class="sl" x1="3" y1="21" x2="21" y2="3" stroke="currentColor" stroke-width="2.2"/></svg></button></div><label class="omf"><span>Nearest (pt)</span><input data-tb="gdTpNear" inputmode="decimal" autocomplete="off" placeholder="empty"></label><label class="omf"><span>Farthest (pt)</span><input data-tb="gdTpFar" inputmode="decimal" autocomplete="off" placeholder="= nearest"></label><label class="omf"><span>Levels between</span><input data-tb="gdTpMid" inputmode="decimal" autocomplete="off" placeholder="0"></label><label class="omf"><span>Share of position %</span><input data-tb="gdTpPct" inputmode="decimal" autocomplete="off" placeholder="100"></label><label class="omf gdw"><span>Distances</span><select data-tb="gdTpDist"><option value="equal">All equal</option><option value="linear">Linear (growing)</option><option value="invlin">Inverse linear (shrinking)</option><option value="hyper">Hyperbolic (faster at the far end)</option><option value="inv">Inverse hyperbolic (faster at the near end)</option><option value="manual">Manual (slider)</option></select></label><div class="gsl" data-gsl="Tp" data-gk="Man"><div class="gslh"><span>Levels from nearest ▸ to farthest (5 % steps of the way)</span><button type="button" data-gslinv>⇄ invert</button></div><div class="gbar"></div></div><label class="omf gdw"><span>Sizes</span><select data-tb="gdTpSize"><option value="equal">All equal</option><option value="linear">Linear (growing)</option><option value="invlin">Inverse linear (shrinking)</option><option value="hyper">Hyperbolic (faster at the far end)</option><option value="inv">Inverse hyperbolic (faster at the near end)</option><option value="custom">Custom %</option></select></label><label class="omf gdc" data-gdc="Tp"><span>Custom % of each level, nearest to farthest</span><input data-tb="gdTpCustom" autocomplete="off" placeholder="e.g. 50, 30, 20"></label><div class="gsl" data-gsl="Tp" data-gk="Custom"><div class="gslh"><span>Size of each level, nearest ▸ farthest (5 % steps)</span><button type="button" data-gslinv>⇄ invert</button></div><div class="gbar"></div></div></div>
          <div class="gdsec sl"><div class="gdh"><label><input type="checkbox" data-tb="gdSlOn"> Stops (SL)</label><span>idem</span><button type="button" class="gdfixb" data-gdfix="Sl" data-el="gdFixSl" title="Only with nothing open or waiting (SL at the market price): SL measured from the price frozen now">FIX</button><button type="button" class="gdeye" data-gdeye="Sl" aria-label="Average line on the chart">AVG <svg viewBox="0 0 24 24" width="15" height="15"><path d="M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3.2" fill="currentColor"/><line class="sl" x1="3" y1="21" x2="21" y2="3" stroke="currentColor" stroke-width="2.2"/></svg></button></div><label class="omf"><span>Nearest (pt)</span><input data-tb="gdSlNear" inputmode="decimal" autocomplete="off" placeholder="empty"></label><label class="omf"><span>Farthest (pt)</span><input data-tb="gdSlFar" inputmode="decimal" autocomplete="off" placeholder="= nearest"></label><label class="omf"><span>Levels between</span><input data-tb="gdSlMid" inputmode="decimal" autocomplete="off" placeholder="0"></label><span></span><label class="omf gdw"><span>Distances</span><select data-tb="gdSlDist"><option value="equal">All equal</option><option value="linear">Linear (growing)</option><option value="invlin">Inverse linear (shrinking)</option><option value="hyper">Hyperbolic (faster at the far end)</option><option value="inv">Inverse hyperbolic (faster at the near end)</option><option value="manual">Manual (slider)</option></select></label><div class="gsl" data-gsl="Sl" data-gk="Man"><div class="gslh"><span>Levels from nearest ▸ to farthest (5 % steps of the way)</span><button type="button" data-gslinv>⇄ invert</button></div><div class="gbar"></div></div><label class="omf gdw"><span>Sizes</span><select data-tb="gdSlSize"><option value="equal">All equal</option><option value="linear">Linear (growing)</option><option value="invlin">Inverse linear (shrinking)</option><option value="hyper">Hyperbolic (faster at the far end)</option><option value="inv">Inverse hyperbolic (faster at the near end)</option><option value="custom">Custom %</option></select></label><label class="omf gdc" data-gdc="Sl"><span>Custom % of each level, nearest to farthest</span><input data-tb="gdSlCustom" autocomplete="off" placeholder="e.g. 50, 30, 20"></label><div class="gsl" data-gsl="Sl" data-gk="Custom"><div class="gslh"><span>Size of each level, nearest ▸ farthest (5 % steps)</span><button type="button" data-gslinv>⇄ invert</button></div><div class="gbar"></div></div></div>
          <div class="tbnote" data-note="gd"></div>
        </div>
      </div>
      <div class="csec tb" data-el="sOco" data-sec="oco"><div class="csh">OCO (one cancels the other)<b class="sact" data-el="actOco" style="display:none">ACTIVE</b></div>
        <div class="tbb">
          <label class="omcb srwide"><input type="checkbox" data-tb="ocoOn"> OCO on the pending entries of a market</label>
          <div class="tbnote" data-note="oco"></div>
        </div>
      </div>
      <div class="csec tb" data-el="sSr" data-sec="sr"><div class="csh">Safe runner (experimental)<span class="srtr" data-el="srTr"></span><b class="sact" data-el="actSr" style="display:none">ACTIVE</b><button class="srq" data-a="srhelp" aria-label="How the safe runner works">?</button></div>
        <div class="srhelp" data-el="srHelp" hidden></div>
        <div class="srb">
          <label class="srrow"><span class="srn">Mode<small>OFF nothing · VIEW lines only, no orders · LIVE moves the stop on Vest and closes parts at market</small></span><select data-tb="srMode"><option value="off">OFF</option><option value="view">VIEW</option><option value="live">LIVE</option></select></label>
          <div class="srh">1 · When it takes over</div>
          <label class="srrow"><span class="srn">Start after a profit of (points)<small>until the best price is this far in profit nothing is touched: your own stop stays (none = no stop)</small></span><input data-tb="srAct" inputmode="decimal" autocomplete="off"></label>
          <label class="srrow"><span class="srn">Profit always kept (points)<small>no runner stop ever goes below entry + this (above for a short)</small></span><input data-tb="srLock" inputmode="decimal" autocomplete="off"></label>
          <div class="srh">2 · How the size is split</div>
          <label class="srrow"><span class="srn">Runner share (% of the size)<small>part kept for the long move, with the wide stop</small></span><input data-tb="srRunPct" inputmode="decimal" autocomplete="off"></label>
          <label class="srrow"><span class="srn">Pause-low share (% of the size)<small>part with its stop just under the last pause low of the move; 0 = not used</small></span><input data-tb="srPausePct" inputmode="decimal" autocomplete="off"></label>
          <div class="srsplit" data-el="srSplit"></div>
          <div class="srh">3 · Stop distance from the best price (in ATR = average 1-minute candle range)</div>
          <label class="srrow"><span class="srn">Tight stop distance (ATR)<small>stop of the tight part; 1 = one average 1m candle below the best price</small></span><input data-tb="srTight" inputmode="decimal" autocomplete="off"></label>
          <label class="srrow"><span class="srn">Runner stop distance (ATR)<small>stop of the runner; bigger = it survives deeper pullbacks</small></span><input data-tb="srRunAtr" inputmode="decimal" autocomplete="off"></label>
          <label class="omcb srwide"><input type="checkbox" data-tb="srGate"> Runner wide only when the 1h trend is in favour (otherwise it uses the tight distance)</label>
          <label class="omcb srwide"><input type="checkbox" data-tb="srClimax"> After a very big 1m candle at the top (2.5 ATR or more) tighten the tight and pause-low stops to 60 %</label>
          <div class="tbnote" data-note="sr"></div>
        </div>
      </div>
    </div>
    <div class="cmd" data-el="cmd" style="display:none">
      <div class="cmdh" data-el="cmdh"><span class="ct">Trade commands</span><span class="cph" data-el="cmdPh"></span><span class="ctg" data-el="cmdTg"></span><button class="cdet" data-a="cmdfloat" data-el="cmdDet"></button></div>
      <div class="cmdb" data-el="cmdb"><div class="cmdx" data-el="cmdx"></div></div>
    </div>
  </div>`;
  document.documentElement.appendChild(host);
  for (const el of root.querySelectorAll('[data-el]')) els[el.dataset.el] = el;
  els.layer = root.querySelector('.root');
  els.layer.classList.add('hidden0'); // start: invisible until Vest data are in (main.js reveal)
  // CANCEL menu closes on a press elsewhere: outside the overlay (window sees only the host of the closed shadow root)
  // or inside it but not on the menu or its button
  const menuOpen = () => els.cxm.style.display !== 'none';
  window.addEventListener('pointerdown', (ev) => menuOpen() && ev.target !== host && cxMenu(false), true);
  root.addEventListener('pointerdown', (ev) => {
    if (menuOpen() && !ev.composedPath().some((n) => n === els.cxm || (n.dataset && n.dataset.a === 'cxmenu'))) cxMenu(false);
  }, true);
  // no tooltips on the cards (they cover the rest of the page); the chart labels keep theirs.
  // An observer removes any that draw() might set.
  const noTips = (el) => {
    if (el.hasAttribute && el.hasAttribute('title')) el.removeAttribute('title');
    if (el.querySelectorAll) for (const t of el.querySelectorAll('[title]')) t.removeAttribute('title');
  };
  const tipObs = new MutationObserver((list) => {
    for (const r of list) if (r.type === 'attributes' ? r.target.hasAttribute('title') : r.addedNodes.length) noTips(r.target);
  });
  for (const k of ['card', 'card2', 'card3', 'card4', 'card5']) {
    noTips(els[k]);
    tipObs.observe(els[k], { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });
  }

  // preview while hovering LONG / SHORT (no orders: lines only)
  for (const side of ['long', 'short']) {
    const b = els.card2.querySelector(`button[data-a="${side}"]`);
    b.addEventListener('pointerenter', () => !b.disabled && (hoverSide = side)); // disabled (Risk ON): no AVG / FAIL NEW preview
    b.addEventListener('pointerleave', () => hoverSide === side && (hoverSide = null));
  }
  // TP / SL from the card: they are dragged (a plain click explains how)
  for (const kind of ['tp', 'sl']) {
    const b = els.card2.querySelector(`button[data-a="${kind}"]`);
    b.addEventListener('pointerdown', (e) => {
      if (b.disabled) return;
      const m = getModel();
      if (m && m.gdFar && m.gdFar[kind]) return startDrag(e, b, kind, null, 'card'); // grid on: farthest level of that ladder
      if (!m || !m.pos) return;
      const legs = m.pos.triggers.filter((t) => t.kind === kind);
      if (legs.length > 1) return say(`More than one ${kind.toUpperCase()}: drag the line you want to move`, 'err');
      startDrag(e, b, kind, legs[0] || null, 'card');
    });
  }
  // second card: LIMIT / STOP are dragged; percentage, presets
  for (const kind of ['lm', 'st']) {
    const b = els.card2.querySelector(`button[data-a="${kind}"]`);
    b.addEventListener('pointerdown', (e) => {
      if (b.disabled) return;
      startDrag(e, b, kind, null, 'card2');
    });
  }
  // every button of the cards, wherever it sits (on the chart, in the column or in the floating commands panel)
  root.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    const pp = t.closest('button[data-p]');
    if (pp) {
      actions.setPct(+pp.dataset.p);
      els.pctIn.value = pp.dataset.p;
      return;
    }
    const cx = t.closest('button[data-cx]');
    if (cx) {
      cxMenu(false);
      if (cx.disabled) return;
      const kind = cx.dataset.cx;
      return run(actions.cancelOrders(kind), kind === 'lm' ? 'pending limits cancelled' : kind === 'st' ? 'local stops cancelled' : 'all orders cancelled');
    }
    if (t.closest('[data-a="srhelp"]')) {
      if (els.sSr.classList.contains('folded')) foldSec(els.sSr);
      if (!els.srHelp.innerHTML) els.srHelp.innerHTML = HELP.runner[1];
      els.srHelp.hidden = !els.srHelp.hidden;
      return;
    }
    const sh = t.closest('.csh');
    if (sh && !t.closest('.omtgl')) return foldSec(sh.parentNode);
    const b = t.closest('button[data-a]');
    if (!b || b.disabled) return;
    const a = b.dataset.a;
    if (a === 'flat') run(actions.flat(), 'FLAT sent');
    else if (a === 'orders') actions.toggleOrders();
    else if (a === 'copy' && actions.copyToggle) actions.copyToggle();
    else if (a === 'cxmenu') cxMenu(els.cxm.style.display === 'none');
    else if (a === 'be') run(actions.breakeven(), 'BE sent');
    else if ((a === 'long' || a === 'short') && omLive()) {
      // Active plan: market entry with the plan size, SL and TP
      const m = getModel();
      if (!m || !m.market) return;
      omSide = a;
      omAnchor = null;
      omSave();
      const pl = omOrderPlan(m, a, m.market.mark);
      if (pl instanceof Error) return say(pl.message, 'err');
      run(actions.planEntry('market', a, null, pl), `PLAN ${a.toUpperCase()} sent: ${pl.qty} with SL ${pl.sl}`);
    } else if (a === 'long' || a === 'short') run(actions.market(a), a.toUpperCase() + ' sent');
    else if (a === 'closeall') run(actions.closeAll(), 'CLOSE sent: pending orders stay');
    else if (a === 'close') run(actions.closePct(), 'PARTIAL CLOSE sent');
    else if (a === 'cmdfloat') setFloat(!cmdSt.float);
    else if (a === 'gdmode' && actions.gridMode) actions.gridMode();
    else if (a === 'gdstart' && actions.gridStart) run(actions.gridStart(), 'GRID ACTIVE');
    else if (a === 'omtoggle') {
      // Risk & targets ON: the plan drives Trade commands (the % size is off); OFF = manual
      omMode = omMode === 'manual' ? 'live' : 'manual';
      omAnchor = null;
      omSave();
      if (omMode === 'live' && actions.exclusive) actions.exclusive('risk');
    } else if (a === 'omside' || a === 'ommode') {
      if (a === 'omside' && omSide !== b.dataset.v) omAnchor = null; // the other side starts from the market price (or its LIMIT)
      if (a === 'omside') omSide = b.dataset.v;
      else omMode = b.dataset.v;
      if (omMode === 'manual') omAnchor = null;
      omSave();
    }
  });
  colSetup();
  // COPIER: click on a row = account shown by the tool (on press: the table is redrawn)
  els.card4.addEventListener('pointerdown', (e) => {
    if (e.target.closest('[data-a="copy"]')) return actions.copyToggle && actions.copyToggle();
    const tip = e.target.closest('.sy[data-tip]');
    if (tip) {
      e.stopPropagation();
      return actions.say && actions.say(tip.dataset.tip, tip.dataset.tip.includes('OUT OF SYNC') ? 'warn' : 'info');
    }
    const tr = e.target.closest('tr[data-id]');
    if (tr && actions.select) actions.select(tr.dataset.id);
  });
  els.cpIn.addEventListener('input', () => {
    const v = parseFloat(els.cpIn.value.replace(',', '.'));
    actions.setClosePct(v > 0 ? Math.min(100, v) : 0);
  });
  els.pctIn.addEventListener('input', () => {
    const v = parseFloat(els.pctIn.value.replace(',', '.'));
    actions.setPct(v > 0 ? v : 0);
  });
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape') cxMenu(false);
      if (e.key === 'Escape' && drag) {
        endDrag(false);
        say('Cancelled', '');
      }
    },
    true,
  );
  requestAnimationFrame(frame);
}

// ── docked column (cards in the panel's column) and trade commands panel
// In the column the cards are not scaled copies of the chart block: the same elements are moved into sections that
// follow the column's width (CSS .root.col), and every button goes into the commands panel. That panel sits at the top of
// the column or floats anywhere on the screen (position kept in localStorage 'vt1:cmd'). Back on the chart, every element
// returns to its place (comment placeholders), so the chart layout is the measured one as before.
const CMD_KEY = 'vt1:cmd',
  SEC_KEY = 'vt1:colsec';
const CMD_W_DEF = 360,
  CMD_W_MIN = 260;
let cmdSt = { float: false, x: null, y: null, w: CMD_W_DEF, h: null };
let secFold = {};
let colOn = false;
// Order management (column section): inputs kept in localStorage 'vt1:om'; the chart preview is never kept (off after a reload)
const OM_KEY = 'vt1:om';
let omSt = { sizeBy: 'risk', sizeVal: '', fees: false, stopBy: 'dist', stopVal: '', stops: 'one', split: 'even',
  t: [{ on: true, by: 'r', val: '1' }, { on: false, by: 'r', val: '2' }, { on: false, by: 'r', val: '3' }, { on: false, by: 'trail', val: '' }] };
let omPv = null; // side whose plan is on the chart ('long' | 'short'), null in Manual mode (set at every frame)
// Risk & targets OFF = 'manual' (Trade commands use the % size, nothing on the chart); ON = 'live' (LONG / SHORT / LIMIT / STOP
// go with the plan size and its SL / TP). ('view' is no longer offered.) ON is never kept: after a reload it is OFF.
let omMode = 'manual';
let lastTb = {}; // column section settings as last drawn (safe runner LIVE asks before switching)
let omSide = 'long';
let omBv = null; // bars of the last frame (previous candle, ATR) for the plan sent by LONG / SHORT
// Plan entry on the chart: price where ENTRY was dropped (null = follows the market price, or the pending LIMIT of that side)
let omAnchor = null; // { side, symbol, price, type: 'lm' | 'st' }
let omFill = () => {}; // writes omSt back into the section fields (set in omSetup)
let moves = []; // [element, placeholder]
const readJson = (k, def) => {
  try {
    const v = JSON.parse(localStorage.getItem(k) || 'null');
    return v && typeof v === 'object' ? v : def;
  } catch {
    return def;
  }
};
const writeJson = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* storage blocked: kept for this page only */
  }
};

function colSetup() {
  const c = readJson(CMD_KEY, {});
  cmdSt = {
    float: c.float === true,
    x: Number.isFinite(c.x) ? c.x : null,
    y: Number.isFinite(c.y) ? c.y : null,
    w: Number.isFinite(c.w) ? Math.max(CMD_W_MIN, c.w) : CMD_W_DEF,
    h: Number.isFinite(c.h) && c.h >= 120 ? c.h : null, // null = as tall as its content
  };
  secFold = readJson(SEC_KEY, {});
  omSetup();
  // Account limits: ON / OFF and level of each bar (FLAT when reached); the level is saved, ON is not (OFF after a reload)
  els.card3.addEventListener('click', (e) => {
    const ey = e.target.closest && e.target.closest('button.geye');
    if (ey && actions.guardEye) {
      e.stopPropagation();
      return actions.guardEye(ey.dataset.ek);
    }
    const b = e.target.closest && e.target.closest('button.gon');
    if (!b || !actions.guardToggle) return;
    e.stopPropagation();
    try {
      actions.guardToggle(b.dataset.gk);
    } catch (err) {
      say(err.message, 'err');
    }
  });
  els.card3.addEventListener('input', (e) => {
    const r = e.target;
    if (!r.classList || !(r.classList.contains('gr') || r.classList.contains('gv')) || !actions.guardLevel) return;
    actions.guardLevel(r.dataset.gk, r.value);
  });
  // small arrows next to a number: target values ±0.25 (ticks ±1), chart space ±10 px
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-sp]');
    if (!b) return;
    const inp = b.closest('.omsp').querySelector('input');
    if (!inp || inp.disabled) return;
    const m = /^val(\d)$/.exec(inp.dataset.om || '');
    const by = m && els.sOm.querySelector(`[data-om="by${m[1]}"]`);
    const step = +inp.dataset.step || (by && by.value === 'ticks' ? 1 : 0.25);
    const cur = parseFloat(String(inp.value).replace(',', '.'));
    const lo = inp === els.roomIn ? 50 : step,
      hi = inp === els.roomIn ? 900 : Infinity;
    const base = Number.isFinite(cur) ? cur : inp === els.roomIn ? 360 : 0;
    const v = Math.min(hi, Math.max(lo, Math.round((base + +b.dataset.sp * step) / step) * step));
    inp.value = String(+v.toFixed(2));
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // chart space: now in the main panel (section Chart space, Gerry 2026-11-21)
  // Trailing & breakeven: the panel keeps the settings (same keys); here they are only shown and changed
  const tbSet = (e) => {
    const k = e.target.dataset && e.target.dataset.tb;
    if (!k || !actions.setSetting) return;
    if (k === 'srMode' && e.target.value === 'live' && lastTb.srMode !== 'live') {
      const ok = window.confirm(`Safe runner LIVE (experimental)?

Once the profit reaches "start after", it moves the stop on Vest and closes parts of the position at market by itself (with Orders ON, while this tab is open).
After a reload it comes back as VIEW.`);
      if (!ok) return void (e.target.value = lastTb.srMode || 'off');
    }
    actions.setSetting(k, e.target.type === 'checkbox' ? e.target.checked : e.target.value.trim().replace(',', '.'));
  };
  // same mechanism for three sections: Trailing & breakeven, Bracket, Safe runner (the panel keeps the settings)
  els.sGd.addEventListener('click', (e) => {
    const fb = e.target.closest('[data-gdfix]');
    if (fb) {
      // FIX: entries (or TP / SL at the market price) stop following the price (frozen at the market price now); again =
      // they follow it again. TP / SL: only when they are computed at the market price (nothing open or waiting).
      e.preventDefault();
      const P = fb.dataset.gdfix, k = `gd${P}FixPx`, w = P === 'En' ? 'entries' : P.toUpperCase();
      const cur = getModel();
      const mk = cur && cur.market && cur.market.mark;
      const on = parseFloat((lastTb || {})[k]) > 0;
      if (!on && !(mk > 0)) return say('price not available', 'err');
      if (actions.setSetting) actions.setSetting(k, on ? '' : String(roundToTick(mk, cur.market.tick)));
      return say(on ? `Grid ${w} follow the price again` : `Grid ${w} FIXED at ${roundToTick(mk, cur.market.tick)}${P === 'En' ? '' : ' (only while nothing is open or waiting: then they go on the position / entries)'}`, '');
    }
    const ey = e.target.closest('[data-gdeye]');
    if (ey) {
      e.preventDefault();
      const k = `gd${ey.dataset.gdeye}Avg`;
      return actions.setSetting && actions.setSetting(k, !(lastTb || {})[k]);
    }
    const b = e.target.closest('[data-gslinv]');
    if (!b) return;
    const el = b.closest('.gsl');
    const tb = lastTb || {};
    const P = el.dataset.gsl,
      k = el.dataset.gk;
    const v = gslList(tb[`gd${P}${k}`]);
    if (!v.length) return;
    gslCommit(P, k, k === 'Custom' ? v.reverse() : v.map((x) => 100 - x).reverse());
  });
  els.sGd.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('.gh');
    if (!h) return;
    if (h.classList.contains('lock')) {
      const man = h.closest('.gsl').dataset.gk === 'Man';
      return say(`These follow the curve: set ${man ? 'Distances to Manual (slider)' : 'Sizes to Custom %'} to move them by hand`, '');
    }
    e.preventDefault();
    e.stopPropagation();
    const el = h.closest('.gsl'),
      bar = el.querySelector('.gbar');
    const P = el.dataset.gsl,
      k = el.dataset.gk,
      i = +h.dataset.i;
    const tb = lastTb || {};
    gslDrag = { P, k, vals: gslList(tb[`gd${P}${k}`]) };
    const move = (ev) => {
      const r = bar.getBoundingClientRect();
      let x = Math.round((((ev.clientX - r.left) / r.width) * 100) / GSL_STEP) * GSL_STEP;
      const v = gslDrag.vals.slice();
      if (k === 'Custom') {
        // handle i = border between level i and i+1: the two shares change, the others stay
        const lo = v.slice(0, i).reduce((a, b) => a + b, 0);
        const hi = lo + v[i] + v[i + 1];
        x = Math.min(hi - GSL_STEP, Math.max(lo + GSL_STEP, x));
        v[i] = x - lo;
        v[i + 1] = hi - x;
      } else {
        const lo = i ? v[i - 1] : 0,
          hi = i < v.length - 1 ? v[i + 1] : 100;
        v[i] = Math.min(hi - GSL_STEP, Math.max(lo + GSL_STEP, x));
      }
      gslDrag.vals = v;
      gslDraw(el, tb);
    };
    // on the window: the bar is redrawn while the handle moves (the handle element itself is replaced)
    const W = h.ownerDocument.defaultView || window;
    const up = () => {
      W.removeEventListener('pointermove', move, true);
      W.removeEventListener('pointerup', up, true);
      W.removeEventListener('pointercancel', up, true);
      const d = gslDrag;
      gslDrag = null;
      if (d) gslCommit(d.P, d.k, d.vals);
    };
    W.addEventListener('pointermove', move, true);
    W.addEventListener('pointerup', up, true);
    W.addEventListener('pointercancel', up, true);
  });
  for (const sec of [els.sTb, els.sBr, els.sGd, els.sOco, els.sSr]) {
    sec.addEventListener('input', (e) => e.target.type !== 'checkbox' && e.target.tagName !== 'SELECT' && tbSet(e));
    sec.addEventListener('change', (e) => (e.target.type === 'checkbox' || e.target.tagName === 'SELECT') && tbSet(e));
  }
  for (const sec of els.colw.querySelectorAll('.csec')) sec.classList.toggle('folded', !!secFold[sec.dataset.sec]);
  // where each moved element lives on the chart
  const list = [els.ordl, els.ordc, els.cpl, els.cpc, els.flatB, els.cpBox, els.closeB, els.closeAllB, els.msg, els.card, els.card2, els.card3, els.card4, els.card5];
  moves = list.map((el) => {
    const ph = document.createComment('vt');
    el.before(ph);
    return [el, ph];
  });
  // floating panel: dragged by its title bar
  els.cmdh.addEventListener('pointerdown', (e) => {
    if (!cmdSt.float || e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    const r = els.cmd.getBoundingClientRect();
    const dx = e.clientX - r.left,
      dy = e.clientY - r.top;
    try {
      els.cmdh.setPointerCapture(e.pointerId);
    } catch {
      /* nothing */
    }
    const move = (ev) => {
      cmdSt.x = ev.clientX - dx;
      cmdSt.y = ev.clientY - dy;
      placeCmd();
    };
    const up = () => {
      els.cmdh.removeEventListener('pointermove', move);
      els.cmdh.removeEventListener('pointerup', up);
      els.cmdh.removeEventListener('pointercancel', up);
      writeJson(CMD_KEY, cmdSt);
    };
    els.cmdh.addEventListener('pointermove', move);
    els.cmdh.addEventListener('pointerup', up);
    els.cmdh.addEventListener('pointercancel', up);
  });
  // width of the floating panel (CSS resize handle): kept when the drag of the corner ends
  if (typeof ResizeObserver === 'function') {
    let t = null;
    new ResizeObserver(() => {
      if (!cmdSt.float || !colOn) return;
      const w = Math.round(els.cmd.offsetWidth);
      // height only once dragged from the corner (the browser then sets it inline); otherwise it follows the content
      const h = els.cmd.style.height ? Math.round(els.cmd.offsetHeight) : null;
      if (!(w >= CMD_W_MIN) || (w === cmdSt.w && h === cmdSt.h)) return;
      cmdSt.w = w;
      cmdSt.h = h;
      clearTimeout(t);
      t = setTimeout(() => writeJson(CMD_KEY, cmdSt), 400);
    }).observe(els.cmd);
  }
  syncFloat();
}

const OM_SZ_LABEL = { risk: 'Risk ($)', pct: 'Size (%)', qty: 'Quantity' };
const OM_ST_LABEL = { dist: 'Points', ticks: 'Ticks', bar: 'Beyond it (ticks)', atr: 'ATR multiple' };
function omSetup() {
  const o = readJson(OM_KEY, {});
  const str = (v, d) => (typeof v === 'string' || typeof v === 'number' ? String(v) : d);
  const pick = (v, list, d) => (list.includes(v) ? v : d);
  omSt.sizeBy = pick(o.sizeBy, OM.SIZE_BY, 'risk');
  omSt.sizeVal = str(o.sizeVal ?? o.risk, ''); // o.risk / o.dist / t[].rr: v0.10.70
  omSt.fees = o.fees === true;
  omSt.stopBy = pick(o.stopBy, OM.STOP_BY, 'dist');
  omSt.stopVal = str(o.stopVal ?? o.dist, '');
  omSt.stops = pick(o.stops, ['one', 'each'], 'one');
  omSt.split = pick(o.split, OM.SPLITS, 'even');
  omMode = 'manual'; // Risk & targets ON is never restored after a reload (it drives real orders)
  omSide = pick(o.side, ['long', 'short'], 'long');
  if (Array.isArray(o.t))
    omSt.t = omSt.t.map((d, i) => {
      const x = o.t[i];
      return x ? { on: !!x.on, by: pick(x.by, OM.TGT_BY, 'r'), val: str(x.val ?? x.rr, d.val) } : d;
    });
  const f = (k) => els.sOm.querySelector(`[data-om="${k}"]`);
  const labels = () => {
    els.omSzL.textContent = OM_SZ_LABEL[omSt.sizeBy];
    els.omStL.textContent = OM_ST_LABEL[omSt.stopBy];
    omSt.t.forEach((t, i) => (f('val' + i).disabled = t.by === 'trail'));
  };
  omFill = () => {
    for (const k of ['sizeBy', 'sizeVal', 'stopBy', 'stopVal', 'stops', 'split']) f(k).value = omSt[k];
    f('fees').checked = omSt.fees;
    omSt.t.forEach((t, i) => {
      f('on' + i).checked = t.on;
      f('by' + i).value = t.by;
      f('val' + i).value = t.val;
    });
    labels();
  };
  omFill();
  const read = (e) => {
    const k = e.target.dataset && e.target.dataset.om;
    if (!k) return;
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    const m = /^(on|by|val)(\d)$/.exec(k);
    if (m) omSt.t[+m[2]][m[1]] = v;
    else omSt[k] = v;
    labels();
    omSave();
  };
  els.sOm.addEventListener('input', read);
  els.sOm.addEventListener('change', read);
}

const omNum = (v) => parseFloat(String(v).replace(',', '.'));
const omSave = () => writeJson(OM_KEY, { ...omSt, mode: omMode === 'live' ? 'view' : omMode, side: omSide });

/** Plan to send for a side and entry (Active mode), or an Error with the reason. */
function omOrderPlan(m, side, entry) {
  const x = omPlan(m, side, omBv, entry);
  if (!(x.qty > 0)) return new Error('Risk plan: ' + (x.why || 'no size'));
  if (x.targets.some((t) => t.by !== 'trail' && !Number.isFinite(t.price))) return new Error('Risk plan: ' + (x.why || 'a target has no price'));
  if (x.targets.some((t) => !(t.qty > 0))) return new Error('Risk plan: size too small to split among the targets');
  return { qty: x.qty, sl: x.sl, targets: x.targets.map((t) => ({ price: t.price, qty: t.qty })), each: omSt.stops === 'each' };
}
const omLive = () => colOn && omMode === 'live'; // LONG / SHORT at market with the plan
const omLim = () => colOn && omMode !== 'manual'; // LIMIT placed / moved with the plan (PLAN and READY)
// LIMIT being placed again with the plan: no plan lines until it is on the chart (otherwise they jump to the market price)
let omBusy = null; // { side, price, done, until }
function omRun(p, okText, side, price) {
  const b = { side, price, done: false, until: Infinity };
  omBusy = b;
  run(p, okText);
  p.then(
    () => {
      b.done = true;
      b.until = Date.now() + 4000;
    },
    () => omBusy === b && (omBusy = null),
  );
}
// mode words (internal values kept: 'view' = PLAN, 'live' = READY); ACTIVE is the word of labels of an order really placed
const OM_PHASE = { manual: 'MANUAL', view: 'RISK PLAN', live: 'RISK PLAN' }; // next to Trade commands and on the plan labels (RISK ACTIVE: order really there)
let omActNow = false; // the plan lines shown belong to a pending LIMIT / armed STOP (labels say ACTIVE)
let btnColKey = '';
/** Pending entry LIMIT of that side on this market (the closest to the price), or null. */
function omLimit(m, side) {
  const mark = m.market.mark;
  let best = null;
  for (const o of m.pendings || [])
    if (o.kind === 'lm' && o.label !== 'CLOSE' && !o.local && o.side === side && o.price > 0)
      if (!best || Math.abs(o.price - mark) < Math.abs(best.price - mark)) best = o;
  return best;
}

/** Entry of the plan: ENTRY being dragged > where it was dropped > pending LIMIT of that side > market price. */
/** Side of a NEW LIMIT being dragged from Trade commands (the plan follows it while it moves), or null. */
function omNewLimitSide(m) {
  if (!(drag && !drag.existing && (drag.kind === 'lm' || drag.kind === 'st') && drag.moved && colOn && omMode !== 'manual' && m && m.market)) return null;
  return entrySide(drag.kind, drag.price, m.market.mark) || null;
}
/** Local STOP armed with the plan on the chart's market for that side (one at most). */
function omStop(m, side) {
  return (m.pendings || []).find((o) => o.kind === 'st' && o.local && o.plan && o.side === side) || null;
}
/** Type of the plan entry being shown: 'st' for a STOP (new one dragged, ENTRY set from STOP, armed plan STOP), else 'lm'. */
function omType(e) {
  if (!e) return 'lm';
  if (e.src === 'stop') return 'st';
  if (e.src === 'newlm') return drag && drag.kind === 'st' ? 'st' : 'lm';
  if (e.src === 'set') return omAnchor && omAnchor.type === 'st' ? 'st' : 'lm';
  return 'lm';
}

function omEntry(m, side) {
  if (drag && drag.from === 'plan' && drag.kind === 'lm' && drag.moved && omPv === side) return { price: drag.price, src: 'drag' };
  if (omNewLimitSide(m) === side) return { price: drag.price, src: 'newlm' }; // its own label is the LIMIT being dragged
  if (omAnchor && omAnchor.side === side && omAnchor.symbol === m.market.symbol) return { price: omAnchor.price, src: 'set' };
  const lm = omLimit(m, side);
  if (lm) return { price: drag && drag.from === 'order' && drag.moved && drag.existing.order.id === lm.id ? drag.price : lm.price, src: 'limit', order: lm }; // the plan follows the LIMIT while it is dragged
  const sp = omStop(m, side);
  if (sp) return { price: drag && drag.from === 'order' && drag.moved && drag.existing.order.id === sp.id ? drag.price : sp.price, src: 'stop', order: sp };
  return { price: m.market.mark, src: 'mark' };
}

/** While plan SL is dragged: the size stays, the stop becomes that distance (the risk follows). */
function omSlDrag(side) {
  if (!(drag && drag.from === 'plan' && drag.kind === 'sl' && drag.moved && drag.ok && omPv === side)) return null; // wrong side: plan as before, label marked
  return { stopBy: 'dist', stopVal: Math.abs(drag.existing.entry - drag.price) }; // same risk: the size follows
}

function omPlan(m, side, bv, entry, over) {
  const mk = m.market;
  const o = over || {};
  return OM.plan({
    side,
    entry: entry > 0 ? entry : mk.mark,
    step: mk.step,
    tick: mk.tick,
    maxQty: m.size && m.size.max,
    capPct: o.noCap ? 0 : m.capPct,
    fee: mk.fee,
    sizeBy: o.sizeBy || omSt.sizeBy,
    sizeVal: o.sizeVal ?? omNum(omSt.sizeVal),
    fees: omSt.fees,
    stopBy: o.stopBy || omSt.stopBy,
    stopVal: o.stopVal ?? omNum(omSt.stopVal),
    bar: bv && bv.prev,
    atr: bv && bv.atr14,
    targets: omSt.t.map((t) => ({ on: t.on, by: t.by, val: omNum(t.val) })),
    split: omSt.split,
  });
}

function foldSec(sec) {
  if (!sec || !sec.dataset.sec) return;
  const k = sec.dataset.sec;
  secFold[k] = !secFold[k];
  sec.classList.toggle('folded', secFold[k]);
  writeJson(SEC_KEY, secFold);
}

// moves the elements into the column (on) or back to their places on the chart (off)
function setCol(on) {
  if (on === colOn) return;
  colOn = on;
  els.layer.classList.toggle('col', on);
  if (on) {
    els.cmdTg.append(els.ordl, els.ordc, els.cpl, els.cpc);
    els.cmdb.prepend(els.card2);
    els.cmdx.append(els.cpBox, els.closeB, els.closeAllB, els.flatB);
    show(els.msg, false); // messages go to the panel header
    els.sPos.append(els.card);
    els.sLim.append(els.card3);
    els.sCopy.append(els.card4);
    // under Trade commands, in this order (they float with it): copier, bracket, OCO, safe runner, risk & targets, trailing, account limits
    els.cmd.append(els.sCopy, els.sBr, els.sGd, els.sOco, els.sSr, els.sOm, els.sTb, els.sLim);
    syncFloat();
  } else {
    for (const [el, ph] of moves) ph.after(el);
    show(els.msg, true);
    show(els.colw, false);
    show(els.cmd, false);
  }
}

let panelOpenSent = null;
function syncFloat() {
  els.cmd.classList.toggle('float', cmdSt.float);
  // floating: the column shows the main panel; back in the column: the panel folds to its header (Gerry 2026-11-21)
  if (panelOpenSent !== cmdSt.float && actions.panelOpen) {
    panelOpenSent = cmdSt.float;
    actions.panelOpen(cmdSt.float);
  }
  els.cmdDet.textContent = cmdSt.float ? '⇥' : '⇱';
  els.cmdDet.setAttribute('aria-label', cmdSt.float ? 'Put back in the column' : 'Detach and float');
  if (cmdSt.float) {
    els.layer.append(els.cmd);
    els.cmd.style.width = cmdSt.w + 'px';
    els.cmd.style.height = cmdSt.h ? cmdSt.h + 'px' : '';
    placeCmd();
  } else {
    els.colw.prepend(els.cmd);
    els.cmd.style.width = els.cmd.style.height = els.cmd.style.left = els.cmd.style.top = '';
  }
}

function setFloat(on) {
  cmdSt.float = !!on;
  if (on && cmdSt.x == null) {
    // first time: next to the column, at the top of the chart
    const r = els.cmd.getBoundingClientRect();
    cmdSt.x = Math.max(0, r.left - cmdSt.w - 16);
    cmdSt.y = Math.max(0, r.top);
  }
  syncFloat();
  writeJson(CMD_KEY, cmdSt);
}

// floating panel inside the window (also after a resize of the browser)
function placeCmd() {
  if (!cmdSt.float) return;
  const w = els.cmd.offsetWidth || cmdSt.w;
  const x = Math.round(Math.min(Math.max(0, cmdSt.x || 0), Math.max(0, window.innerWidth - w)));
  const y = Math.round(Math.min(Math.max(0, cmdSt.y || 0), Math.max(0, window.innerHeight - 40)));
  els.cmd.style.left = x + 'px';
  els.cmd.style.top = y + 'px';
}

// CANCEL menu of the second card: closes on a choice, on Esc and on a click elsewhere
function cxMenu(open) {
  if (!els.cxm) return;
  els.cxm.style.display = open ? '' : 'none';
  els.card2.classList.toggle('cxopen', !!open);
  const b = els.card2.querySelector('[data-a="cxmenu"]');
  if (open && b && els.layer && els.layer.classList.contains('col')) {
    // right under CANCEL, at least as wide as it
    const c = els.card2.getBoundingClientRect(),
      r = b.getBoundingClientRect();
    Object.assign(els.cxm.style, { left: `${r.left - c.left}px`, top: `${r.bottom - c.top + 2}px`, minWidth: `${r.width}px`, width: 'auto' });
  }
}

function say(text, kind) {
  if (colOn && actions.say) return actions.say(text, kind); // docked: in the panel header, nothing moves below
  if (!els.msg) return;
  els.msg.textContent = text;
  els.msg.className = 'msg ' + (kind || '');
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => {
    els.msg.textContent = '';
  }, kind === 'err' ? 7000 : 3500);
}

function run(p, okText) {
  p.then(
    () => say(okText, 'ok'),
    (e) => say(e.message, 'err'),
  );
}

// ── geometry
function geometry(found) {
  const chart = found.api.activeChart();
  const frame = found.frame;
  if (!frame || !frame.isConnected) return { why: 'chart iframe missing' };
  let idoc;
  try {
    idoc = frame.contentDocument;
  } catch {
    return { why: 'chart iframe not readable' };
  }
  if (!idoc) return { why: 'chart iframe not readable' };
  hookInput(idoc);
  const scale = readScale(chart);
  if (scale.why) return scale;
  const { vr, paneH, mode } = scale;
  const cached = canvasCache.el;
  const fresh = cached && cached.isConnected && Date.now() - canvasCache.at < 2000 && Math.abs(cached.clientHeight - paneH) <= 2;
  if (fresh) return finish(chart, frame, cached, vr, mode);
  const host = idoc.querySelector('.chart-gui-wrapper');
  const canvas = host ? pickPaneCanvas([...host.querySelectorAll('canvas')], paneH) : null;
  if (!canvas) return { why: 'chart area not found' };
  canvasCache.el = canvas;
  canvasCache.at = Date.now();
  return finish(chart, frame, canvas, vr, mode);
}

/** Right price scale of the main pane: { vr, paneH, mode } (mode 0 linear, 1 log) or { why } when unsupported. */
function readScale(chart) {
  try {
    const pane = chart.getPanes()[0];
    const priceScale = pane.getRightPriceScales()[0];
    if (!priceScale) return { why: 'price scale on the left: not supported' };
    if (typeof priceScale.isInverted === 'function' && priceScale.isInverted()) return { why: 'inverted scale: not supported' };
    const mode = typeof priceScale.getMode === 'function' ? priceScale.getMode() : 0;
    if (mode !== 0 && mode !== 1) return { why: 'percentage scale: not supported' };
    const vr = priceScale.getVisiblePriceRange();
    if (!vr || !(vr.to > vr.from)) return { why: 'price range not readable' };
    return { vr, mode, paneH: typeof pane.getHeight === 'function' ? pane.getHeight() : 0 };
  } catch (e) {
    return { why: 'price scale API missing (' + e.message + ')' };
  }
}

/** Main pane canvas: the widest one as tall as the pane (+-2 px); failing that, the one with the largest area. */
function pickPaneCanvas(canvases, paneH) {
  const sameHeight = paneH > 0 ? canvases.filter((c) => Math.abs(c.clientHeight - paneH) <= 2) : [];
  const widest = sameHeight.reduce((top, c) => (!top || c.clientWidth > top.clientWidth ? c : top), null);
  if (widest && widest.clientWidth > 0) return widest;
  const area = (c) => c.clientWidth * c.clientHeight;
  const largest = canvases.reduce((top, c) => (!top || area(c) > area(top) ? c : top), null);
  return largest && area(largest) > 0 ? largest : null;
}

const canvasCache = { el: null, at: 0 };
function finish(chart, frame, canvas, vr, mode) {
  const ir = frame.getBoundingClientRect(),
    cr = canvas.getBoundingClientRect();
  const g = { left: ir.left + cr.left, top: ir.top + cr.top, width: cr.width, height: cr.height, vr: { from: vr.from, to: vr.to, log: mode === 1 } };
  if (g.width < 320 || g.height < 120) return { why: 'chart too small' };
  g.ts = null;
  try {
    const timeScale = chart.getTimeScale();
    const spacing = Number(timeScale.barSpacing());
    const offsetBars = Number(timeScale.rightOffset());
    const tsWidth = Number(timeScale.width());
    if (spacing > 0 && tsWidth > 0 && Number.isFinite(offsetBars)) {
      const k = g.width / tsWidth; // time-scale px -> canvas CSS px
      // centre of the last candle: right edge, minus the empty bars on the right, minus half a bar (and the 1 px border)
      const lastCenter = tsWidth - 1 - spacing * (offsetBars + 0.5);
      g.lastX = lastCenter * k;
      g.ts = { ts: timeScale, bs: spacing, ro: offsetBars, k };
    }
  } catch {
    /* no time scale: fixed free area on the right */
  }
  return g;
}

function hookInput(idoc) {
  if (hookedDocs.has(idoc)) return;
  hookedDocs.add(idoc);
  const touch = () => (lastTouch = Date.now());
  for (const t of ['pointerdown', 'wheel', 'keydown']) idoc.addEventListener(t, touch, { capture: true, passive: true });
}

/** Right margin of the chart: enough for the cards, only with the last candle on screen and the chart still. */
// CSS width of the widest label in the previous pass (used for the trailing segments)
let chipW = 0,
  frameChipW = 0,
  chipKey = '',
  chipShrinkAt = 0;
const CHIP_SHRINK_MS = 30000;
function manageRoom(g, show, needPx, minPx = CANDLE_RIGHT) {
  if (!g || !g.ts) return;
  const { ts, bs, ro } = g.ts;
  const idle = !drag && Date.now() - lastTouch > ROOM_IDLE_MS;
  try {
    if (show) {
      // margin (in bars) that puts the last candle exactly at the wanted distance: set in BOTH directions
      // (even if it had been left wider), only while the chart is still and the last candle is on screen
      const px = Math.max(minPx, needPx || 0);
      const want = Math.max(0, (px / (g.ts.k || 1) - 1) / bs - 0.5);
      if (!idle || ro < 0 || Math.abs(ro - want) < 0.3) return;
      if (!room) room = { orig: ro, set: want };
      room.set = want;
      ts.setRightOffset(want);
    } else if (room && idle) {
      if (Math.abs(ro - room.set) < 0.5) ts.setRightOffset(room.orig); // restore only if nobody changed it
      room = null;
    }
  } catch {
    /* no setRightOffset: the cards overlap the last candles */
  }
}

// ── drawing
const show = (el, on) => (el.style.display = on ? '' : 'none');

// clipX: if the line would run over the cards, it stops 4 px before their column
/** Label style from the panel (Chart lines and labels); empty values leave the card style's. */
function chipStyle(chip, ls, L) {
  const key = ls.c + JSON.stringify(L || null);
  if (chip.dataset.cs === key) return;
  chip.dataset.cs = key;
  chip.style.setProperty('--kc', (L && L.n) || ls.c); // name (S, AVG ALL, TP...) in its colour, else the line's
  chip.style.background = (L && L.bg) || '';
  chip.style.borderColor = (L && L.bo) || '';
  chip.style.borderWidth = L && L.bw != null ? L.bw + 'px' : '';
  chip.style.fontSize = L && L.fs ? L.fs + 'px' : '';
  chip.classList.toggle('knb', !!(L && L.nb));
  if (L && L.nb) chip.style.setProperty('--knb', L.nb);
  chip.classList.toggle('kfw-b', !!(L && L.fw === 'b'));
  chip.classList.toggle('kfw-n', !!(L && L.fw === 'n'));
}

/** Line style on an element drawn with a top border (segments): dash-dot is drawn as a repeating gradient. */
function borderLine(el, ls) {
  const dd = ls.s === 'dashdot';
  el.style.borderTop = dd ? '0' : `${ls.w}px ${ls.s} ${ls.c}`;
  el.style.height = dd ? ls.w + 'px' : '';
  el.style.background = dd ? `repeating-linear-gradient(90deg, ${ls.c} 0 8px, transparent 8px 11px, ${ls.c} 11px 13px, transparent 13px 16px)` : '';
}

function hline(el, g, y, st, clipX) {
  el.style.left = g.left + 'px';
  el.style.width = (clipX ? Math.max(0, clipX - g.left - 4) : g.width) + 'px';
  // line centred on the price even when thick
  el.style.top = g.top + y - (el.classList.contains('grab') ? GRAB_HALF : 0) - Math.floor((st.w - 1) / 2) + 'px';
  if (el.dataset.st !== st.c + st.s + st.w) {
    el.dataset.st = st.c + st.s + st.w;
    el.classList.toggle('dd', st.s === 'dashdot');
    el.style.setProperty('--c', st.c);
    el.style.setProperty('--s', st.s === 'dashdot' ? 'solid' : st.s);
    el.style.setProperty('--w', st.w + 'px');
  }
}

function frame() {
  requestAnimationFrame(frame);
  try {
    draw();
  } catch (e) {
    state = { visible: false, why: 'errore: ' + e.message, posId: null };
    hideAll();
  }
}

function clearLegs() {
  for (const { line, chip, lead } of legEls.values()) {
    line.remove();
    chip.remove();
    if (lead) lead.remove();
  }
  legEls.clear();
}

function hideAll() {
  if (!els.card) return;
  show(els.card, false);
  show(els.card2, false);
  show(els.card3, false);
  show(els.card4, false);
  show(els.card5, false);
  if (els.colw) show(els.colw, false);
  if (els.cmd) show(els.cmd, false);
  show(els.dragLine, false);
  show(els.dragChip, false);
  for (const k of ['trS', 'trA', 'trN', 'trB', 'trT', 'hlH', 'hlL']) show(els[k], false);
  clearLegs();
  if (drag) endDrag(false);
}

let lastWhy = null;
const QUIET = new Set(['chart market not recognised', 'overlay off', 'chart not found']);
function setState(s) {
  state = s;
  if (s.why !== lastWhy) {
    if (s.why && !QUIET.has(s.why)) log.warn('Trade overlay: ' + s.why);
    lastWhy = s.why;
  }
}

const heat = (f) => (f >= 1 ? 'hot' : f >= 0.8 ? 'warn' : ''); // same as the main panel
// why no size, in the few characters next to the % box (the full reason is in the panel's Trade section)
const shortWhy = (why) =>
  !why ? '' : /minimum/.test(why) ? 'too low' : /margin/.test(why) ? 'no margin' : /leverage/.test(why) ? 'no leverage' : /not read/.test(why) ? 'reading…' : 'n/a';
const sideWord = (side) => (side === 'long' ? 'BUY' : 'SELL');

let idleAt = 0;
function draw() {
  const m = getModel();
  const active = enabled && m && m.found && m.market;
  if (!active && Date.now() - idleAt < 500) return; // nothing to draw: one check every half second is enough
  idleAt = Date.now();
  if (!m || !m.found) {
    hideAll();
    setState({ visible: false, why: 'chart not found', posId: null });
    return;
  }
  const g = geometry(m.found);
  if (g.why) {
    hideAll();
    setState({ visible: false, why: g.why, posId: null });
    return;
  }
  if (!active) {
    hideAll();
    manageRoom(g, false); // overlay off or unknown market: the chart margin goes back to what it was
    setState({ visible: false, why: enabled ? 'chart market not recognised' : 'overlay off', posId: null });
    return;
  }
  const { market, pos } = m;
  const { mark, tick, priceDec } = market;
  const yOf = (p) => G.priceToY(p, g.vr, g.height);
  // P&L at that price of all accounts holding the trade (same market and side), only when there are at least two
  const allPos = m.allPos || [];
  const sumAll = (price) => {
    if (allPos.length < 2) return '';
    const v = allPos.reduce((t, p) => t + pnlUsd(p.side, p.qty, p.openPrice, price), 0);
    return `<span class="sig" title="P&L at this price of all ${allPos.length} accounts holding the position (each one's full size and own entry)">Σ${allPos.length} <b class="${F.cls(v)}">${F.usd(v, true)}</b></span>`;
  };
  const inside = (y) => y >= 0 && y <= g.height;
  lineStyles = m.lineStyles || null;
  // colours of every label (price, profit, loss): only when chosen in the panel, otherwise the card style's
  {
    const cc = m.chartCommon || {};
    for (const [k, v] of Object.entries(cc)) {
      if (v) els.layer.style.setProperty('--' + k, v);
      else els.layer.style.removeProperty('--' + k);
      els.layer.classList.toggle(k, !!v);
    }
  }
  if (m.btnColors) {
    const k = JSON.stringify(m.btnColors);
    if (k !== btnColKey) {
      btnColKey = k;
      for (const [n, v] of Object.entries(m.btnColors)) els.layer.style.setProperty(n, v);
    }
  }
  const qs = m.qtyStyle || { c: '#ffb402', s: 11, b: true };
  if (els.layer.dataset.qs !== qs.c + qs.s + qs.b) {
    els.layer.dataset.qs = qs.c + qs.s + qs.b;
    els.layer.style.setProperty('--qc', qs.c);
    els.layer.style.setProperty('--qs', qs.s + 'px');
    els.layer.style.setProperty('--qw', qs.b ? 800 : 400);
  }
  // cards in the docked column (m.cardsCol = part of the column under the folded panel; hidden while the panel is open):
  // fluid sections at the panel's size, no scale. Otherwise next to the price axis at the panel's scale.
  const col = m.cardsCol && m.cardsCol.width > 0 ? m.cardsCol : null;
  setCol(!!col);
  // card style from the panel: 'sonar' / 'console' only change colours and fonts (overlay.css), never positions;
  // in the column they also colour the section frames
  for (const t of ['sonar', 'console']) if (els.layer.classList.contains(t) !== (m.theme === t)) els.layer.classList.toggle(t, m.theme === t);
  const SCALE = col ? 1 : scaleOf(m.blockPct, 125);
  if (col) {
    const cw = els.colw.style;
    if (cw.left !== col.left + 'px') cw.left = col.left + 'px';
    if (cw.top !== col.top + 'px') cw.top = col.top + 'px';
    if (cw.width !== col.width + 'px') cw.width = col.width + 'px';
    if (cw.height !== col.height + 'px') cw.height = col.height + 'px';
    show(els.colw, !col.hidden);
    show(els.cmd, cmdSt.float || !col.hidden); // floating: stays on the screen while the panel is open
    if (cmdSt.float) placeCmd();
  }
  const CS = scaleOf(m.chipPct, 100);
  if (els.layer.dataset.sc !== SCALE + '/' + CS) {
    els.layer.dataset.sc = SCALE + '/' + CS;
    els.layer.style.setProperty('--bs', SCALE);
    els.layer.style.setProperty('--cs', CS);
  }
  // cardX: left edge of the cards. areaX: right edge of the labels' column (the cards' left edge, or the chart's edge
  // minus the swing-line gap when the cards are in the docked column)
  const cardX = col ? 0 : g.left + g.width - CARD_RIGHT - CARD_W * SCALE;
  const areaX = col ? g.left + g.width - CARD_RIGHT : cardX;
  // widest label width kept: it grows at once, shrinks only after 30 s or when the market/position changes
  const key = market.symbol + '|' + (pos ? pos.id : '');
  if (key !== chipKey) {
    chipKey = key;
    chipW = frameChipW;
    chipShrinkAt = 0;
  } else if (frameChipW >= chipW) {
    chipW = frameChipW;
    chipShrinkAt = 0;
  } else if (!chipShrinkAt) chipShrinkAt = Date.now() + CHIP_SHRINK_MS;
  else if (Date.now() > chipShrinkAt) {
    chipW = frameChipW;
    chipShrinkAt = 0;
  }
  frameChipW = 0;
  // FIXED right margin: cards + space chosen in the panel, independent of the label width (otherwise the chart jumps
  // left and right). Labels wider than the space cover the last candles.
  const room = +m.roomPx >= ROOM_MIN && +m.roomPx <= ROOM_MAX ? +m.roomPx : ROOM_DEF;
  const needPx = Math.round(CARD_RIGHT + (col ? 0 : CARD_W * SCALE) + room);
  manageRoom(g, true, needPx, col ? 0 : CANDLE_RIGHT); // in the column no cards on the chart: only the chosen space

  const eb = m.eqBar || {};
  els.acc.textContent = eb.account || '';

  // ── main card
  show(els.card, true);
  const sideKey = pos ? pos.side : 'flat';
  if (els.side.dataset.side !== sideKey) {
    els.side.dataset.side = sideKey;
    // small arrow next to LONG/SHORT; the instrument is at the top left
    els.sideTxt.innerHTML = pos ? pos.side.toUpperCase() + (pos.side === 'long' ? ARROW_UP : ARROW_DOWN) : '';
  }
  // clock next to the instrument (local time zone), corrected to Vest's clock once known; rewritten when the second changes
  const clk = new Date(bars.serverNow()).toLocaleTimeString('it-IT', { hour12: false });
  if (els.clk.textContent !== clk) els.clk.textContent = clk;
  // candles of the chart's timeframe: countdown to the close of the current one, last swing high / low
  let bv = null;
  try {
    bv = bars.view(m.found.api.activeChart(), m.hlK, mark, m.atrOn ? { hours: m.atrH, recent: m.atrR } : null);
  } catch {
    bv = null;
  }
  const cdt = m.cdOn && bv ? bv.left : '';
  if (els.cd.textContent !== cdt) els.cd.textContent = cdt;
  // chart timeframe at the top left (the instrument as a fallback)
  const tfName = (bv && bv.tf) || market.label;
  if (els.sym.textContent !== tfName) els.sym.textContent = tfName;
  // points realised today, number only
  {
    const P = m.points;
    const tot = P ? P.closed + P.open : NaN;
    const t = Math.abs(tot) < 0.005 ? 0 : tot;
    els.dpt.textContent = Number.isFinite(tot) ? `${t > 0 ? '+' : t < 0 ? '−' : ''}${Math.abs(t).toFixed(2)} pt` : '';
    els.dpt.className = 'dpt ' + F.cls(t);
  }
  const mic = pos ? microOf(pos.qty, market.label, market.symbol) : null;
  // linear contracts: P&L = size x points, so the size is also the $ value of one point
  // from $10 per point upwards no cents: the row is narrow
  const ppt = pos && pos.qty > 0 ? `${pos.qty >= 10 ? '$' + Math.round(pos.qty) : F.usd(pos.qty)}/pt` : '';
  els.mic.innerHTML = [mic ? `${mic.qty.toFixed(2)} ${mic.name}` : '', ppt ? `<i>${ppt}</i>` : ''].filter(Boolean).join(' ');
  if (pos) {
    els.card.className = 'card ' + pos.side;
    els.qty.textContent = F.qty(pos.qty); // without the symbol
    const pnl = mark > 0 ? pnlUsd(pos.side, pos.qty, pos.openPrice, mark) : NaN;
    els.pnl.textContent = F.usd(pnl, true);
    // narrow right column: very long amounts in a smaller font
    els.pnl.className = 'pnl ' + F.cls(pnl) + (els.pnl.textContent.length >= 9 ? ' xs' : '');
    els.entry.textContent = '$' + F.priceG(pos.openPrice, priceDec);
    // gap in points from the trade's side: positive = in favour (same sign and colour as the P&L)
    const gap = mark > 0 ? (pos.side === 'long' ? 1 : -1) * (mark - pos.openPrice) : NaN;
    els.gap.textContent = Number.isFinite(gap) ? (gap > 0 ? '+' : gap < 0 ? '−' : '') + Math.abs(gap).toFixed(priceDec) + ' pt' : '—';
    els.gap.className = 'gap ' + F.cls(gap);
  } else {
    // when flat: market on the left
    els.card.className = 'card flat';
    els.pnl.textContent = ''; // the instrument is already at the top left
    els.pnl.className = 'pnl';
    els.gap.textContent = ''; // when flat nothing instead of the points
    els.gap.className = 'gap';
    els.qty.textContent = 'flat';
    els.entry.textContent = ''; // when flat no leverage
  }
  // docked column: the position data go to the panel header (Position section no longer shown)
  if (actions.head) {
    actions.head(
      col
        ? {
            tf: els.sym.textContent,
            cd: els.cd.textContent,
            clk: els.clk.textContent,
            acc: els.acc.textContent,
            side: pos ? pos.side : 'flat',
            qty: pos ? els.qty.textContent : '',
            entry: els.entry.textContent,
            gap: els.gap.textContent,
            gapC: els.gap.className.replace('gap', '').trim(),
            pnl: els.pnl.textContent,
            pnlC: els.pnl.className.replace(/\b(pnl|xs)\b/g, '').trim(),
            mic: els.mic.textContent,
            dpt: els.dpt.textContent,
            dptC: els.dpt.className.replace('dpt', '').trim(),
            trades: m.points ? { n: m.points.n, win: m.points.win, loss: m.points.loss } : null,
          }
        : null,
    );
  }
  els.ordc.textContent = m.ordersOn ? 'ON' : 'OFF';
  els.ordc.classList.toggle('on', !!m.ordersOn);
  // COPY under ORDERS: only when a master and at least one copy are assigned
  // ORDERS / COPY now live in the panel header (v0.20.26): hidden here
  show(els.ordl, false);
  show(els.ordc, false);
  show(els.cpl, false);
  show(els.cpc, false);
  if (m.copy) {
    els.cpc.textContent = m.copy.armed ? 'ON' : 'OFF';
    els.cpc.classList.toggle('on', !!m.copy.armed);
  }
  const busy = !!m.busy;
  els.flatB.disabled = busy; // FLAT always active: it also cancels pending orders
  els.closeB.disabled = busy || !pos || !(m.closePct > 0);
  if (root.activeElement !== els.cpIn) {
    const want = m.closePct > 0 ? String(m.closePct) : '';
    if (els.cpIn.value !== want) els.cpIn.value = want;
  }
  els.closeAllB.disabled = busy || !pos;
  for (const k of ['tp', 'sl', 'be']) els.card2.querySelector(`[data-a="${k}"]`).disabled = busy || !(pos || (k !== 'be' && m.gdFar && m.gdFar[k]));
  const beB = els.card2.querySelector('[data-a="be"]'),
    beT = m.bePlus ? 'BE+' : 'BE';
  if (beB.textContent !== beT) {
    beB.textContent = beT;
  }
  // ── card block: centred vertically in the chart (does not follow the price)
  show(els.card2, true);
  show(els.card3, true);
  // ── third card: margin (positions only / with pending orders) and risk, as in the main panel
  const rk = m.risk || {};
  const bar = (t, f, frac, html) => {
    const v = Number.isFinite(frac) ? Math.max(0, frac) : 0;
    els[f].style.width = Math.min(100, v * 100).toFixed(1) + '%';
    els[f].className = heat(v);
    els[t].innerHTML = html;
  };
  bar('m1t', 'm1f', rk.marginPos, Number.isFinite(rk.marginPos) ? `<b>${Math.round(rk.marginPos * 100)}%</b>` : '—');
  bar('m2t', 'm2f', rk.marginAll, Number.isFinite(rk.marginAll) ? `<b>${Math.round(rk.marginAll * 100)}%</b> · ${rk.maxQty > 0 ? F.qty(rk.maxQty) + ' ' + F.esc(market.label) + ' left' : 'no free margin'}` : '—');
  const used = Math.max(0, rk.used || 0),
    left = rk.left;
  const rf = left > 0 || used > 0 ? used / (used + Math.max(0, left)) : 0;
  // drawdown colour bands: in profit green, up to 50% yellow, up to 75% orange, beyond red.
  // The same class colours bar and figures.
  const zone = (f, profit) => (profit ? 'zg' : !(f > 0) ? '' : f <= 0.5 ? 'zy' : f <= 0.75 ? 'zo' : 'zr');
  const zrk = zone(rf, rk.upnl > 0);
  bar('rkt', 'rkf', rf, Number.isFinite(left) ? `<b class="${zrk}">${F.usd(used)}</b> of <b class="${zrk}">${F.usd(used + Math.max(0, left))}</b>` : '—');
  els.rkf.className = zrk;
  // account limits as on Vest's page: used / available
  const lim = m.limits || {};
  // DAILY PROFIT TARGET: today's P&L against the goal set in the panel
  const dg = m.dailyGoal;
  bar('dgt', 'dgf', dg > 0 ? lim.dayPl / dg : NaN, Number.isFinite(lim.dayPl) ? `<b class="${F.cls(lim.dayPl)}">${F.usd(lim.dayPl, true)}</b> / ${dg > 0 ? F.usd(dg) : 'goal?'}` : '—');
  els.dgf.className = 'goal';
  // one number (what is left) and a bar that grows towards the fail level, with the colour bands
  const tank = (t, f, l, left, limit, name, manual) => {
    els[l].textContent = limit > 0 ? `${name} (${F.usd(limit)}${manual ? ' manual' : ''})` : name;
    const frac = limit > 0 && Number.isFinite(left) ? 1 - Math.max(0, left) / limit : NaN;
    const z = zone(frac, left > limit);
    bar(t, f, frac, Number.isFinite(left) ? `<b class="${z}">${F.usd(left)}</b>` : '—');
    els[f].className = z;
  };
  tank('ddt', 'ddf', 'ddl', lim.dayLeft, lim.dayLimit, 'DAILY DRAWDOWN BUFFER', lim.dayManual);
  tank('dmt', 'dmf', 'dml', lim.maxLeft, lim.maxLimit, 'MAX DRAWDOWN BUFFER');
  // DAILY LOSS LIMIT: today's loss against the level set (or the daily loss limit when no level)
  {
    const gl = m.guards && m.guards.dl;
    const ref = gl && gl.level > 0 ? gl.level : lim.dayLimit;
    const loss = Number.isFinite(lim.dayPl) ? Math.max(0, -lim.dayPl) : NaN;
    const zl = zone(ref > 0 ? loss / ref : NaN, lim.dayPl > 0);
    bar('dlt', 'dlf', ref > 0 ? loss / ref : NaN, Number.isFinite(loss) ? `<b class="${zl}">${F.usd(loss)}</b> / ${ref > 0 ? F.usd(ref) : '—'}` : '—');
    els.dlf.className = zl;
  }
  // CURRENT PROFIT: open profit of this market against the slider's range
  {
    const gc = m.guards && m.guards.cp;
    const cap = gc && gc.cap > 0 ? gc.cap : NaN;
    const pr = Math.max(0, rk.upnl || 0);
    bar('cpt2', 'cpf', cap > 0 ? pr / cap : NaN, cap > 0 ? `<b class="${pr > 0 ? 'zg' : ''}">${F.usd(pr)}</b> of ${F.usd(cap)}` : `<b>${F.usd(pr)}</b>`);
    els.cpf.className = 'zg';
  }
  guardRows(m);
  bar('tgt', 'tgf', lim.goal > 0 ? lim.pl / lim.goal : NaN, lim.goal > 0 && Number.isFinite(lim.pl) ? `<b class="${F.cls(lim.pl)}">${F.usd(lim.pl, true)}</b> / ${F.usd(lim.goal)}` : 'no target');
  els.tgf.className = 'goal';
  {
    const tl = lim.goalManual ? 'ACCOUNT PROFIT TARGET (manual)' : 'ACCOUNT PROFIT TARGET';
    if (els.tgl.textContent !== tl) els.tgl.textContent = tl;
  }
  // on-screen heights = CSS size x SCALE (offsetHeight ignores the transform)
  const ch = (els.card.offsetHeight || 106) * SCALE,
    h2 = (els.card2.offsetHeight || 92) * SCALE,
    h3 = (els.card3.offsetHeight || 260) * SCALE;
  // copier accounts card, under the third: only when a master and at least one copy are assigned
  const cp = m.copy;
  show(els.card4, !!cp);
  let h4 = 0;
  if (cp) {
    const td = (v) => `<td class="${F.cls(v)}">${F.usd(v, true)}</td>`;
    const tq = (q, side) => `<td class="q ${side === 'long' ? 'up' : side === 'short' ? 'down' : ''}">${q > 0 ? F.qty(q) : '—'}</td>`;
    // no Session column: in practice the same as Today
    // sync status of each copy against the master on this market (title = the reason)
    const SY = { ok: '✓', off: '·', offdiff: '!', small: 'S', limit: 'L', missing: '!', extra: '!', side: '!' };
    // no tooltips on the cards: the text goes to the panel header on a click (data-tip), the row is NOT selected
    const sy = (r) => (r.sync ? ` <b class="sy ${r.sync.k}" data-tip="${F.esc((r.label || r.num) + ': ' + r.sync.text)}">${SY[r.sync.k] || '?'}</b>` : '');
    // the account active on Vest (the one the tool's buttons trade on): highlighted row + tag; red when the copier is ON and it is
    // not the master (entries refused there) (Gerry 2026-11-23)
    const selTag = (r) => {
      if (r.id !== m.selected) return '';
      const bad = cp.armed && !r.master;
      return ` <b class="act${bad ? ' bad' : ''}" title="${bad ? 'Active on Vest, but the copier is ON and this is not the master: the tool refuses new entries here. Select the master on Vest.' : 'Active on Vest: the buttons of the tool trade on this account'}">◀ ACTIVE</b>`;
    };
    const row = (r) => `<tr data-id="${F.esc(r.id)}" class="${r.id === m.selected ? 'sel' + (cp.armed && !r.master ? ' bad' : '') : ''}"><td><i class="adot ${r.act || 'unk'}"></i>${F.esc(r.num || r.label)}${r.master ? ' <i>M</i>' : ''}${r.mult > 0 && !r.master ? ` <b class="cmx" title="Copy size = master size x ${+r.mult}">x${F.mult(r.mult)}</b>` : ''}${sy(r)}${selTag(r)}</td>${tq(r.qty, r.side)}${td(r.upnl)}${td(r.dayPnl)}${td(r.totalPnl)}</tr>`;
    const html =
      '<colgroup><col class="c0"><col class="c1"><col class="c2"><col class="c3"><col class="c4"></colgroup>' +
      `<tr class="h"><th><span class="cpt">${cp.dry ? '<b class="sy test" title="Copier in TEST MODE: nothing is sent to the copies">TEST MODE</b>' : 'ACCOUNT'}</span></th><th>Qty</th><th>Open</th><th>Today</th><th>Total</th></tr>` +
      cp.rows.map(row).join('') +
      `<tr class="t"><td>Total</td>${tq(cp.tot.qty, null)}${td(cp.tot.upnl)}${td(cp.tot.dayPnl)}${td(cp.tot.totalPnl)}</tr>`;
    if (els.cpt.dataset.h !== html) {
      els.cpt.dataset.h = html;
      els.cpt.innerHTML = html;
    }
    h4 = ((els.card4.offsetHeight || 100) + CARD2_GAP) * SCALE;
  }
  // fifth card: points between the last swing high and low, and volatility on 1h ... 1m over the same hours
  const c5 = !col && !!(m.hlOn || m.atrOn); // docked column: no swing range / volatility (Gerry 2026-11-21)
  // swing range: shown in the main panel's Swing range section (Gerry 2026-11-23)
  if (actions.swing) {
    const hl = m.hlOn && bv ? bv.hl : null;
    const gp = hl && Number.isFinite(hl.h) && Number.isFinite(hl.l) ? hl.h - hl.l : NaN;
    actions.swing(!m.hlOn ? 'Off: no swing lines on the chart.' : Number.isFinite(gp) ? `SWING RANGE ${F.price(gp, priceDec)} pt (high ${F.price(hl.h, priceDec)}, low ${F.price(hl.l, priceDec)})` : 'SWING RANGE: reading candles…');
  }
  show(els.card5, c5);
  let h5 = 0;
  if (c5) {
    show(els.swRow, m.hlOn);
    show(els.atrRow, m.atrOn);
    show(els.hm, m.atrOn);
    const hl = bv && bv.hl;
    const gapPts = hl && Number.isFinite(hl.h) && Number.isFinite(hl.l) ? hl.h - hl.l : NaN;
    const sw = Number.isFinite(gapPts) ? F.price(gapPts, priceDec) + ' pt' : '—';
    if (els.swg.textContent !== sw) els.swg.textContent = sw;
    if (m.atrOn) {
      const hd = `last ${m.atrR} candles vs last ${m.atrH} h`;
      if (els.atrHd.textContent !== hd) els.atrHd.textContent = hd;
      const lvl = (r) => (!Number.isFinite(r) ? '' : r < 0.75 ? 'calm' : r < 1.25 ? 'norm' : r < 1.75 ? 'hot' : 'xhot');
      const cells = ((bv && bv.mtf) || []).map((c) =>
        c.ok
          ? `<div class="hc ${lvl(c.ratio)}"><b>${c.label}</b><span>${c.ratio.toFixed(2)}×</span><i>${F.price(c.atr, priceDec)}${c.full ? '' : '*'}</i></div>`
          : `<div class="hc na"><b>${c.label}</b><span>—</span><i>&nbsp;</i></div>`,
      );
      const hm = cells.length ? cells.join('') : '<div class="hm-na">reading candles…</div>';
      if (els.hm.dataset.h !== hm) {
        els.hm.dataset.h = hm;
        els.hm.innerHTML = hm;
      }
    }
    h5 = ((els.card5.offsetHeight || 80) + CARD2_GAP) * SCALE;
  }
  // on the chart: centred on the pane; in the column: from its top (y relative to g.top like the rest)
  const by = col ? 0 : Math.max(0, Math.round((g.height - (2 * CARD2_GAP * SCALE + ch + h2 + h3 + h4 + h5)) / 2));
  const cy = by,
    c2y = cy + ch + CARD2_GAP * SCALE,
    c3y = c2y + h2 + CARD2_GAP * SCALE;
  els.card.style.left = cardX + 'px';
  els.card.style.top = g.top + cy + 'px';
  els.card2.style.left = cardX + 'px';
  els.card2.style.top = g.top + c2y + 'px';
  els.card3.style.left = cardX + 'px';
  els.card3.style.top = g.top + c3y + 'px';
  els.card4.style.left = cardX + 'px';
  els.card4.style.top = g.top + c3y + h3 + CARD2_GAP * SCALE + 'px';
  els.card5.style.left = cardX + 'px';
  els.card5.style.top = g.top + c3y + h3 + CARD2_GAP * SCALE + h4 + 'px';
  if (col) {
    // column sections follow their cards (copier only when on)
    show(els.sCopy, !!cp);
  }
  if (root.activeElement !== els.pctIn) {
    const want = m.pct > 0 ? String(m.pct) : '';
    if (els.pctIn.value !== want) els.pctIn.value = want;
  }
  const sz = m.size || {};
  els.sz.textContent = sz.qty > 0 ? F.qty(sz.qty) : shortWhy(sz.why); // no text without an account; .sz: quantity style, without the symbol
  els.sz.className = 'sz' + (sz.qty > 0 ? '' : ' why');
  // with "%" and in ascending order
  [...(m.presets || PRESETS)].sort((a, b) => a - b).forEach((p, i) => {
    const b = els.card2.querySelector('button.p' + i);
    if (!b || b.dataset.p === String(p)) return;
    b.dataset.p = String(p);
    b.textContent = p + '%';
    b.classList.toggle('sm', String(p).length > 2); // "2.5", "100": smaller font to fit the button
  });
  for (const b of els.card2.querySelectorAll('button.pp')) b.classList.toggle('on', +b.dataset.p === +m.pct);
  // Risk & targets PLAN / READY: the % size is not used; LIMIT / STOP set the plan ENTRY,
  // LONG / SHORT at market only in ACTIVE (with the plan)
  const omOn = !!col && omMode !== 'manual';
  for (const b of els.card2.querySelectorAll('button.pp')) b.disabled = omOn;
  els.pctIn.disabled = omOn;
  els.card2.querySelector('[data-a="lm"]').disabled = busy || (!omOn && !(sz.qty > 0));
  els.card2.querySelector('[data-a="st"]').disabled = busy || (!omOn && !(sz.qty > 0));
  // LONG / SHORT: add in the position's direction, CUT in the opposite one (never beyond the position: no reversal)
  for (const s of ['long', 'short']) {
    const b = els.card2.querySelector(`[data-a="${s}"]`);
    const cut = pos && pos.side !== s;
    b.disabled = busy || omOn || !(sz.qty > 0); // Risk ON: market entries only from START on the MARKET label
    if (b.disabled && hoverSide === s) hoverSide = null;
  }
  const pend = m.pendings || [];
  const nLm = pend.filter((x) => !x.local).length,
    nSt = pend.filter((x) => x.local).length;
  els.card2.querySelector('[data-a="cxmenu"]').disabled = !(nLm + nSt);
  if (!(nLm + nSt)) cxMenu(false);
  els.cxLm.disabled = !nLm;
  els.cxSt.disabled = !nSt;
  els.cxAll.disabled = !(nLm + nSt);
  els.cxLm.textContent = `Pending limits (${nLm})`;
  els.cxSt.textContent = `Local stops (${nSt})`;
  els.cxAll.textContent = `All orders (${nLm + nSt})`;

  // ── lines with labels: position SL/TP (draggable) and pending orders (with X to cancel)
  const items = [];
  // open position: entry line with its label (read-only: closed with FLAT / LONG / SHORT / X)
  if (pos) items.push({ id: 'pos:' + pos.id, kind: pos.side, price: pos.openPrice, entry: pos });
  // fail price: where the equity reaches the drawdown limit (read-only)
  // average entry if all entry limits fill (read-only)
  // only when it averages 2 or more entries (a single LIMIT and no position: the average is the LIMIT itself, Gerry 2026-11-23)
  if (m.avg && m.avg.avg > 0 && m.avg.parts > 1) items.push({ id: 'avg', kind: 'avg', price: m.avg.avg, avgL: m.avg });
  // average entry with the open position and only the next limit
  if (m.avg && m.avg.next && m.avg.next.avg > 0) items.push({ id: 'avg1', kind: 'avg1', price: m.avg.next.avg, avgL: m.avg, one: true });
  if (m.ko && m.ko.price > 0) items.push({ id: 'ko', kind: 'ko', price: m.ko.price, ko: m.ko });
  // drawdown levels (25 / 50 / 75 % by default, set in the panel)
  for (const [i, h] of (m.ddLv || []).entries()) if (h && h.price > 0) items.push({ id: 'dd50:' + i, kind: 'dd50', price: h.price, dd50: h });
  // Account limits switched ON: where each one fires on this market (read-only, "USER" = a limit set by you)
  for (const u of m.userLines || []) items.push({ id: 'usr:' + u.k, kind: 'usr', price: u.price, usr: u });
  // Grid: one line per level (PLAN: nothing sent; ACTIVE: the SL / TP are on Vest). Draggable; START on the nearest one in PLAN.
  gdNow.clear();
  if (m.tb && m.tb.gdOn) {
    const gl = [...((m.gridEn && m.gridEn.legs) || []), ...((m.grid && m.grid.tp) || []), ...((m.grid && m.grid.sl) || [])];
    const go = null; // START only in the section (Gerry 2026-11-23)
    // nearest / farthest = the first / last level DRAWN of each ladder: a level below the minimum size is merged into the
    // next one, so the first one drawn can be level 2 (Gerry 2026-11-23: TP1 / SL1 could not be dragged)
    const lo = {}, hi = {};
    for (const l of gl) {
      lo[l.kind] = Math.min(lo[l.kind] ?? Infinity, l.i);
      hi[l.kind] = Math.max(hi[l.kind] ?? -Infinity, l.i);
    }
    for (const l of gl) {
      const id = `gd:${l.kind}:${l.n}`;
      const dp = drag && drag.from === 'gd' && drag.moved && drag.existing.id === id ? drag.price : l.price;
      const P = l.kind === 'en' ? 'En' : l.kind === 'tp' ? 'Tp' : 'Sl';
      const isLo = l.i === lo[l.kind], isHi = l.i === hi[l.kind];
      const end = !(l.of > 2) || isLo || isHi; // nearest / farthest drawn
      // which end it moves: the real one if it is level 1 / last, else the nearest drawn moves Nearest, the farthest Farthest
      const which = l.i === 0 ? 'near' : l.i === l.of - 1 ? 'far' : isLo && !isHi ? 'near' : isHi && !isLo ? 'far' : isLo ? 'near' : '';
      const mov = end || m.tb[`gd${P}Dist`] === 'manual';
      // other = the other end drawn: it stays where it is while this one is dragged
      gdNow.set(id, { ...l, mov, which: end ? which : '', other: which === 'near' ? hi[l.kind] : which === 'far' ? lo[l.kind] : -1 });
      items.push({ id, kind: 'gd' + l.kind, sk: end && l.of > 1 ? 'gd' + l.kind + 'E' : '', price: dp, gd: l, gdGo: l === go, gdLive: !!m.gdLive, gdEnd: end, gdMov: mov });
    }
    // average price and total size of each ladder (eye in the section). Entries: with the open position on the same side.
    const avgOf = (legs) => {
      const q = legs.reduce((a, l) => a + l.qty, 0);
      return q > 0 ? { price: legs.reduce((a, l) => a + l.price * l.qty, 0) / q, qty: q, usd: legs.reduce((a, l) => a + (l.usd || 0), 0) } : null;
    };
    const en = (m.gridEn && m.gridEn.legs) || [];
    if (m.tb.gdEnAvg && en.length > 1) {
      const a = avgOf(en);
      const p = pos && pos.qty > 0 && pos.side === en[0].side ? pos : null;
      const q = a.qty + (p ? p.qty : 0);
      items.push({ id: 'gd:avg:en', kind: 'gdavg', price: p ? (a.price * a.qty + p.openPrice * p.qty) / q : a.price, gdAvg: { k: 'ENTRY', qty: q, usd: NaN, withPos: !!p, n: en.length } });
    }
    for (const k of ['tp', 'sl']) {
      const legs = (m.grid && m.grid[k]) || [];
      if (!m.tb[k === 'tp' ? 'gdTpAvg' : 'gdSlAvg'] || legs.length < 2) continue;
      const a = avgOf(legs);
      if (a) items.push({ id: 'gd:avg:' + k, kind: 'gdavg', price: a.price, gdAvg: { k: k.toUpperCase(), qty: a.qty, usd: a.usd, n: legs.length } });
    }
  }
  const pv = hoverSide && m.preview && m.preview[hoverSide];
  // the FAIL NEW label always exists (invisible without hover): the space on the right already holds it and the chart does not
  // jump the first time LONG / SHORT is hovered
  const okPv = (p) => (p && p.ko && p.ko.price > 0 ? p : null);
  const pvRes = okPv(pv) || (m.preview && (okPv(m.preview.long) || okPv(m.preview.short)));
  if (pvRes) items.push({ id: 'pv:mfp', kind: 'mfp', price: pvRes.ko.price, pv: pvRes, ghost: !okPv(pv) });
  if (pv && pv.adding) items.push({ id: 'pv:avg', kind: 'avgn', price: pv.avg, pv, pvAvg: true });
  if (pos) for (const t of pos.triggers) if (!(m.gdHide && m.gdHide[t.kind])) items.push({ id: t.id, kind: t.kind, price: t.price, leg: t });
  if (pos) for (const r of m.sr || []) items.push({ id: r.key, kind: 'sr', price: r.price, sr: r });
  // BRACKET of the pending entries (Gerry 2026-11-21: "non mi visualizza i rispettivi SL e TP"), read-only, only with no position:
  //  - Vest LIMIT: the legs Vest holds on its size-0 placeholder when it lists them, else the bracket distances from the limit;
  //  - local LIMIT / STOP: the bracket distances from its price (the real legs are computed from the price at the fill).
  brGhosts.length = 0;
  if (!pos && m.tb && m.tb.brOn && +m.tb.brSl > 0 && !omLive()) {
    const bsl0 = +m.tb.brSl,
      btp0 = +m.tb.brTp;
    const real = m.phLegs && m.phLegs.length ? m.phLegs : null;
    brNow.clear();
    const now = Date.now();
    for (const [k, h] of brHold) if (now > h.until) brHold.delete(k);
    const seenHold = new Set();
    const dragPx = (id, px) => (drag && drag.from === 'br' && drag.moved && drag.existing.id === id ? drag.price : px);
    for (const o of m.pendings || []) {
      if (o.label === 'CLOSE' || !(o.price > 0)) continue;
      const d = o.side === 'long' ? 1 : -1;
      const ov = o.local && o.br ? o.br : {}; // distances dragged for this local entry
      const bsl = ov.sl > 0 ? ov.sl : bsl0,
        btp = ov.tp > 0 ? ov.tp : btp0;
      const sub = `${o.local ? (o.lim ? 'local LIMIT' : 'local STOP') : 'LIMIT'} ${o.side === 'long' ? 'BUY' : 'SELL'} ${F.price(o.price, priceDec)}`;
      // a drop just made on this entry: its new SL / TP are drawn at once, until the feed shows them (no jump back, no gap)
      const hk = o.side + '|' + o.price;
      const h = brHold.get(hk);
      if (h) seenHold.add(hk);
      const legs = []; // { id, k, price, vest, fixed, own, held }
      let cur;
      if (!o.local && real) {
        const sls = real.filter((l) => l.kind === 'sl'),
          tps = real.filter((l) => l.kind === 'tp');
        const one = sls.length <= 1 && tps.length <= 1; // several partial legs: shown, not draggable
        cur = { sl: sls.length ? sls[0].price : NaN, tp: tps.length ? tps[0].price : NaN };
        for (const l of real) legs.push({ id: 'br:' + o.id + ':' + l.id, k: l.kind, price: l.price, vest: true, fixed: !one });
      } else {
        cur = { sl: roundToTick(o.price - d * bsl, tick, d > 0 ? 'down' : 'up'), tp: btp > 0 ? roundToTick(o.price + d * btp, tick, d > 0 ? 'up' : 'down') : NaN };
        legs.push({ id: 'br:' + o.id + ':sl', k: 'sl', price: cur.sl, own: ov.sl > 0 });
        if (cur.tp > 0) legs.push({ id: 'br:' + o.id + ':tp', k: 'tp', price: cur.tp, own: ov.tp > 0 });
      }
      if (h) {
        const same = (x, y) => (Number.isFinite(x) ? Math.abs(x - y) < tick / 2 : !Number.isFinite(y));
        if (same(h.sl, cur.sl) && same(h.tp, cur.tp)) brHold.delete(hk); // the feed has it now
        else {
          cur = { sl: h.sl, tp: h.tp };
          legs.length = 0;
          legs.push({ id: 'br:' + o.id + ':sl', k: 'sl', price: h.sl, own: true, held: true });
          if (h.tp > 0) legs.push({ id: 'br:' + o.id + ':tp', k: 'tp', price: h.tp, own: true, held: true });
        }
      }
      for (const l of legs) {
        items.push({ id: l.id, kind: 'br', price: dragPx(l.id, l.price), br: { k: l.k, ref: o.price, side: o.side, sub, vest: !!l.vest, fixed: !!l.fixed, own: !!l.own, held: !!l.held } });
        if (!l.fixed) brNow.set(l.id, { o, k: l.k, price: l.price, cur });
      }
    }
    // Vest LIMIT being placed again (cancel + new order): the old one is gone from the feed for a moment, drawn as before
    for (const [hk, h] of brHold) {
      if (seenHold.has(hk) || h.local) continue;
      const o = h.o;
      const sub = `LIMIT ${o.side === 'long' ? 'BUY' : 'SELL'} ${F.price(o.price, priceDec)}`;
      brGhosts.push(o);
      items.push({ id: 'br:' + o.id + ':sl', kind: 'br', price: h.sl, br: { k: 'sl', ref: o.price, side: o.side, sub, own: true, held: true } });
      if (h.tp > 0) items.push({ id: 'br:' + o.id + ':tp', kind: 'br', price: h.tp, br: { k: 'tp', ref: o.price, side: o.side, sub, own: true, held: true } });
    }
  }
  // Trailing & breakeven: fields follow the panel's settings (not while typing in them)
  if (col && m.tb) {
    lastTb = m.tb;
    // bracket sliders: 0 .. about 2 % of the price (rounded up to 1 / 2 / 5 x 10^n), wider if the value is already beyond it
    if (m.market && m.market.mark > 0) {
      const nice = (v) => {
        const p = Math.pow(10, Math.floor(Math.log10(v)));
        return (v / p <= 1 ? 1 : v / p <= 2 ? 2 : v / p <= 5 ? 5 : 10) * p;
      };
      for (const r of els.sBr.querySelectorAll('input.brr')) {
        const v = +m.tb[r.dataset.tb] || 0;
        const mx = String(nice(Math.max(m.market.mark * 0.02, v * 1.2, 1)));
        if (r.max !== mx) r.max = mx;
        const tk = m.market.tick > 0 ? m.market.tick : 0;
        const st = String(tk ? Math.max(tk, Math.round(5 / tk) * tk) : 5); // Gerry 2026-11-21: sliders in steps of 5 points
        if (r.step !== st) r.step = st;
      }
    }
    for (const el of [els.sTb, els.sBr, els.sGd, els.sOco, els.sSr].flatMap((s) => [...s.querySelectorAll('[data-tb]')])) {
      if (root.activeElement === el) continue;
      const v = m.tb[el.dataset.tb];
      if (el.type === 'checkbox') {
        if (el.checked !== !!v) el.checked = !!v;
      } else if (el.value !== String(v ?? '')) el.value = String(v ?? '');
    }
    for (const c of els.sGd.querySelectorAll('[data-gdc]')) show(c, false); // the slider replaces the text (kept: same setting)
    for (const el of els.sGd.querySelectorAll('.gsl')) gslDraw(el, m.tb);
    for (const ey of els.sGd.querySelectorAll('[data-gdeye]')) ey.classList.toggle('off', !m.tb[`gd${ey.dataset.gdeye}Avg`]);
    for (const P of ['En', 'Tp', 'Sl']) {
      const b = els['gdFix' + P];
      const fx = parseFloat(m.tb[`gd${P}FixPx`]);
      const fxt = fx > 0 ? `FIXED ${Fmt.price(fx, m.market ? m.market.priceDec : 2)}` : 'FIX';
      if (b.textContent !== fxt) b.textContent = fxt;
      b.classList.toggle('on', fx > 0);
    }
    const gtx = m.gdLive ? 'ACTIVE' : m.tb.gdOn ? 'PLAN' : 'OFF';
    if (els.gdTgl.textContent !== gtx) {
      els.gdTgl.textContent = gtx;
      els.gdTgl.classList.toggle('plan', gtx === 'PLAN');
      els.gdTgl.classList.toggle('on', gtx === 'ACTIVE');
    }
    const stx = m.gdLive ? 'ACTIVE' : 'START';
    if (els.gdStart.textContent !== stx) els.gdStart.textContent = stx;
    els.gdStart.classList.toggle('on', !!m.gdLive);
    els.gdStart.disabled = !m.tb.gdOn || !!m.gdLive;
    const n = m.tb.note || {};
    if (els.tbNote.textContent !== (n.text || '')) els.tbNote.textContent = n.text || '';
    els.tbNote.classList.toggle('warn', !!n.warn);
    {
      // tight share = what is left after runner and pause low (as core/runner.js engineCfg)
      const pc = (v, d) => Math.min(100, Math.max(0, v === '' || v == null || !Number.isFinite(+v) ? d : +v));
      const run = pc(m.tb.srRunPct, 33),
        pau = pc(m.tb.srPausePct, 0),
        tig = Math.max(0, 100 - run - pau);
      const tx = `Tight part = the rest: ${+tig.toFixed(2)} %. Each part is rounded down to the minimum size, what is left goes to the runner (at the minimum size there is only the runner).`;
      if (els.srSplit.textContent !== tx) els.srSplit.textContent = tx;
    }
    const tr = m.tb.srTrend || {};
    const tw = tr.dir === 'up' ? '1h ▲ LONG' : tr.dir === 'down' ? '1h ▼ SHORT' : '';
    if (els.srTr.textContent !== tw) els.srTr.textContent = tw;
    els.srTr.className = 'srtr ' + (tr.dir || '');
    els.srTr.title = tr.text || '';
    for (const el of root.querySelectorAll('[data-note]')) {
      const x = (m.tb.notes && m.tb.notes[el.dataset.note]) || {};
      if (el.textContent !== (x.text || '')) el.textContent = x.text || '';
      el.classList.toggle('warn', !!x.warn);
    }
  }
  // Risk & targets: plan for both sides in the column section, lines only for the side being shown (no orders)
  if (col) {
    omBv = bv;
    omPv = omMode === 'manual' ? null : omNewLimitSide(m) || omSide;
    const tg = omMode === 'manual' ? 'OFF' : 'ON';
    activeTags(m);
    if (els.omTgl.textContent !== tg) {
      els.omTgl.textContent = tg;
      els.omTgl.classList.toggle('on', tg === 'ON');
    }
    els.cmd.classList.toggle('plan', omMode !== 'manual');
    const en = { long: omEntry(m, 'long'), short: omEntry(m, 'short') };
    // ACTIVE: an order of the plan is really there (pending LIMIT / armed local STOP) or the position is open
    const evNow = omPv && en[omPv];
    const actNow = omMode !== 'manual' && (!!pos || !!(evNow && (evNow.src === 'limit' || evNow.src === 'stop')));
    // next to Trade commands: MANUAL, RISK PLAN (plan drives the orders, nothing placed yet) or RISK ACTIVE
    const ph = omMode === 'manual' ? 'MANUAL' : actNow ? 'RISK ACTIVE' : 'RISK PLAN';
    if (els.cmdPh.textContent !== ph) {
      els.cmdPh.textContent = ph;
      els.cmdPh.className = 'cph ' + (omMode === 'manual' ? 'manual' : actNow ? 'act' : 'view');
    }
    const pl = { long: omPlan(m, 'long', bv, en.long.price, omSlDrag('long')), short: omPlan(m, 'short', bv, en.short.price, omSlDrag('short')) };
    const fp = (v) => F.price(v, priceDec);
    const tgTxt = (t) => (t.by === 'trail' ? `T${t.n} trailing ×${F.qty(t.qty)}` : Number.isFinite(t.price) ? `T${t.n} <b>${fp(t.price)}</b> ×${F.qty(t.qty)}` : `T${t.n} —`);
    const sideTxt = (s) => {
      const x = pl[s];
      if (!(x.qty > 0)) return `<div><i class="${s === 'long' ? 'up' : 'down'}">${s.toUpperCase()}</i> <span class="warn">${F.esc(x.why || '')}</span></div>`;
      const t = x.targets.map(tgTxt).join(' · ');
      const e = en[s];
      const from = e.src === 'limit' ? `LIMIT <b>${fp(e.price)}</b>` : e.src === 'stop' ? `local STOP <b>${fp(e.price)}</b>` : e.src === 'mark' ? 'market' : `${omType(e) === 'st' ? 'STOP ' : ''}entry <b>${fp(e.price)}</b>`;
      return `<div><i class="${s === 'long' ? 'up' : 'down'}">${s.toUpperCase()}</i> ${from} · size <b class="q">${F.qty(x.qty)}</b> · SL <b>${fp(x.sl)}</b> · risk <b class="down">${F.usd(x.riskUsd)}</b>${t ? '<br>' + t : ''}</div>`;
    };
    const L = pl.long, S2 = pl.short;
    const notes = [];
    if (L.capped || S2.capped) notes.push(`<div class="warn">size cut to the size cap (${m.capPct}%)</div>`);
    const w = (L.qty > 0 && L.why) || (S2.qty > 0 && S2.why);
    if (w) notes.push(`<div class="warn">${F.esc(w)}</div>`);
    const nT = L.targets.length || S2.targets.length;
    if (omSt.stops === 'each' && nT > 1) notes.push(`<div class="note">Stops: one per target (${nT}), each with its target's size.</div>`);
    const ev = omPv && en[omPv];
    const mk = m.market.mark;
    const evSt = omType(ev) === 'st';
    if (ev && ev.src !== 'mark' && mk > 0 && !evSt && (omPv === 'long' ? ev.price > mk : ev.price < mk))
      notes.push(`<div class="warn">${omPv.toUpperCase()} entry ${omPv === 'long' ? 'above' : 'below'} the price: a LIMIT there fills at once (it would be a STOP entry)</div>`);
    if (ev && ev.src !== 'mark' && mk > 0 && evSt && (omPv === 'long' ? ev.price < mk : ev.price > mk))
      notes.push(`<div class="warn">${omPv.toUpperCase()} STOP entry ${omPv === 'long' ? 'below' : 'above'} the price: it would trigger at once (it would be a LIMIT entry)</div>`);
    if (ev && ev.src === 'stop')
      notes.push('<div class="note">Plan STOP is LOCAL: it lives in this browser tab. When the price touches it, it sends a market order with the plan size, SL and TP. Reload, tab closed or Orders off = gone.</div>');
    const pq = omPv && pl[omPv].qty;
    if (ev && ev.src === 'limit' && pq > 0 && Math.abs(ev.order.qty - pq) > 1e-9)
      notes.push(`<div class="warn">The LIMIT on the chart has size ${F.qty(ev.order.qty)}, the plan ${F.qty(pq)}: move the LIMIT or plan SL and it is placed again with the plan.</div>`);
    else if (ev && ev.src === 'limit' && pq > 0) notes.push('<div class="note">The LIMIT on the chart has the plan size.</div>');
    if (ev && ev.src === 'limit') {
      // SL / TP read from Vest (size-0 position Vest keeps for the pending LIMIT), not the plan lines
      const lg = m.phLegs;
      const one = (l) => `${l.kind.toUpperCase()} <b>${fp(l.price)}</b>${l.qty > 0 ? ' ×' + F.qty(l.qty) : ''}`;
      if (lg && lg.length)
        notes.push(`<div class="note">On Vest this LIMIT holds: ${lg.filter((l) => l.kind === 'sl').map(one).join(', ') || '<b class="warn">no SL</b>'} · ${lg.filter((l) => l.kind === 'tp').map(one).join(', ') || 'no TP'}</div>`);
      else if (lg) notes.push('<div class="warn">The data Vest sends shows no SL / TP for this LIMIT (they may appear only when it fills): check the order on Vest. The plan lines are drawn here.</div>');
      else notes.push('<div class="note">Vest does not say which SL / TP this LIMIT holds: the plan lines are drawn here from the plan.</div>');
    }
    if (omBusy) notes.push('<div class="note">Placing the LIMIT with the new plan…</div>');
    if (ev && ev.src === 'set') {
      const what = evSt ? 'arm the local STOP' : 'place the LIMIT';
      notes.push(`<div class="note">Press START on its label to ${what} with this plan.</div>`);
    }
    const modeTxt =
      omMode === 'manual'
        ? 'Manual: Trade commands use the % size, nothing on the chart.'
        : omMode === 'view'
          ? 'PLAN: a LIMIT or STOP dragged from Trade commands only sets the plan ENTRY (nothing is sent): READY on its label, then START, places it with the plan size, SL and TP; its lines then say ACTIVE. A pending LIMIT moved (or its plan SL) is placed again with the plan. LONG / SHORT at market still use the % size.'
          : '<b class="act">RISK ON</b>: the % size and the LONG / SHORT buttons are off. START on the MARKET label sends the plan size WITH its SL and TP at market (real order, Orders ON); a dragged LIMIT or STOP moves the entry there, START on its label places it (the STOP is local, in this tab). Only on a market with no position and no pending order.';
    const html = (omMode === 'manual' ? '' : sideTxt('long') + sideTxt('short') + notes.join('')) + `<div class="note">${modeTxt}</div>`;
    if (els.omOut.dataset.h !== html) {
      els.omOut.dataset.h = html;
      els.omOut.innerHTML = html;
    }
    const lev = m.size && m.size.lev > 0 ? m.size.lev + '×' : '—';
    if (els.omLev.textContent !== lev) els.omLev.textContent = lev;
    els.omL.classList.toggle('on', omSide === 'long');
    els.omS.classList.toggle('on', omSide === 'short');
    if (omBusy && omBusy.done) {
      const lmNow = omLimit(m, omBusy.side);
      if ((lmNow && Math.abs(lmNow.price - omBusy.price) < tick / 2) || pos || Date.now() > omBusy.until) omBusy = null;
    }
    const hideLines = !!pos || !!omBusy; // after the entry the real SL / TP are on the chart; while the LIMIT is placed again, nothing
    const x = !hideLines && omPv && pl[omPv];
    const e = !hideLines && omPv && en[omPv];
    omActNow = !!(e && (e.src === 'limit' || e.src === 'stop'));
    // ENTRY: only when the entry is not already a LIMIT on the chart (then the LIMIT line is the entry)
    if (e && e.src !== 'limit' && e.src !== 'stop' && e.src !== 'newlm' && e.price > 0)
      items.push({ id: 'om:entry', kind: 'lm', price: e.price, om: { k: `${e.src === 'mark' ? 'MARKET' : omType(e) === 'st' ? 'STOP' : 'LIMIT'} ${omPv === 'long' ? 'LONG' : 'SHORT'}`, qty: x && x.qty > 0 ? x.qty : NaN, usd: NaN, drag: true, entry: true, go: e.src === 'set' || e.src === 'mark', back: e.src === 'set' } });
    if (x && x.qty > 0) {
      items.push({ id: 'om:sl', kind: 'sl', price: drag && drag.from === 'plan' && drag.kind === 'sl' && drag.moved ? drag.price : x.sl, om: { k: `${omPv === 'long' ? 'LONG' : 'SHORT'} SL`, qty: x.qty, usd: -x.riskUsd, drag: true, entry: e.price } });
      for (const t of x.targets)
        if (Number.isFinite(t.price)) {
          const name = t.by === 'r' ? `${t.val}R` : t.by === 'atr' ? `${t.val}×ATR` : t.by === 'ticks' ? `${t.val}t` : '';
          items.push({ id: 'om:t' + t.n, kind: 'tp', price: t.price, om: { k: `T${t.n}${name ? ' ' + name : ''}`, qty: t.qty, usd: t.reward } });
        }
    }
  }
  for (const o of m.pendings || []) items.push({ id: 'o:' + o.id, kind: o.kind, price: o.price, order: o });
  for (const o of brGhosts) if (!items.some((i) => i.id === 'o:' + o.id)) items.push({ id: 'o:' + o.id, kind: o.kind, price: o.price, order: o, held: true });
  const seen = new Set();
  planNow.clear();
  items.sort((a, b) => b.price - a.price); // top to bottom: labels stack without overlapping
  const placed = []; // [top, bottom] of the labels already placed
  for (const it of items) {
    seen.add(it.id);
    let le = legEls.get(it.id);
    if (!le) {
      le = { line: document.createElement('div'), chip: document.createElement('div'), html: '' };
      const omDrag = !!(it.om && it.om.drag); // ENTRY and plan SL: dragged, nothing sent
      const ro = it.entry || it.ko || it.dd50 || it.usr || it.gdAvg || it.avgL || it.pv || it.sr || (it.br && it.br.fixed) || (it.om && !omDrag); // (also AVG NEXT, the FAIL NEW preview, the plan targets) read-only: no drag, no X
      le.line.className = ro ? 'hl entry' : 'hl grab';
      le.chip.className = 'chip ' + it.kind + (ro ? ' pos' : '') + (it.om ? ' plan' : '');
      const id = it.id;
      // label and line are grabbed the same way: dragging moves the level, the X cancels/removes
      const grab = (el) => (e) => {
        const cur = getModel();
        if (!cur) return;
        if (id === 'om:entry' && e.target.closest('.x')) {
          e.preventDefault();
          e.stopPropagation();
          omAnchor = null;
          return say('Plan ENTRY back to the market price', '');
        }
        if (id === 'om:entry' && e.target.closest('.go')) {
          e.preventDefault();
          e.stopPropagation();
          return omSend();
        }
        if (id === 'om:entry' || id === 'om:sl') {
          const p = planNow.get(id);
          if (!p) return;
          return startDrag(e, el, id === 'om:sl' ? 'sl' : 'lm', { id, price: p.price, entry: p.entry, qty: p.qty }, 'plan');
        }
        if (id.startsWith('gd:')) {
          const l = gdNow.get(id);
          if (!l) return;
          if (e.target.closest('.go')) {
            e.preventDefault();
            e.stopPropagation();
            return actions.gridStart && run(actions.gridStart(), 'GRID ACTIVE');
          }
          if (!l.mov) return say('Levels in between follow the curve: move the nearest or the farthest, or set Distances to Manual (slider)', '');
          return startDrag(e, el, l.kind === 'en' ? 'lm' : l.kind, { id, price: l.price, gd: l }, 'gd');
        }
        if (id.startsWith('br:')) {
          const b = brNow.get(id);
          if (!b) return;
          return startDrag(e, el, b.k, { id, price: b.price, order: b.o, cur: b.cur }, 'br');
        }
        if (id.startsWith('o:')) {
          const o = (cur.pendings || []).find((x) => 'o:' + x.id === id);
          if (!o) return;
          if (e.target.closest('.x')) {
            e.preventDefault();
            e.stopPropagation();
            return askCancel(o);
          }
          if (o.label === 'CLOSE') return say('Closing order: it cannot be moved from here (cancel it and place it again)', 'err');
          return startDrag(e, el, o.kind, { id: o.id, price: o.price, order: o }, 'order');
        }
        const leg = cur.pos && cur.pos.triggers.find((x) => x.id === id);
        if (!leg) return;
        if (e.target.closest('.x')) {
          e.preventDefault();
          e.stopPropagation();
          return askRemove(leg);
        }
        startDrag(e, el, leg.kind, leg, 'leg');
      };
      if (!ro) {
        le.chip.addEventListener('pointerdown', grab(le.chip));
        le.line.addEventListener('pointerdown', grab(le.line));
      } else if (it.entry) {
        // position X: closes 100% leaving pending orders (two clicks, as for removing the STOP)
        le.chip.addEventListener('pointerdown', (e) => {
          if (!e.target.closest('.x')) return;
          e.preventDefault();
          e.stopPropagation();
          askClosePos(id);
        });
      }
      le.lead = document.createElement('div');
      le.lead.className = 'lead';
      els.layer.appendChild(le.line);
      els.layer.appendChild(le.lead);
      els.layer.appendChild(le.chip);
      legEls.set(it.id, le);
    }
    const goneUntil = removing.get(it.id);
    if (goneUntil && Date.now() < goneUntil) {
      show(le.lead, false);
      show(le.line, false); // removal/cancel sent: hidden at once, comes back if Vest refuses it
      show(le.chip, false);
      continue;
    }
    let html, price;
    if (it.om) {
      price = it.price;
      const om = it.om;
      if (om.drag) planNow.set(it.id, { price, entry: om.entry === true ? price : om.entry, qty: om.qty });
      const dragging = !!(drag && drag.from === 'plan' && drag.existing.id === it.id && drag.moved);
      html = `<span class="ph ${omActNow ? 'act' : 'view'}">${omActNow ? 'RISK ACTIVE' : 'RISK PLAN'}</span><span class="k">${om.k}</span><b>${F.price(price, priceDec)}</b>${om.qty > 0 ? `<span>${F.qty(om.qty)}</span>` : ''}${Number.isFinite(om.usd) ? `<span class="${F.cls(om.usd)}">${F.usd(om.usd, true)}</span>` : ''}` +
        (om.go ? `<span class="go live">START</span>${om.back ? '<span class="x">✕</span>' : ''}` : '');
      le.chip.classList.toggle('drag', dragging);
      le.chip.classList.toggle('bad', !!(dragging && !drag.ok));
      le.chip.classList.toggle('act', omActNow); // order of the plan really there: black label
    } else if (it.pvAvg) {
      const P = it.pv;
      price = P.avg;
      html = `<span class="k">AVG NEW</span><b>${F.price(price, priceDec)}</b><span class="qy">${F.qty(P.qty)}</span>`;
      le.chip.title = `New average entry if ${P.side === 'long' ? 'LONG' : 'SHORT'} adds ${F.qty(P.add)} at market (about ${F.price(P.entry, priceDec)}): total size ${F.qty(P.qty)}.`;
    } else if (it.pv) {
      const P = it.pv,
        k = P.ko;
      price = k.price;
      const d = Math.abs(P.entry - price);
      html = `<span class="k">FAIL NEW</span><b>${F.price(price, priceDec)}</b><span class="qy">${F.qty(P.qty)}</span><span class="down">−${d.toFixed(priceDec)} pt</span><span class="down">${F.usd(k.loss, true)}</span>`;
      le.chip.title = `${P.side === 'long' ? 'LONG' : 'SHORT'} preview (no order): ${P.adding ? 'adding ' + F.qty(P.add) + ' to the position, size ' : 'size '}${F.qty(P.qty)} at about ${F.price(P.entry, priceDec)}. ` +
        `At ${F.price(price, priceDec)} the equity reaches the ${k.floorKind} drawdown limit (${F.usd(k.floor)}): ${d.toFixed(priceDec)} points from the current price. Excludes pending orders, local stops, SL/TP, spread, exit fee and funding.`;
    } else if (it.one) {
      const N = it.avgL.next;
      price = N.avg;
      html = `<span class="k">AVG NEXT</span><b>${F.price(price, priceDec)}</b><span>${F.qty(N.qty)}</span>`;
      le.chip.title = `Average entry if ONLY the next limit (${F.price(N.price, priceDec)}) fills, on top of the open position: size ${F.qty(N.qty)}. Excludes the other limits, local stops and fees.`;
    } else if (it.avgL) {
      const L = it.avgL;
      price = L.avg;
      html = `<span class="k">AVG ALL</span><b>${F.price(price, priceDec)}</b><span>${F.qty(L.qty)}</span>`;
      le.chip.title = `Average entry if all ${L.n} entry limits fill${pos ? ', on top of the open position' : ''}: total size ${F.qty(L.qty)}. Excludes local stops and fees.`;
    } else if (it.gdAvg) {
      const g = it.gdAvg;
      price = it.price;
      html = `<span class="k">GRID AVG ${g.k}</span><b>${F.price(price, priceDec)}</b><span class="qy">${F.qty(g.qty)}</span>${Number.isFinite(g.usd) ? `<span class="${F.cls(g.usd)}">${F.usd(g.usd, true)}</span>` : ''}`;
      le.chip.title = g.k === 'ENTRY'
        ? `Average price if all ${g.n} grid entries fill${g.withPos ? ', together with the open position' : ''}: total size ${F.qty(g.qty)}.`
        : `Average price of the ${g.n} grid ${g.k} levels, weighted by their size: total ${F.qty(g.qty)}, ${F.usd(g.usd, true)} if all are hit.`;
    } else if (it.gd) {
      const l = it.gd;
      price = it.price;
      le.chip.classList.toggle('gdend', !!it.gdEnd);
      le.chip.classList.toggle('gdfix', !it.gdMov);
      le.line.classList.toggle('gdfix', !it.gdMov);
      const gdTail = it.gdGo ? '<span class="go">START</span>' : it.gdLive && l.kind !== 'en' ? `<span class="loc">${l.on ? 'on Vest' : 'sending'}</span>` : '';
      le.chip.classList.toggle('drag', !!(drag && drag.from === 'gd' && drag.moved && drag.existing.id === it.id));
      le.chip.classList.toggle('bad', !!(drag && drag.from === 'gd' && drag.moved && drag.existing.id === it.id && !drag.ok));
      html = l.kind === 'en'
        ? `<span class="k">GRID ${l.side === 'long' ? 'BUY' : 'SELL'}${l.n}</span><b>${F.price(price, priceDec)}</b><span class="qy">${F.qty(l.qty)}</span><span class="un">${Math.round(l.pct)}%</span>${l.bad ? '<span class="down">!</span>' : ''}${gdTail}`
        : `<span class="k">GRID ${l.kind.toUpperCase()}${l.n}</span><b>${F.price(price, priceDec)}</b><span class="qy">${l.all ? 'ALL ' : ''}${F.qty(l.qty)}</span><span class="un">${Math.round(l.pct)}%</span><span class="${F.cls(l.usd)}">${F.usd(l.usd, true)}</span>${l.bad ? '<span class="down">!</span>' : ''}${gdTail}`;
    } else if (it.usr) {
      const u = it.usr;
      price = u.price;
      html = `<span class="k">USER</span><span class="un">· ${F.esc(u.name)}</span><b>${F.price(price, priceDec)}</b><span>$${(+u.level).toFixed(2)}</span>`;
      le.chip.title = `Your Account limits row ${u.name} is ON: at this price (with the open position, everything else unchanged, fees excluded) it reaches $${(+u.level).toFixed(2)} and everything is closed (FLAT).`;
    } else if (it.dd50) {
      const h = it.dd50;
      price = h.price;
      html = `<span class="k">${+h.pct}% DRAWDOWN</span><b>${F.price(price, priceDec)}</b><span>${F.qty(h.qty)}</span><span class="down">${F.usd(h.loss, true)}</span>`;
      le.chip.title = `${+h.pct}% of the available drawdown: ${F.usd(h.half)} of ${F.usd(h.avail)}` +
        (Number.isFinite(h.ddInit) ? ` (initial drawdown ${F.usd(h.ddInit)} ${h.pl >= 0 ? '+' : '-'} total profit ${F.usd(Math.abs(h.pl))})` : '') +
        `. At this price the position loses ${F.usd(-h.loss)} in total, ${F.usd(-h.fromNow)} from now.` +
        (h.filled ? ` Counts ${h.filled} entry limit(s) that fill before it (size ${F.qty(h.qty)}, average entry ${F.price(h.avg, priceDec)}).` : ' With the current size.') +
        (h.afterKo ? ' WARNING: the closer (daily) drawdown limit comes FIRST: see the fail price.' : '') +
        ' Excludes local stops, fees and funding.';
    } else if (it.br) {
      // bracket leg of a pending entry (read-only): SL / TP, price, points from that entry
      const b = it.br;
      price = it.price;
      const gp = (b.side === 'long' ? 1 : -1) * (price - b.ref);
      html = `<span class="k">${b.k === 'sl' ? 'SL' : 'TP'}</span><b>${F.price(price, priceDec)}</b><span class="${F.cls(gp)}">${gp > 0 ? '+' : gp < 0 ? '−' : ''}${Math.abs(gp).toFixed(priceDec)} pt</span><span class="loc">${b.held ? 'sending' : b.vest ? 'on Vest' : b.own ? 'this entry' : 'bracket'}</span>`;
      le.chip.title = b.vest
        ? `${b.k.toUpperCase()} that Vest holds for the pending ${b.sub}: it becomes the position's ${b.k.toUpperCase()} when the order fills.`
        : `Bracket ${b.k.toUpperCase()} of the pending ${b.sub}: placed with the entry when it fills (from the fill price for a local entry). Not on Vest yet.`;
      const bdrag = !!(drag && drag.from === 'br' && drag.moved && drag.existing.id === it.id);
      le.chip.classList.toggle('drag', bdrag);
      le.chip.classList.toggle('bad', bdrag && !drag.ok);
      le.chip.classList.toggle('pending', !!b.held);
      if (b.held) le.chip.title = `${b.k.toUpperCase()} just moved: being sent / waiting for the feed.`;
      le.chip.title += b.fixed ? ' Several partial legs: not movable from here.' : b.vest ? ' Drag it to move it: the LIMIT is placed again with the new SL / TP.' : ' Drag it to set a different distance for this entry only.';
    } else if (it.sr) {
      // safe runner level (read-only): name, price, size of the tranche(s), P&L of that size if it exits there
      const r = it.sr;
      price = r.price;
      const q = +r.qty > 0 ? +r.qty : NaN;
      const usd = q > 0 ? pnlUsd(pos.side, q, pos.openPrice, price) : NaN;
      const gp = (pos.side === 'long' ? 1 : -1) * (price - pos.openPrice);
      html = `<span class="k">${r.text.toUpperCase()}</span><b>${F.price(price, priceDec)}</b>` + (q > 0 ? `<span>${F.qty(q)}</span><span class="${F.cls(usd)}">${F.usd(usd, true)}</span>` : `<span class="${F.cls(gp)}">${gp > 0 ? '+' : gp < 0 ? '−' : ''}${Math.abs(gp).toFixed(priceDec)} pt</span>`);
      le.chip.title = q > 0 ? 'Safe runner: local exit level of this tranche (closed at market when the price touches it)' : 'Safe runner: it takes over when the price reaches this level';
    } else if (it.ko) {
      const k = it.ko;
      price = k.price;
      html = `<span class="k">FAIL</span><b>${F.price(price, priceDec)}</b><span>${F.qty(k.qty)}</span><span class="down">${F.usd(k.loss, true)}</span>`;
      le.chip.title = `Account fail price: here the equity reaches the ${k.floorKind} drawdown limit (${F.usd(k.floor)}), losing ${F.usd(-k.loss)} from now.` +
        (k.filled ? ` Counts ${k.filled} entry limit(s) that fill before it (size ${F.qty(k.qty)}, average entry ${F.price(k.avg, priceDec)}).` : ' With the current size.') +
        ' Excludes local stops, SL/TP, fees and funding.';
    } else if (it.entry) {
      price = pos.openPrice;
      const usd = mark > 0 ? pnlUsd(pos.side, pos.qty, pos.openPrice, mark) : NaN;
      const armed = removeArm && removeArm.id === it.id && Date.now() < removeArm.until;
      const off = !m.ordersOn || !!m.busy;
      // one row: side, entry, size, points for/against, account P&L, X
      const gp = mark > 0 ? (pos.side === 'long' ? 1 : -1) * (mark - pos.openPrice) : NaN;
      html =
        `<span class="k" title="${pos.side === 'long' ? 'LONG' : 'SHORT'}: average entry price of the position">${pos.side === 'long' ? 'L' + ARROW_UP : 'S' + ARROW_DOWN}</span><b>${F.price(price, priceDec)}</b>` +
        `<span class="qy">${F.qty(pos.qty)}</span>` +
        `<span class="pt ${F.cls(gp)}" title="Points from the entry to the current price">${Number.isFinite(gp) ? (gp > 0 ? '+' : gp < 0 ? '−' : '') + Math.abs(gp).toFixed(priceDec) + ' pt' : '—'}</span>` +
        `<span class="pl ${F.cls(usd)}" title="P&L of the selected account">${F.usd(usd, true)}</span>` +
        (mark > 0 ? sumAll(mark) : '') + // Σ all accounts holding the trade at the current price, as on the SL / TP labels
        `<span class="x${armed ? ' arm' : ''}${off ? ' off' : ''}" title="${off ? 'Orders off or sending in progress' : 'Closes 100% of the position at market, WITHOUT cancelling pending orders (two clicks)'}">${armed ? 'close?' : '✕'}</span>`;
    } else if (it.leg) {
      const t = it.leg;
      const dragging = drag && drag.existing && drag.existing.id === t.id;
      const isPending = pending && pending.legId === t.id && Date.now() < pending.until && Math.abs(t.price - pending.price) > tick / 2;
      price = dragging ? drag.price : isPending ? pending.price : t.price;
      const usd = pnlUsd(pos.side, t.qty > 0 ? t.qty : pos.qty, pos.openPrice, price);
      const armed = removeArm && removeArm.id === t.id && Date.now() < removeArm.until;
      // size it closes (Gerry 2026-11-23, DCA): a leg without quantity closes the WHOLE position, so it grows with every add
      const full = !(t.qty > 0) || t.qty >= pos.qty - 1e-12;
      const cq = full ? pos.qty : t.qty;
      const sz = `<span class="qy" title="${full ? `Closes the whole position: ${F.qty(pos.qty)} now (it follows every add / DCA)` : `Closes ${F.qty(t.qty)} of ${F.qty(pos.qty)} (partial)`}">${full ? 'ALL ' : ''}${F.qty(cq)}${full ? '' : ` <i class="pc">${Math.round((cq / pos.qty) * 100)}%</i>`}</span>`;
      html = `<span class="k">${t.kind.toUpperCase()}</span><b>${F.price(price, priceDec)}</b>${sz}<span class="${F.cls(usd)}">${F.usd(usd, true)}</span>${sumAll(price)}<span class="x${armed ? ' arm' : ''}" title="${t.kind === 'sl' ? 'Remove the stop (two clicks)' : 'Remove the target'}">${armed ? 'remove?' : '✕'}</span>`;
      le.chip.classList.toggle('pending', !!isPending);
      le.chip.classList.toggle('drag', !!dragging);
      le.chip.classList.toggle('bad', !!(dragging && !drag.ok));
    } else {
      const o = it.order;
      const dragging = drag && drag.from === 'order' && drag.existing.id === o.id;
      const isPending = pending && pending.legId === it.id && Date.now() < pending.until && Math.abs(o.price - pending.price) > tick / 2;
      price = dragging ? drag.price : isPending ? pending.price : o.price;
      le.chip.classList.toggle('pending', !!isPending || !!it.held);
      le.chip.classList.toggle('drag', !!dragging);
      le.chip.classList.toggle('bad', !!(dragging && !drag.ok));
      html = `<span class="k" title="${o.label === 'CLOSE' ? 'Closing limit: reduces the position' : o.local ? 'Local entry stop' : 'Entry limit'}">${o.label || NAME[o.kind]}</span><span class="${o.side === 'long' ? 'up' : 'down'}">${sideWord(o.side)}</span><b>${F.price(price, priceDec)}</b><span>${F.qty(o.qty)}</span>${o.local ? `<span class="loc" title="${o.lim ? 'Local LIMIT (OCO, Vest keeps one pending side per market): lives in this browser tab, sent at market when the price gets there' : 'Local stop: lives in this browser tab and triggers at market'}">local</span>` : ''}${it.held ? '<span class="loc">sending</span>' : '<span class="x" title="Cancel">✕</span>'}`;
    }
    const y = yOf(price);
    // FAIL NEW preview off scale: label on the chart edge with an arrow, no line
    const pin = !!it.pv && !inside(y);
    if (pin || it.ghost) html += `<span class="down">${y > 0 ? '▼' : '▲'}</span>`; // the reserved space includes the arrow
    show(le.line, inside(y) && !it.ghost);
    show(le.chip, inside(y) || pin || !!it.ghost);
    le.chip.style.visibility = it.ghost ? 'hidden' : '';
    const ls = it.sr ? { c: it.sr.color, s: 'dashed', w: 1 } : it.br ? { ...LS(it.br.k), w: 1 } : LS(it.sk || it.kind); // safe runner: its own colour per tranche; bracket preview: as SL / TP
    chipStyle(le.chip, ls, it.br ? LS(it.br.k).lab : ls.lab); // label: name colour / fill, background, border, size, weight (panel)
    if (le.html !== html) {
      le.chip.innerHTML = html; // rewritten only when it changes: the X stays the same element and the click is not lost
      le.html = html;
    }
    const chh = (le.chip.offsetHeight || 20) * CS; // on screen (transform)
    let top = (pin ? (y > 0 ? g.height - chh / 2 - 4 : chh / 2 + 4) : y) - chh / 2;
    // never over another label: moves below the one it touches (column sorted by price)
    for (let i = 0; i < 30; i++) {
      const hit = placed.find(([t, b]) => top < b + 2 && top + chh > t - 2);
      if (!hit) break;
      top = hit[1] + 2;
    }
    if (!it.ghost) placed.push([top, top + chh]); // the invisible reserved label does not push the others
    frameChipW = Math.max(frameChipW, le.chip.offsetWidth || 0);
    const chipLeft = areaX - CHIP_GAP - (le.chip.offsetWidth || 150) * CS; // column aligned to the right, next to the cards
    // label shifted to avoid overlap: the line stops earlier and a slanted stroke joins it to the label
    const mid = top + chh / 2;
    const bent = Math.abs(mid - y) > 1.5 && inside(y) && !it.ghost;
    hline(le.line, g, y, ls, bent ? chipLeft - LEAD_W : chipLeft); // the line reaches the label
    show(le.lead, bent);
    if (bent) {
      const x0 = chipLeft - LEAD_W - 4,
        dx = chipLeft - x0,
        dy = mid - y;
      le.lead.style.left = x0 + 'px';
      le.lead.style.top = g.top + y + 'px';
      le.lead.style.width = Math.hypot(dx, dy) + 'px';
      le.lead.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
      le.lead.style.borderTop = `${ls.w}px ${ls.s === 'dotted' ? 'dotted' : 'solid'} ${ls.c}`;
    }
    le.chip.style.left = chipLeft + 'px';
    le.chip.style.top = g.top + top + 'px';
  }
  for (const [id, le] of legEls)
    if (!seen.has(id)) {
      le.line.remove();
      le.lead.remove();
      le.chip.remove();
      legEls.delete(id);
    }

  // ── trailing: three segments in the space between the candles and the label column
  //    orange = trailing stop, light blue = start level (gone once the stop is placed), green = next step
  {
    const tv = m.trailView;
    const x1 = areaX - CHIP_GAP - chipW * CS - 6;
    let x0 = g.left + g.width - needPx + 6;
    if (x1 - x0 < 20) x0 = x1 - 20;
    const SEG = { trT: 'beauto', trB: 'beplus', trS: 'tstop', trA: 'tact', trN: 'tnext' }; // kind in the panel (colour, dash, width, length)
    for (const [k, p] of [['trT', m.beAtPrice], ['trB', m.bePrice], ['trS', tv && tv.stop], ['trA', tv && tv.act], ['trN', tv && tv.next]]) {
      const y = p != null ? yOf(p) : NaN;
      const on = p != null && inside(y);
      show(els[k], on);
      if (!on) continue;
      const ls = (lineStyles && lineStyles[SEG[k]]) || null;
      const w = ls ? ls.w : 3;
      const sx0 = ls && ls.l > 0 ? x1 - ls.l : x0; // chosen length: the segment always ends next to the labels
      if (ls) borderLine(els[k], ls);
      els[k].style.left = sx0 + 'px';
      els[k].style.width = x1 - sx0 + 'px';
      els[k].style.top = g.top + y - Math.floor(w / 2) + 'px';
      els[k].title = { trT: 'Auto BE: triggers when the price gets here', trB: 'BE+: the BE button puts the stop here', trS: 'Trailing: stop', trA: 'Trailing: first stop when the price gets here', trN: 'Trailing: the stop moves up when the price gets here' }[k] + ' (' + F.price(p, priceDec) + ')';
    }
  }

  // ── last swing high / low: two short lines between the cards and the price axis
  {
    const hl = m.hlOn && bv ? bv.hl : null;
    const sw = CARD_RIGHT - 4; // line length
    const x0 = g.left + g.width - CARD_RIGHT + 3 - 2 * sw,
      x1 = g.left + g.width - 1 - 2 * sw;
    for (const [k, p, kind] of [['hlH', hl && hl.h, 'hhigh'], ['hlL', hl && hl.l, 'hlow']]) {
      const y = Number.isFinite(p) ? yOf(p) : NaN;
      const on = Number.isFinite(y) && inside(y);
      show(els[k], on);
      if (!on) continue;
      const ls = (lineStyles && lineStyles[kind]) || { c: kind === 'hhigh' ? '#3ecf8e' : '#ff6b61', s: 'solid', w: 2 };
      borderLine(els[k], ls);
      els[k].style.left = x0 + 'px';
      els[k].style.width = x1 - x0 + 'px';
      els[k].style.top = g.top + y - Math.floor(ls.w / 2) + 'px';
    }
  }

  // ── preview while dragging a new level (TP/SL, LIMIT/STOP from the second card)
  if (drag && !drag.existing && drag.moved) {
    const y = yOf(drag.price);
    show(els.dragLine, true);
    show(els.dragChip, true);
    let txt;
    if (drag.kind === 'lm' || drag.kind === 'st') {
      const side = entrySide(drag.kind, drag.price, mark);
      // ACTIVE: the LIMIT goes with the plan size at this price (recalculated at every move); otherwise the % size
      const pq = (drag.kind === 'lm' || drag.kind === 'st') && side && col && omMode !== 'manual' ? omPlan(m, side, bv, drag.price).qty : NaN;
      const q = omMode !== 'manual' && col && (drag.kind === 'lm' || drag.kind === 'st') ? pq : sz.qty;
      txt = `<span class="k">${NAME[drag.kind]}</span>${side ? `<span class="${side === 'long' ? 'up' : 'down'}">${sideWord(side)}</span>` : ''}<b>${F.price(drag.price, priceDec)}</b><span>${q > 0 ? F.qty(q) : ''}</span>`;
    } else {
      const usd = pos ? pnlUsd(pos.side, pos.qty, pos.openPrice, drag.price) : NaN;
      txt = `<span class="k">${NAME[drag.kind]}</span><b>${F.price(drag.price, priceDec)}</b><span class="${F.cls(usd)}">${F.usd(usd, true)}</span>${pos ? sumAll(drag.price) : ''}`;
    }
    els.dragChip.className = 'chip drag ' + drag.kind + (drag.ok ? '' : ' bad');
    els.dragChip.innerHTML = txt;
    els.dragChip.style.setProperty('--kc', LS(drag.kind).c);
    const dLeft = areaX - CHIP_GAP - (els.dragChip.offsetWidth || 150) * CS;
    hline(els.dragLine, g, y, LS(drag.kind), dLeft);
    els.dragChip.style.left = dLeft + 'px';
    els.dragChip.style.top = g.top + y - ((els.dragChip.offsetHeight || 20) * CS) / 2 + 'px';
  } else {
    show(els.dragLine, false);
    show(els.dragChip, false);
  }
  if (drag) drag.g = g;
  setState({ visible: true, why: null, posId: pos ? pos.id : null, legPrices: pos ? pos.triggers.map((t) => t.price) : [], entry: pos ? pos.openPrice : null });
}

// ── removing a stop/target. The target goes on the first click; the STOP needs a second click within 3 s
// (removing the stop increases the risk: hence two clicks).
let removeArm = null; // { id, until }
// ── Grid sliders (Gerry 2026-11-23): Custom % = n-1 handles between the levels' shares; Manual distances = one handle per level
// between nearest and farthest. 5 % steps, ⇄ inverts. Saved as text in the same settings (gd<P>Custom, gd<P>Man).
let gslDrag = null; // { P, k, vals } while a handle is held
const GSL_STEP = 5;
function gslLevels(tb, P) {
  const n = (v) => parseFloat(String(v ?? '').replace(',', '.'));
  const near = n(tb[`gd${P}Near`]);
  if (!(near > 0)) return 0;
  const far = n(tb[`gd${P}Far`]) > 0 ? n(tb[`gd${P}Far`]) : near;
  return far > near ? Math.max(0, Math.min(10, Math.floor(n(tb[`gd${P}Mid`]) || 0))) + 2 : 1;
}
const gslList = (txt) => String(txt || '').split(/[;,\s]+/).map(parseFloat).filter((x) => Number.isFinite(x));
// default when the number of levels changed: equal shares / equal gaps on the 5 % grid
function gslDefault(k, n) {
  if (k === 'Custom') {
    const base = Math.max(GSL_STEP, Math.floor(100 / n / GSL_STEP) * GSL_STEP);
    const a = Array(n).fill(base);
    for (let r = 100 - base * n, i = n - 1; r > 0; r -= GSL_STEP, i = (i - 1 + n) % n) a[i] += GSL_STEP;
    return a;
  }
  return Array.from({ length: n - 2 }, (_, i) => Math.round((100 * (i + 1)) / (n - 1) / GSL_STEP) * GSL_STEP);
}
function gslDraw(el, tb) {
  const P = el.dataset.gsl,
    k = el.dataset.gk;
  // always shown (the curve made visible); the handles move only with Distances = Manual / Sizes = Custom % (Gerry 2026-11-23)
  const edit = k === 'Custom' ? tb[`gd${P}Size`] === 'custom' : tb[`gd${P}Dist`] === 'manual';
  const n = gslLevels(tb, P);
  const ok = n >= (k === 'Custom' ? 2 : 3);
  show(el, ok);
  if (!ok) return;
  el.classList.toggle('lock', !edit);
  let vals;
  if (!edit) {
    if (k === 'Custom') {
      const w = GR.shapeWeights(n, tb[`gd${P}Size`]);
      const sum = w.reduce((a, b) => a + b, 0);
      vals = w.map((x) => (x / sum) * 100);
    } else vals = GR.distances(0, 100, n, tb[`gd${P}Dist`]).slice(1, -1);
  } else if (gslDrag && gslDrag.P === P && gslDrag.k === k) vals = gslDrag.vals;
  else {
    vals = gslList(tb[`gd${P}${k}`]);
    const want = k === 'Custom' ? n : n - 2;
    const valid = vals.length === want && (k === 'Custom' ? Math.abs(vals.reduce((a, b) => a + b, 0) - 100) < 0.01 : vals.every((x, i) => x > 0 && x < 100 && (i === 0 || x > vals[i - 1])));
    if (!valid) {
      vals = gslDefault(k, n);
      if (actions.setSetting) actions.setSetting(`gd${P}${k}`, vals.join(', ')); // number of levels changed: equal again
    }
  }
  // handle positions on the bar (0-100)
  const pos = k === 'Custom' ? vals.slice(0, -1).map((_, i) => vals.slice(0, i + 1).reduce((a, b) => a + b, 0)) : vals;
  const near = parseFloat(String(tb[`gd${P}Near`]).replace(',', '.')),
    far = parseFloat(String(tb[`gd${P}Far`]).replace(',', '.'));
  const lab =
    k === 'Custom'
      ? vals.map((v, i) => [(i ? pos[i - 1] : 0) + v / 2, `${+v.toFixed(1)}%`])
      : [[0, `${+near}`], ...vals.map((v, i) => [v, `${+(near + ((far - near) * v) / 100).toFixed(2)}`, i % 2 === 0]), [100, `${+far}`]];
  const sig = JSON.stringify([pos, lab, edit]);
  const bar = el.querySelector('.gbar');
  if (bar.dataset.sig === sig) return;
  bar.dataset.sig = sig;
  bar.innerHTML =
    '<div class="gline"></div><b class="gend s"></b><b class="gend e"></b>' +
    pos.map((x, i) => `<b class="gh${edit ? '' : ' lock'}" data-i="${i}" style="left:${x}%"></b>`).join('') +
    lab.map(([x, t, top]) => `<span class="gsv${k === 'Custom' || top ? ' gtop' : ''}" style="left:${x}%">${t}</span>`).join('');
}
function gslCommit(P, k, vals) {
  if (actions.setSetting) actions.setSetting(`gd${P}${k}`, vals.map((x) => +x.toFixed(1)).join(', '));
}
const gdNow = new Map(); // 'gd:<kind>:<n>' -> grid level as drawn in the last frame (start of a grid drag)
const planNow = new Map(); // 'om:entry' | 'om:sl' -> { price, entry, qty } as drawn in the last frame (start of a plan drag)
const brHold = new Map(); // 'side|entry price' -> { sl, tp, until, o, local } SL / TP just dropped on a pending entry, drawn until the feed has them
const brGhosts = []; // Vest LIMITs being placed again (out of the feed for a moment)
const brNow = new Map(); // 'br:<order>:<leg>' -> { o, k, price, cur: { sl, tp } } bracket legs of pending entries as drawn (drag)
const removing = new Map(); // id -> wait deadline
function askRemove(leg) {
  const now = Date.now();
  if (leg.kind === 'sl' && !(removeArm && removeArm.id === leg.id && now < removeArm.until)) {
    removeArm = { id: leg.id, until: now + 3000 };
    say('Click the X again within 3 seconds to remove the STOP', '');
    return;
  }
  removeArm = null;
  removing.set(leg.id, now + 6000);
  const p = actions.removeLeg(leg);
  run(p, `${leg.kind.toUpperCase()} removed`);
  p.catch(() => removing.delete(leg.id));
}

/** Position X: the first click arms, a second within 3 s closes 100% (pending orders stay). */
function askClosePos(id) {
  const m = getModel();
  if (!m || !m.pos || 'pos:' + m.pos.id !== id) return;
  if (!m.ordersOn) return say('Orders are off: switch them on from the card (Orders)', 'err');
  if (m.busy) return;
  const now = Date.now();
  if (!(removeArm && removeArm.id === id && now < removeArm.until)) {
    removeArm = { id, until: now + 3000 };
    say('Click the X again within 3 seconds to close the whole position (pending orders stay)', '');
    return;
  }
  removeArm = null;
  run(actions.closeAll(), 'CLOSE sent: pending orders stay');
}

/** Cancels a pending order or a local stop (one click: it only reduces risk). */
function askCancel(o) {
  const key = 'o:' + o.id;
  removing.set(key, Date.now() + 6000);
  const p = actions.cancelPending(o);
  run(p, `${NAME[o.kind]} cancelled`);
  p.catch(() => removing.delete(key));
}

// ── Account limits guard rows: ON / OFF; margins and open loss: slider ON the bar (0 .. the cap); the others: a number
// (never beyond the account's limit: the level in force is shown on the right)
function guardRows(m) {
  const gd = m.guards;
  if (!gd) return;
  for (const bx of els.card3.querySelectorAll('.bar[data-g]')) {
    const k = bx.dataset.g,
      r = gd[k];
    if (!r) continue;
    bx.classList.toggle('garm', r.on);
    bx.classList.toggle('ghit', r.on && r.hit);
    const eye = bx.querySelector('.geye');
    if (eye) eye.classList.toggle('off', r.eye === false);
    const btn = bx.querySelector('.gon');
    const bt = r.on ? 'ON' : 'OFF';
    if (btn.textContent !== bt) btn.textContent = bt;
    btn.title = r.on ? 'ON: at the level everything open on this account is closed (FLAT). Click to switch it off.' : r.level > 0 ? 'OFF: click to switch the FLAT at this level on (back to OFF after a reload)' : k === 'tg' ? 'No profit target on Vest: set the manual one in Account limits settings' : 'Set the level first';
    const tx = bx.querySelector('.gt');
    if (r.kind === 'slider') {
      const rg = bx.querySelector('.gr');
      const mx = String(r.cap > 0 ? +r.cap.toFixed(2) : 100),
        st = String(r.step);
      if (rg.max !== mx) rg.max = mx;
      if (rg.step !== st) rg.step = st;
      rg.disabled = !(r.cap > 0);
      if (root.activeElement !== rg && rg.value !== String(r.level)) rg.value = String(r.level);
      const t = r.text + (r.cap > 0 && (k === 'rk' || k === 'cp') ? ` (max $${r.cap.toFixed(2)})` : '');
      if (tx.textContent !== t) tx.textContent = t;
    } else {
      const inp = bx.querySelector('.gv');
      if (!inp) {
        // ACCOUNT PROFIT TARGET: no level to type (Gerry 2026-11-23), ON closes everything at the target itself
        if (tx.textContent !== r.text) tx.textContent = r.text;
        continue;
      }
      if (root.activeElement !== inp && inp.value !== r.raw) inp.value = r.raw;
      const ph = k === 'tg' ? (r.cap > 0 ? r.cap.toFixed(2) + ' auto' : 'none') : r.cap > 0 ? 'max ' + r.cap.toFixed(2) : '';
      if (inp.placeholder !== ph) inp.placeholder = ph;
      // right side: the level in force when it differs from what was typed (capped at the limit / automatic target)
      const typed = parseFloat(r.raw);
      const t = !(r.level > 0)
        ? r.text
        : !(typed > 0)
          ? `$${r.level.toFixed(2)} (${r.auto || 'Vest target'})`
          : Math.abs(typed - r.level) > 1e-9
            ? `$${r.level.toFixed(2)} (the limit)`
            : r.cap > 0
              ? `max $${r.cap.toFixed(2)}`
              : '';
      if (tx.textContent !== t) tx.textContent = t;
    }
  }
}

// ── "ACTIVE" next to the title of every section whose function is on (Gerry 2026-11-23)
function activeTags(m) {
  const t = m.tb || {};
  const g = m.guards || {};
  const on = {
    actOm: omMode === 'live',
    actTb: !!(t.trOn || t.beOn || t.beAuto),
    actLim: Object.values(g).some((r) => r && r.on),
    actCopy: !!(m.copy && m.copy.armed),
    actBr: !!t.brOn,
    actOco: !!t.ocoOn,
    actSr: t.srMode === 'live',
    actGd: !!m.gdLive,
  };
  for (const [k, v] of Object.entries(on)) if (els[k]) show(els[k], v);
  if (els.actSr) {
    // VIEW draws the levels only: shown as VIEW, not ACTIVE
    const view = t.srMode === 'view';
    show(els.actSr, on.actSr || view);
    const tx = view ? 'VIEW' : 'ACTIVE';
    if (els.actSr.textContent !== tx) els.actSr.textContent = tx;
    els.actSr.classList.toggle('view', view);
  }
  if (els.actCopy) {
    // copier off: said in the title, the accounts listed are NOT being copied (Gerry 2026-11-23)
    const tx = on.actCopy ? 'ACTIVE' : 'COPY OFF: accounts not copied';
    show(els.actCopy, true);
    if (els.actCopy.textContent !== tx) els.actCopy.textContent = tx;
    els.actCopy.classList.toggle('off', !on.actCopy);
  }
}

// ── dragging
function startDrag(e, el, kind, existing, from) {
  const m = getModel();
  if (!m || !state.visible || !m.market) return;
  if ((kind === 'tp' || kind === 'sl') && !m.pos && from !== 'plan' && from !== 'br' && from !== 'gd' && !(m.gdFar && m.gdFar[kind])) return;
  e.preventDefault();
  e.stopPropagation();
  try {
    el.setPointerCapture(e.pointerId);
  } catch {
    /* nothing */
  }
  const start = existing ? existing.price : m.pos ? m.pos.openPrice : m.gdFar ? m.gdFar[kind + 'Ref'] || m.gdFar.ref : m.market.mark;
  drag = { el, kind, existing, from, startY: e.clientY, moved: false, price: start, ok: true, g: null };
  const move = (ev) => {
    if (!drag) return;
    if (Math.abs(ev.clientY - drag.startY) > CLICK_PX) drag.moved = true;
    const cur = getModel();
    if (!drag.moved || !drag.g || !cur || !cur.market) return;
    const { tick, mark } = cur.market;
    drag.price = roundToTick(G.yToPrice(ev.clientY - drag.g.top, drag.g.vr, drag.g.height), tick);
    if (drag.from === 'br') {
      const o = drag.existing.order;
      drag.ok = (o.side === 'long' ? 1 : -1) * (drag.kind === 'sl' ? o.price - drag.price : drag.price - o.price) > 0;
    } else if (drag.from === 'plan') drag.ok = drag.kind === 'lm' || (drag.price - drag.existing.entry) * (omPv === 'long' ? -1 : 1) > 0; // plan SL on the stop side of the entry
    else if (drag.from === 'order') drag.ok = entrySide(drag.existing.order.lim ? 'lm' : drag.kind, drag.price, mark) === drag.existing.order.side && !tooClose(drag.price, mark, tick);
    else if (drag.from === 'gd') {
      const l = drag.existing.gd;
      drag.ok = l.kind === 'en' ? (l.side === 'long' ? drag.price < mark : drag.price > mark) : (l.side === 'long' ? 1 : -1) * (l.kind === 'tp' ? 1 : -1) * (drag.price - l.ref) > 0;
    } else if (drag.kind === 'lm' || drag.kind === 'st') drag.ok = !!entrySide(drag.kind, drag.price, mark) && !tooClose(drag.price, mark, tick);
    else if (drag.from === 'card' && cur.gdFar && cur.gdFar[drag.kind]) drag.ok = (cur.gdFar.side === 'long' ? 1 : -1) * (drag.kind === 'tp' ? 1 : -1) * (drag.price - cur.gdFar[drag.kind + 'Ref']) > 0;
    else drag.ok = !!cur.pos && !checkLeg({ kind: drag.kind, side: cur.pos.side, price: drag.price, mark, tick });
  };
  const up = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    endDrag(true);
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}

/** Plan line dropped (nothing is sent). ENTRY: the plan starts there. SL: stop = that distance, size unchanged, risk follows. */
function omDrop(d) {
  const m = getModel();
  if (!m || !m.market || !omPv) return;
  if (d.kind === 'lm') {
    omAnchor = { side: omPv, symbol: m.market.symbol, price: d.price, type: (omAnchor && omAnchor.type) || 'lm' };
    return;
  }
  if (!d.ok) return say(`plan SL must be ${omPv === 'long' ? 'below' : 'above'} the entry`, 'err');
  const dist = Math.abs(d.existing.entry - d.price);
  const dec = Math.max(0, Math.ceil(-Math.log10(m.market.tick || 1)) + 1);
  const before = omSt.stopBy;
  omSt.stopBy = 'dist';
  omSt.stopVal = String(+dist.toFixed(dec));
  omFill();
  omSave();
  const side = omPv;
  const en = omEntry(m, side);
  const x = omPlan(m, side, omBv, en.price);
  const what = `stop ${omSt.stopVal} points${before !== 'dist' ? ' (stop rule now Points)' : ''}, size ${x.qty > 0 ? F.qty(x.qty) : '—'}`;
  // plan on a pending LIMIT: that order is placed again with the new size, SL and TP
  if (omLim() && en.src === 'limit') {
    const pl = omOrderPlan(m, side, en.order.price);
    if (pl instanceof Error) return say(pl.message, 'err');
    omRun(actions.planMove(en.order, en.order.price, pl), `PLAN LIMIT updated: ${pl.qty} with SL ${pl.sl}`, side, en.order.price);
    return;
  }
  if (omLim() && en.src === 'stop') {
    const pl = omOrderPlan(m, side, en.order.price);
    if (pl instanceof Error) return say(pl.message, 'err');
    run(actions.planStopMove(en.order, en.order.price, pl), `PLAN STOP updated: ${pl.qty} with SL ${pl.sl} (local)`);
    return;
  }
  say('Plan: ' + what, '');
}

/** Button on ENTRY: READY (in PLAN) switches to READY, START (in READY) places the LIMIT (or arms the local STOP) with the plan. */
function omSend() {
  const m = getModel();
  if (!m || !m.market || !omLim()) return;
  if (omMode === 'view') {
    omMode = 'live';
    omSave();
    return say('READY: press START on ENTRY to place the order with the plan', '');
  }
  const side = omSide;
  const en = omEntry(m, side);
  if (en.src === 'mark') {
    // START on the MARKET label: market entry with the plan size, SL and TP
    const pl = omOrderPlan(m, side, m.market.mark);
    if (pl instanceof Error) return say(pl.message, 'err');
    run(actions.planEntry('market', side, null, pl), `PLAN ${side.toUpperCase()} sent at market: ${pl.qty} with SL ${pl.sl}`);
    return;
  }
  if (en.src !== 'set') return;
  if (omType(en) === 'st') {
    if (entrySide('st', en.price, m.market.mark) !== side)
      return say(`a ${side === 'long' ? 'BUY' : 'SELL'} stop goes ${side === 'long' ? 'above' : 'below'} the price: move ENTRY`, 'err');
    const pl = omOrderPlan(m, side, en.price);
    if (pl instanceof Error) return say(pl.message, 'err');
    const p = actions.planStop(side, en.price, pl);
    run(p, `PLAN STOP ${side === 'long' ? 'BUY' : 'SELL'} ${pl.qty} at ${en.price} with SL ${pl.sl} armed (LOCAL, in this tab)`);
    p.then(() => (omAnchor = null), () => {}); // then the plan follows the STOP on the chart
    return;
  }
  if (entrySide('lm', en.price, m.market.mark) !== side)
    return say(`a ${side === 'long' ? 'BUY' : 'SELL'} limit goes ${side === 'long' ? 'below' : 'above'} the price: move ENTRY`, 'err');
  const pl = omOrderPlan(m, side, en.price);
  if (pl instanceof Error) return say(pl.message, 'err');
  const p = actions.planEntry('limit', side, en.price, pl);
  omRun(p, `PLAN LIMIT ${side === 'long' ? 'BUY' : 'SELL'} ${pl.qty} @ ${en.price} with SL ${pl.sl}`, side, en.price);
  p.then(() => (omAnchor = null), () => {}); // then the plan follows the LIMIT on the chart
}

function endDrag(commit) {
  const d = drag;
  drag = null;
  if (!d || !commit) return;
  if (d.from === 'plan') return d.moved && omDrop(d);
  if (d.from === 'gd' || (d.from === 'card' && (d.kind === 'tp' || d.kind === 'sl') && (getModel() || {}).gdFar && getModel().gdFar[d.kind])) {
    if (!d.moved) return d.from === 'card' && say(`Grid on: drag ${NAME[d.kind]} to the chart, it becomes the farthest GRID ${d.kind.toUpperCase()} level`, '');
    if (!d.ok) return say('GRID: wrong side', 'err');
    try {
      const l = d.existing && d.existing.gd;
      const r = d.from === 'gd' ? actions.gridDrag(l.kind, l.i, l.of, d.price, l.which || '', l.other) : actions.gridFar(d.kind, d.price);
      if (r) say(r, '');
    } catch (e) {
      say(e.message, 'err');
    }
    return;
  }
  if (d.from === 'br') {
    if (!d.moved || Math.abs(d.price - d.existing.price) < 1e-9) return;
    if (!d.ok) return say(`${d.kind.toUpperCase()}: wrong side of the entry`, 'err');
    const o = d.existing.order;
    const prices = { ...d.existing.cur, [d.kind]: d.price };
    const hk = o.side + '|' + o.price;
    brHold.set(hk, { sl: prices.sl, tp: prices.tp, until: Date.now() + (o.local ? 4000 : 15000), o, local: !!o.local });
    const p = actions.pendingBracket(o, prices);
    p.catch(() => brHold.delete(hk));
    return run(p, o.local ? `${d.kind.toUpperCase()} of this entry set at ${d.price}` : `LIMIT placed again with ${d.kind.toUpperCase()} ${d.price}`);
  }
  if (!d.moved) {
    if (d.from !== 'leg' && d.from !== 'order') say(`Hold ${NAME[d.kind]} and drag it to the level you want`, '');
    return;
  }
  if (d.from === 'order') {
    // LIMIT / STOP already placed: moved on release, no confirmation (like the rest of the second card)
    const o = d.existing.order;
    if (Math.abs(d.price - o.price) < 1e-9) return;
    if (!d.ok) return say(`${NAME[d.kind]}: invalid level (wrong side or too close to the price)`, 'err');
    pending = { kind: d.kind, legId: 'o:' + o.id, price: d.price, until: Date.now() + 6000 };
    if (omLim() && o.local && o.plan) {
      const pl = omOrderPlan(getModel(), o.side, d.price);
      if (pl instanceof Error) {
        pending = null;
        return say(pl.message, 'err');
      }
      const p = actions.planStopMove(o, d.price, pl);
      run(p, `PLAN STOP moved to ${d.price}: ${pl.qty} with SL ${pl.sl} (local)`);
      p.catch(() => (pending = null));
      return;
    }
    if (omLim() && !o.local && o.kind === 'lm') {
      // plan: cancelled and placed again with SL / TP recalculated at the new price
      const pl = omOrderPlan(getModel(), o.side, d.price);
      if (pl instanceof Error) {
        pending = null;
        return say(pl.message, 'err');
      }
      const p = actions.planMove(o, d.price, pl);
      omRun(p, `PLAN LIMIT moved to ${d.price}: ${pl.qty} with SL ${pl.sl}`, o.side, d.price);
      p.catch(() => (pending = null));
      return;
    }
    const p = actions.movePending(o, d.price);
    run(p, `${NAME[d.kind]} moved to ${d.price}${o.local ? ' (local)' : ''}`);
    p.catch(() => (pending = null));
    return;
  }
  if ((d.kind === 'lm' || d.kind === 'st') && omLim()) {
    const m = getModel();
    const side = m && m.market && entrySide(d.kind, d.price, m.market.mark);
    if (!side) return say('current price not available', 'err');
    // nothing is sent on release: the plan stays at that price, its label has READY (in PLAN) / START (in READY)
    omSide = side;
    omAnchor = { side, symbol: m.market.symbol, price: d.price, type: d.kind };
    omSave();
    return say(`Plan ${d.kind === 'st' ? 'STOP ' : ''}ENTRY ${side === 'long' ? 'LONG' : 'SHORT'} at ${d.price}: press ${omMode === 'live' ? 'START' : 'READY, then START,'} on its label to ${d.kind === 'st' ? 'arm the local STOP' : 'place the LIMIT'}`, '');
  }
  if (d.kind === 'lm' || d.kind === 'st') {
    // order on release, no confirmation: the real checks are in entry.js / stops.js
    run(actions.placeEntry(d.kind, d.price), d.kind === 'lm' ? `LIMIT sent at ${d.price}` : `STOP armed at ${d.price} (local)`);
    return;
  }
  const p = actions.setLeg(d.kind, d.price, d.existing);
  if (d.existing) pending = { kind: d.kind, legId: d.existing.id, price: d.price, until: Date.now() + 5000 };
  run(p, `${NAME[d.kind]} ${d.existing ? 'moved' : 'set'} at ${d.price}`);
  p.catch(() => (pending = null));
}

module.exports = {
  mount,
  // waiting for Vest data after a reload: column greyed out, nothing clickable
  setWaiting: (on) => {
    if (els.layer && els.layer.classList.contains('waiting') !== !!on) els.layer.classList.toggle('waiting', !!on);
  },
  // start: the whole column invisible until Vest data are in, then it fades in
  reveal: (on) => {
    if (!els.layer) return;
    els.layer.classList.toggle('hidden0', !on);
  },
  riskOn: () => omMode === 'live',
  riskOff: () => {
    omMode = 'manual';
    omAnchor = null;
    omSave();
  },
  state: () => state,
  setEnabled: (v) => {
    enabled = !!v;
    if (!enabled) hideAll();
  },
  enabled: () => enabled,
};
