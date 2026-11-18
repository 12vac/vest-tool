// Our own lines on the chart (createOrderLine of the Charting Library). DISPLAY ONLY:
// not draggable, no X. Redrawn from scratch if Vest recreates the chart (market/theme change).

const tv = require('./tv');
const vestlines = require('./vestlines');
const log = require('../diag/log');

const INK = '#0f1115';
let owner = null; // { api, chart } the current lines live on
const lines = new Map(); // key -> { line, sig }

function hideThenRemove(l) {
  // a line removed while TradingView handles a click stays "under the cursor": first invisible, then removed
  try {
    l.setLineColor('rgba(0,0,0,0)');
  } catch {
    /* nothing */
  }
  setTimeout(() => {
    try {
      l.remove();
    } catch {
      /* already removed with the chart */
    }
  }, 60);
}

function clear() {
  for (const { line } of lines.values()) hideThenRemove(line);
  lines.clear();
}

function style(l, s) {
  l.setPrice(s.price)
    .setText(s.text)
    .setQuantity(s.qty || '')
    .setLineColor(s.color)
    .setBodyBorderColor(s.color)
    .setBodyTextColor(s.color)
    .setBodyBackgroundColor(INK)
    .setQuantityBorderColor(s.color)
    .setQuantityBackgroundColor(s.color)
    .setQuantityTextColor(INK)
    .setLineStyle(s.dashed ? 2 : 0);
  if (typeof l.setEditable === 'function') l.setEditable(false);
  if (typeof l.setCancellable === 'function') l.setCancellable(false);
  if (typeof l.setLineLength === 'function') l.setLineLength(s.length || 30, 'percentage');
  if (typeof l.setExtendLeft === 'function') l.setExtendLeft(false);
}

/**
 * Aligns the lines on the chart to the list specs = [{ key, price, text, qty, color, dashed }].
 * Returns { ok, why }.
 */
function render(found, specs) {
  if (!found) {
    if (lines.size) lines.clear(); // the chart is gone: the lines went with it
    owner = null;
    return { ok: false, why: 'chart not found' };
  }
  let chart;
  try {
    chart = found.api.activeChart();
  } catch {
    return { ok: false, why: 'chart not ready' };
  }
  if (!chart || typeof chart.createOrderLine !== 'function') return { ok: false, why: 'createOrderLine missing' };
  if (!owner || owner.api !== found.api || owner.chart !== chart) {
    if (owner) log.info('Chart recreated by Vest: lines redrawn');
    lines.clear(); // the old ones belong to the previous chart
    owner = { api: found.api, chart };
  }
  const want = new Map(specs.filter((s) => s.price > 0).map((s) => [s.key, s]));
  for (const [key, rec] of lines) {
    if (!want.has(key)) {
      hideThenRemove(rec.line);
      lines.delete(key);
    }
  }
  for (const [key, s] of want) {
    const sig = JSON.stringify(s);
    let rec = lines.get(key);
    if (rec && rec.sig === sig) continue;
    try {
      if (!rec) {
        rec = { line: vestlines.own(() => chart.createOrderLine()), sig: '' }; // ours: must not be hidden
        lines.set(key, rec);
      }
      style(rec.line, s);
      rec.sig = sig;
    } catch (e) {
      lines.delete(key);
      return { ok: false, why: 'drawing failed: ' + e.message };
    }
  }
  return { ok: true, why: null };
}

module.exports = { render, clear, find: tv.find };
