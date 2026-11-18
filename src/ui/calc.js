// SL/TP calculator in dollars. No orders: produces prices and actual amounts for the panel and the chart preview.
const { priceForUsd, pnlUsd } = require('../domain/money');

const DEFAULT_SYMBOL = 'NDX-USD-PERP';

/** Reference position of the selected account: the one on the chart's symbol, otherwise the first one. */
function refPosition(st, isChartSym) {
  const list = (st && st.positions) || [];
  return list.find((p) => isChartSym(p.symbol)) || list[0] || null;
}

/**
 * input = { mode: 'pos'|'man', slUsd, tpUsd, side, qty, entry, symbol }
 * ctx = { position, symbols, marks }
 */
function compute(input, ctx) {
  let side, qty, entry, symbol, source;
  if (input.mode === 'pos') {
    const p = ctx.position;
    if (!p) return { ok: false, err: 'The selected account has no open position: use "Manual".' };
    ({ side, qty, symbol } = p);
    entry = p.openPrice;
    source = 'position';
  } else {
    symbol = input.symbol || DEFAULT_SYMBOL;
    side = input.side;
    qty = parseFloat(input.qty);
    const mark = ctx.marks[symbol] && ctx.marks[symbol].px;
    entry = parseFloat(input.entry) > 0 ? parseFloat(input.entry) : mark;
    source = parseFloat(input.entry) > 0 ? 'manual' : 'current mark';
    if (!(qty > 0)) return { ok: false, err: 'Quantity missing.' };
    if (!(entry > 0)) return { ok: false, err: 'Entry price missing (and mark not read yet).' };
  }
  const m = ctx.symbols[symbol];
  if (!m) return { ok: false, err: `Rules for ${symbol} not read yet (tick).`, symbol };
  const base = { ok: true, side, qty, entry, symbol, source, tick: m.tick, priceDec: m.priceDec, label: m.label };
  const out = { ...base, sl: null, tp: null, errs: [] };
  const sl = parseFloat(input.slUsd),
    tp = parseFloat(input.tpUsd);
  if (sl > 0)
    try {
      out.sl = priceForUsd({ kind: 'sl', side, qty, entry, usd: sl, tick: m.tick });
    } catch (e) {
      out.errs.push('SL: ' + e.message);
    }
  if (tp > 0)
    try {
      out.tp = priceForUsd({ kind: 'tp', side, qty, entry, usd: tp, tick: m.tick });
    } catch (e) {
      out.errs.push('TP: ' + e.message);
    }
  out.rr = out.sl && out.tp ? out.tp.usd / -out.sl.usd : NaN;
  out.tickUsd = qty * m.tick;
  return out;
}

/** $ of a stop/target already on a position. */
const triggerUsd = (p, t) => pnlUsd(p.side, t.qty > 0 ? t.qty : p.qty, p.openPrice, t.price);

module.exports = { compute, refPosition, triggerUsd, DEFAULT_SYMBOL };
