// Chart style (Layout → Chart lines and labels): every line and label the tool draws on the chart, with its own line
// (colour, dash, width) and label (background, border, name colour / fill, text size, weight). Gerry 2026-11-23.
// Keys in the panel settings: lc_ ls_ lw_ ll_ (line, as before) and cbg_ cbo_ cbw_ cn_ cnb_ cfs_ cfw_ (label), + _<kind>.
// An empty label value = the card style's own (Console / Classic / Sonar).

const DASHES = ['solid', 'dashed', 'dotted', 'dashdot'];
// [kind, name, group, line colour, dash, width, label defaults { bo border, n name colour, nb name fill }]
const ELEMENTS = [
  ['long', 'Position LONG', 'Position and orders', '#3ecf8e', 'dashed', 1, { bo: '#2f6b52' }],
  ['short', 'Position SHORT', 'Position and orders', '#ff6b61', 'dashed', 1, { bo: '#7a3438' }],
  ['tp', 'TP (target)', 'Position and orders', '#3ecf8e', 'dashed', 1, { bo: '#2f6b52' }],
  ['sl', 'SL (stop)', 'Position and orders', '#ff6b61', 'dashed', 1, { bo: '#7a3438' }],
  ['lm', 'LIMIT', 'Position and orders', '#7fb2ff', 'dashed', 1, { bo: '#2f4a70' }],
  ['st', 'STOP (local)', 'Position and orders', '#e8b84a', 'dashed', 1, { bo: '#5a4520' }],
  ['avg', 'AVG ALL', 'Levels', '#5ad1e6', 'dotted', 1, { bo: '#2b6672' }],
  ['avg1', 'AVG NEXT', 'Levels', '#5ad1e6', 'dotted', 1, { bo: '#2b6672' }],
  ['avgn', 'AVG NEW', 'Levels', '#5ad1e6', 'dotted', 1, { bo: '#2b6672' }],
  ['ko', 'FAIL', 'Levels', '#c58cff', 'dashed', 1, { bo: '#5b3f80' }],
  ['mfp', 'FAIL NEW', 'Levels', '#ff9f43', 'dashed', 1, { bo: '#8a5520' }],
  ['dd50', 'X% DRAWDOWN', 'Levels', '#f472b6', 'dashed', 1, { bo: '#7a2f58' }],
  ['usr', 'USER (Account limits)', 'Account limits and grid', '#f97316', 'dashed', 1, { bo: '#c2410c', n: '#ffffff', nb: '#c2410c' }],
  ['gdavg', 'GRID averages (AVG ENTRY / TP / SL)', 'Account limits and grid', '#e5e7eb', 'dotted', 1, { bo: '#6b7280', n: '#0b1220', nb: '#e5e7eb' }],
  ['gden', 'GRID entries', 'Account limits and grid', '#7dd3fc', 'dashed', 1, { bo: '#2f4a70', n: '#0b1220', nb: '#7dd3fc' }],
  ['gdtp', 'GRID TP', 'Account limits and grid', '#a3e635', 'dashed', 1, { bo: '#3f6212', n: '#0b1220', nb: '#a3e635' }],
  ['gdsl', 'GRID SL', 'Account limits and grid', '#fb7185', 'dashed', 1, { bo: '#9f1239', n: '#ffffff', nb: '#e11d48' }],
  // nearest and farthest level of each grid ladder: their own style, darker and solid (Gerry 2026-11-23)
  ['gdenE', 'GRID entries: nearest / farthest', 'Account limits and grid', '#3b82f6', 'solid', 2, { bo: '#ffffff', n: '#ffffff', nb: '#1d4ed8' }],
  ['gdtpE', 'GRID TP: nearest / farthest', 'Account limits and grid', '#22c55e', 'solid', 2, { bo: '#ffffff', n: '#ffffff', nb: '#15803d' }],
  ['gdslE', 'GRID SL: nearest / farthest', 'Account limits and grid', '#ef4444', 'solid', 2, { bo: '#ffffff', n: '#ffffff', nb: '#7f1d1d' }],
  // lines only (no label)
  ['tstop', 'Trailing: stop', 'Segments (line only)', '#ff9f43', 'solid', 3, null],
  ['tact', 'Trailing: start level', 'Segments (line only)', '#5ad1e6', 'solid', 3, null],
  ['tnext', 'Trailing: next step', 'Segments (line only)', '#a3e635', 'solid', 3, null],
  ['beplus', 'BE+', 'Segments (line only)', '#e879f9', 'solid', 3, null],
  ['beauto', 'Auto BE', 'Segments (line only)', '#e879f9', 'dashed', 3, null],
  ['hhigh', 'Last swing high', 'Segments (line only)', '#3ecf8e', 'solid', 2, null],
  ['hlow', 'Last swing low', 'Segments (line only)', '#ff6b61', 'solid', 2, null],
];
const SEGS = new Set(['tstop', 'tact', 'tnext', 'beplus', 'beauto']); // these also have a length
const BY = Object.fromEntries(ELEMENTS.map((e) => [e[0], e]));
const LABEL_FIELDS = ['cbg', 'cbo', 'cbw', 'cn', 'cnb', 'cfs', 'cfw'];
const FIELDS = ['lc', 'ls', 'lw', 'll', ...LABEL_FIELDS];
const HEX = /^#[0-9a-f]{6}$/i;

/** Settings with their default values (only the line ones: the label ones are empty = card style). */
function defaults() {
  const d = {};
  for (const [k, , , c, s, w] of ELEMENTS) Object.assign(d, { ['lc_' + k]: c, ['ls_' + k]: s, ['lw_' + k]: String(w) }, SEGS.has(k) ? { ['ll_' + k]: '' } : {});
  return d;
}

/** Style of one element from the settings: { c, s, w, l, lab: { bg, bo, bw, n, nb, fs, fw } | null }. */
function styleOf(ui, k) {
  const e = BY[k];
  if (!e) return null;
  const [, , , c0, s0, w0, lab0] = e;
  const v = (f) => ui[f + '_' + k];
  const hex = (f, d) => (HEX.test(v(f)) ? v(f) : d);
  const st = { c: hex('lc', c0), s: DASHES.includes(v('ls')) ? v('ls') : s0, w: Math.min(6, Math.max(1, Math.round(+v('lw')) || w0)) };
  if (SEGS.has(k)) {
    const l = Math.round(+v('ll'));
    st.l = l >= 4 && l <= 400 ? l : 0;
  }
  if (!lab0) return { ...st, lab: null };
  const bw = v('cbw');
  const fs = Math.round(+v('cfs'));
  // name fill: '' = the default of the element, 'none' = no fill, #hex = that colour
  const nb = v('cnb') === 'none' ? '' : HEX.test(v('cnb')) ? v('cnb') : lab0.nb || '';
  st.lab = {
    bg: hex('cbg', ''),
    bo: hex('cbo', lab0.n ? lab0.bo : ''), // own elements (USER, GRID): their border; the others: the card style's
    bw: bw !== '' && bw != null && Number.isFinite(+bw) ? Math.min(4, Math.max(0, Math.round(+bw))) : null,
    n: hex('cn', lab0.n || ''),
    nb,
    fs: fs >= 8 && fs <= 22 ? fs : 0,
    fw: v('cfw') === 'b' || v('cfw') === 'n' ? v('cfw') : '',
  };
  return st;
}

/** All the elements: { kind: style }. */
const styles = (ui) => Object.fromEntries(ELEMENTS.map(([k]) => [k, styleOf(ui, k)]));

/** Value shown in the editor for a field (the effective one, also when it is still the default). */
function shown(ui, k, f) {
  const e = BY[k];
  const s = styleOf(ui, k);
  if (!e || !s) return '';
  if (f === 'lc') return s.c;
  if (f === 'ls') return s.s;
  if (f === 'lw') return String(s.w);
  if (f === 'll') return s.l ? String(s.l) : '';
  if (!s.lab) return '';
  const lab0 = e[6];
  if (f === 'cbg') return s.lab.bg || '#17181b';
  if (f === 'cbo') return s.lab.bo || lab0.bo || '#2a2f3a';
  if (f === 'cbw') return s.lab.bw == null ? '' : String(s.lab.bw);
  if (f === 'cn') return s.lab.n || s.c;
  if (f === 'cnb') return s.lab.nb || lab0.nb || s.c;
  if (f === 'cnbOn') return !!s.lab.nb;
  if (f === 'cfs') return s.lab.fs ? String(s.lab.fs) : '';
  if (f === 'cfw') return s.lab.fw;
  return '';
}

module.exports = { DASHES, ELEMENTS, SEGS, FIELDS, LABEL_FIELDS, defaults, styleOf, styles, shown };
