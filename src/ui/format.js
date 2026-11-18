// Formatting. Dollars: US separators (1,520.00), always 2 decimals. Prices: tick decimals, decimal point as on the chart.

const nf = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: 'always' });
const nfFine = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4, useGrouping: 'always' });

function usd(v, signed = false) {
  if (!Number.isFinite(v)) return '—';
  const s = v < 0 ? '−' : signed && v > 0 ? '+' : '';
  return `${s}$${nf.format(Math.abs(v))}`;
}

const nfUS = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: 'always' });
/** Dollars with US separators (1,520.00): same as usd(), kept for the chart cards and labels. */
function usdUS(v, signed = false) {
  if (!Number.isFinite(v)) return '—';
  const s = v < 0 ? '−' : signed && v > 0 ? '+' : '';
  return `${s}$${nfUS.format(Math.abs(v))}`;
}

/** Small dollar amounts (value of one tick on tiny sizes): up to 4 decimals instead of showing $0.00. */
function usdFine(v) {
  if (!Number.isFinite(v) || Math.abs(v) >= 1) return usd(v);
  return `${v < 0 ? '−' : ''}$${nfFine.format(Math.abs(v))}`;
}

const price = (v, dec = 2) => (Number.isFinite(v) ? v.toFixed(dec) : '—');
/** Price with thousands separator, as on the chart (20,045.00). */
const priceG = (v, dec = 2) =>
  Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }) : '—';
const qty = (v) => (Number.isFinite(v) ? String(+v.toFixed(8)) : '—');
const cls = (v) => (!Number.isFinite(v) ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '');

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function ago(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
}

module.exports = { usd, usdUS, usdFine, price, priceG, qty, cls, esc, ago };
