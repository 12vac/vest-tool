// Access to Vest's TradingView chart: same-origin iframe with window.tradingViewApi.
// No React, no injection into the frame: only the object the iframe exposes.

function find() {
  for (const f of document.querySelectorAll('iframe')) {
    try {
      const w = f.contentWindow;
      const api = w && w.tradingViewApi;
      if (api && typeof api.activeChart === 'function' && typeof api.subscribe === 'function') return { api, frame: f, win: w };
    } catch {
      /* iframe from another origin: ignored */
    }
  }
  return null;
}

/** Chart symbol. [D] activeChart().symbol() is standard Charting Library API. */
function chartSymbol(tv) {
  try {
    const c = tv.api.activeChart();
    if (c && typeof c.symbol === 'function') {
      const s = c.symbol();
      if (s) return String(s);
    }
  } catch {
    /* below */
  }
  return null;
}

/**
 * Does the chart symbol match this market? EXACT comparison (without the "EXCHANGE:" prefix) with the symbol
 * or one of its names from exchangeInfo. On the site the chart says "NQ" for NDX-USD-PERP. Never by similarity:
 * a line on the wrong market is worse than no line.
 */
function sameSymbol(chartSym, sym, aliases) {
  if (!chartSym || !sym) return false;
  const c = chartSym.replace(/^.*:/, '').toUpperCase();
  return [sym, ...(aliases || [])].some((a) => a && a.toUpperCase() === c);
}

/** Market (among the known ones) the chart is showing, or null. */
function marketOfChart(chartSym, symbols) {
  for (const [sym, m] of Object.entries(symbols || {})) if (sameSymbol(chartSym, sym, m.aliases)) return sym;
  return null;
}

/** Which chart tools are available (for the startup check). */
function capabilities(tv) {
  const out = { activeChart: false, createOrderLine: false, createPositionLine: false, crossHairMoved: false, onContextMenu: false, symbol: false };
  if (!tv) return out;
  try {
    const c = tv.api.activeChart();
    out.activeChart = !!c;
    out.createOrderLine = typeof c.createOrderLine === 'function';
    out.createPositionLine = typeof c.createPositionLine === 'function';
    out.crossHairMoved = typeof c.crossHairMoved === 'function';
    out.symbol = typeof c.symbol === 'function';
  } catch {
    /* chart not ready */
  }
  out.onContextMenu = typeof tv.api.onContextMenu === 'function';
  return out;
}

module.exports = { find, chartSymbol, sameSymbol, marketOfChart, capabilities };
