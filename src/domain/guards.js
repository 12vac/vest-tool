// ACCOUNT LIMITS guard (Gerry 2026-11-21): every bar of the Account limits section can close everything (FLAT) when its
// level is reached. Each row has an ON / OFF switch (in memory only: OFF after every reload) and a level set with a slider.
// Pure functions: values from the account, slider range, which rows fire.

// Order and names from Gerry 2026-11-23 (DAILY LOSS LIMIT and CURRENT PROFIT added; the others renamed).
// MARGIN USED / MARGIN USED + ORDERS: bars only, no FLAT setting (Gerry 2026-11-23)
const ROWS = {
  dg: { name: 'DAILY PROFIT TARGET', unit: '$', dir: 'up' }, // FLAT when today's P&L reaches +$X (profit kept)
  dl: { name: 'DAILY LOSS LIMIT', unit: '$', dir: 'up' }, // FLAT when today's P&L reaches -$X (today's loss = X)
  cp: { name: 'MAX OPEN PROFIT', unit: '$', dir: 'up' }, // FLAT when the open profit reaches $X
  rk: { name: 'MAX OPEN LOSS', unit: '$', dir: 'up' }, // FLAT when the open loss reaches $X
  dd: { name: 'DAILY DRAWDOWN BUFFER', unit: '$', dir: 'down' }, // FLAT when only $X are left before the daily loss limit
  dm: { name: 'MAX DRAWDOWN BUFFER', unit: '$', dir: 'down' }, // FLAT when only $X are left before the drawdown limit
  tg: { name: 'ACCOUNT PROFIT TARGET', unit: '$', dir: 'up' }, // FLAT when the account P&L reaches $X
};
const KEYS = Object.keys(ROWS);

/** Values compared with the levels. risk: { marginPos, marginAll }, limits: limitsOf(), openLoss / openProfit: $ (>= 0). */
function values({ risk = {}, limits = {}, openLoss, openProfit }) {
  return {
    dg: limits.dayPl,
    dl: Number.isFinite(limits.dayPl) ? Math.max(0, -limits.dayPl) : NaN,
    cp: openProfit,
    rk: openLoss,
    dd: limits.dayLeft,
    dm: limits.maxLeft,
    tg: limits.pl,
  };
}

/** 1 / 2 / 5 x 10^n at or above v. */
function niceUp(v) {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const r = v / p;
  return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10) * p;
}
/** 1 / 2 / 5 x 10^n at or below v. */
function niceDown(v) {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const r = v / p;
  return (r >= 5 ? 5 : r >= 2 ? 2 : 1) * p;
}

// How each row is set (Gerry 2026-11-21): slider ON the bar for the margins (0-100 %) and the open loss (0 .. the most it can
// lose today); a number for the others. No level beyond the account's own limit.
const KIND = { cp: 'slider', rk: 'slider', dg: 'num', dl: 'num', dd: 'num', dm: 'num', tg: 'num' };

/** Highest level of each row (NaN = no cap): margins 100 %, open loss = room to the daily loss limit, the left-rows their
 *  limit, profit target the account target. */
function caps({ risk = {}, limits = {} }) {
  const fin = (x) => (Number.isFinite(x) && x > 0 ? x : NaN);
  const room = (Number.isFinite(risk.used) ? Math.max(0, risk.used) : 0) + (Number.isFinite(risk.left) ? Math.max(0, risk.left) : 0);
  const rk = fin(room) || fin(limits.dayLimit) || fin(limits.maxLimit);
  // current profit: up to what is missing to the account target, else the same range as the current loss
  const toGoal = fin(limits.goal) && Number.isFinite(limits.pl) ? fin(limits.goal - limits.pl) : NaN;
  return { cp: toGoal || rk, rk, dg: NaN, dl: fin(limits.dayLimit), dd: fin(limits.dayLimit), dm: fin(limits.maxLimit), tg: fin(limits.goal) };
}

/**
 * Price of the chart market at which a $ row reaches its level, with the open position there and everything else unchanged
 * (fees and funding excluded). base: { dayPl, upnl, dayLeft, maxLeft, pl } now; pos: { side, qty }; mark: price now.
 * NaN for % rows, no position, or a level the price cannot reach (<= 0).
 */
function priceOf(k, level, base, pos, mark) {
  if (!ROWS[k] || ROWS[k].unit !== '$' || !(level > 0) || !pos || !(pos.qty > 0) || !(mark > 0)) return NaN;
  const now = { dg: base.dayPl, dl: base.dayPl, cp: base.upnl, rk: base.upnl, dd: base.dayLeft, dm: base.maxLeft, tg: base.pl }[k];
  const want = k === 'dl' || k === 'rk' ? -level : level; // P&L-like value that fires
  if (!Number.isFinite(now)) return NaN;
  const px = mark + (want - now) / ((pos.side === 'long' ? 1 : -1) * pos.qty);
  return px > 0 ? px : NaN;
}

/** "$ left" rows: the level must be BELOW the limit (at the limit they would fire at the first cent lost). */
const LEFT_ROWS = new Set(['dd', 'dm']);
/** A typed level that cannot be used: a "$ left" row at or above its limit (Gerry 2026-11-23). */
const tooHigh = (k, raw, cap) => LEFT_ROWS.has(k) && cap > 0 && parseFloat(raw) >= cap;

/** Level in force: what was set, never above the cap; profit target left empty = the account target (automatic).
 *  "$ left" rows at or above their limit: not set (0), never capped to the limit. */
function levelOf(k, raw, cap) {
  const v = parseFloat(raw);
  if (!(v > 0)) return k === 'tg' && cap > 0 ? cap : 0;
  if (tooHigh(k, raw, cap)) return 0;
  return cap > 0 ? Math.min(v, cap) : v;
}

/** Slider step: about 1/200 of the range, 1 / 2 / 5 x 10^n. */
const stepOf = (k, cap) => (cap > 0 ? niceDown(cap / 200) : 1);

/** Has the row reached its level? A level of 0 / empty = not set (never fires). */
function reached(k, value, level) {
  if (!ROWS[k] || !(level > 0) || !Number.isFinite(value)) return false;
  return ROWS[k].dir === 'up' ? value >= level : value <= level;
}

/** Rows that fire now: [{ k, value, level }] among those switched ON. */
function firing(vals, on, levels) {
  return KEYS.filter((k) => on[k] && reached(k, vals[k], +levels[k])).map((k) => ({ k, value: vals[k], level: +levels[k] }));
}

/** Text of a level: "FLAT at >= 80 %" / "FLAT at <= $3.00". */
function levelText(k, level, auto) {
  if (!(level > 0)) return k === 'tg' ? 'no target: set one' : 'level not set';
  const r = ROWS[k];
  const v = r.unit === '%' ? `${+(+level).toFixed(2)} %` : `$${(+level).toFixed(2)}`;
  return `FLAT ${r.dir === 'up' ? '≥' : '≤'} ${v}${auto ? ` (${auto === true ? 'Vest target' : auto})` : ''}`;
}

module.exports = { ROWS, KEYS, KIND, values, caps, levelOf, tooHigh, stepOf, reached, firing, levelText, priceOf, niceUp, niceDown };
