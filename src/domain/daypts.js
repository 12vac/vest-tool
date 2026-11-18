// Points made by the accounts, from Vest's history. PURE.
// Rows of GET /v3/positions?account_id=... (closed ones too): positionId, side, openPrice, closePrice, closeDate, quantity.
// A closed position counts (close - entry) in its direction, regardless of the
// size: it is "how many points I made", not the $ P&L. [D] partial closes: Vest averages them into closePrice.

const num = (v) => (v == null || v === '' ? NaN : +v);
// anomalous row (seen on the site: -28866 pt, i.e. a close price ~0): a move beyond 3% of the price (NQ ~870 pt)
// is not a plausible intraday trade. [D] on a trade held for days it could discard a real trade.
const MAX_MOVE = 0.03;

/** Instant (ms) from a Vest date field: ms, seconds or ISO text. NaN if missing. */
function msOf(v) {
  if (v == null || v === '') return NaN;
  const n = +v;
  if (Number.isFinite(n)) return n > 0 && n < 1e12 ? n * 1000 : n;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : NaN;
}

/** Points of a CLOSED position, or null (open, without prices, anomalous). */
function rowPoints(r) {
  if (!r || !(msOf(r.closeDate ?? r.closedAt ?? r.close_date) > 0)) return null;
  const o = num(r.openPrice ?? r.open_price),
    c = num(r.closePrice ?? r.close_price);
  if (!(o > 0) || !(c > 0) || Math.abs(c - o) > o * MAX_MOVE) return null;
  return String(r.side).toLowerCase() === 'short' ? o - c : c - o;
}

/** { position id: points } of the valid closed positions of a history page. */
function closedPoints(rows) {
  const out = {};
  for (const r of rows || []) {
    const id = r && (r.positionId || r.position_id);
    const p = rowPoints(r);
    if (id && p != null) out[id] = p;
  }
  return out;
}

/** { position id: { pts, at } } of the valid closed positions: points and close time (ms). */
function closedPointsAt(rows) {
  const out = {};
  for (const r of rows || []) {
    const id = r && (r.positionId || r.position_id);
    const p = rowPoints(r);
    if (id && p != null) out[id] = { pts: p, at: msOf(r.closeDate ?? r.closedAt ?? r.close_date) };
  }
  return out;
}

/** Points and count of the positions closed from t0 (ms) on, from a map { id: { pts, at } }. */
function sumSince(map, t0) {
  let pts = 0,
    n = 0;
  for (const v of Object.values(map || {})) {
    if (!v || !(v.at >= t0)) continue;
    pts += v.pts;
    n++;
  }
  return { pts, n };
}

/** Sum of the points in a map { id: points }. */
const sumPoints = (map) => Object.values(map || {}).reduce((s, v) => s + v, 0);

module.exports = { rowPoints, closedPoints, closedPointsAt, sumSince, sumPoints, msOf, MAX_MOVE };
