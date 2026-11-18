// Bodies of the position orders (close, stop, target) and their checks. PURE.
// Order bodies for Vest's REST API (close, stop-loss/take-profit POST/PUT/DELETE).

const { roundToTick, decimalsOf } = require('./num');

const DEFAULT_LEVERAGE = '50'; // 50 when the position's leverage is unknown: Vest requires the field
const BE_CLEAR_TICKS = 2; // [D] minimum price-stop distance for Vest to accept the stop

/** Market close of the whole position. */
function closeOrder(pos) {
  return {
    method: 'POST',
    path: '/v3/positions/close',
    body: {
      symbol: pos.symbol,
      positionId: pos.id,
      orderType: 'market',
      leverage: pos.leverage > 0 ? String(pos.leverage) : DEFAULT_LEVERAGE,
    },
  };
}

/**
 * New stop/target (POST) or move of an existing one (PUT with its id).
 * A leg with its own quantity (scale-out) keeps it; without a quantity it covers the whole position.
 */
function legOrder(pos, kind, price, tick, existing) {
  const body = { positionId: pos.id, executionType: 'market', triggerPrice: price.toFixed(decimalsOf(tick)) };
  if (existing) {
    body[kind === 'sl' ? 'stopLossId' : 'takeProfitId'] = existing.id;
    if (existing.qty > 0) body.quantity = String(existing.qty);
  }
  return {
    method: existing ? 'PUT' : 'POST',
    path: kind === 'sl' ? '/v3/positions/stop-loss' : '/v3/positions/take-profit',
    body,
  };
}

/**
 * Removal of a stop/target: DELETE with { positionId, stopLossId | takeProfitId }.
 * Fields as used by Vest's own web app. JSON body [D].
 */
function legDeleteOrder(pos, leg) {
  return {
    method: 'DELETE',
    path: leg.kind === 'sl' ? '/v3/positions/stop-loss' : '/v3/positions/take-profit',
    body: { positionId: pos.id, [leg.kind === 'sl' ? 'stopLossId' : 'takeProfitId']: leg.id },
  };
}

/**
 * Is a stop/target level acceptable compared to the current price?
 * Long: SL below the price, TP above. Short: the opposite. With a margin of BE_CLEAR_TICKS ticks.
 */
function checkLeg({ kind, side, price, mark, tick }) {
  if (!(price > 0)) return 'invalid price';
  if (!(mark > 0)) return 'current price not available';
  const gap = BE_CLEAR_TICKS * tick;
  const below = price <= mark - gap,
    above = price >= mark + gap;
  const long = side === 'long';
  if (kind === 'sl' && (long ? !below : !above)) return `the stop must be ${long ? 'below' : 'above'} the current price`;
  if (kind === 'tp' && (long ? !above : !below)) return `the target must be ${long ? 'above' : 'below'} the current price`;
  return null;
}

/**
 * Breakeven price: the entry plus offPts points of profit (BE+), rounded to the tick on the profit side
 * (never less than the requested profit, never at a loss).
 */
const breakevenPrice = (side, entry, tick, offPts = 0) =>
  roundToTick(entry + (side === 'long' ? 1 : -1) * Math.max(0, offPts || 0), tick, side === 'long' ? 'up' : 'down');

/** Breakeven plan (offPts = profit in points, 0 = entry): { price, existing } or { why } if it cannot be done now. */
function breakevenPlan(pos, mark, tick, offPts = 0) {
  const price = breakevenPrice(pos.side, pos.openPrice, tick, offPts);
  const sls = pos.triggers.filter((t) => t.kind === 'sl');
  if (sls.length > 1) return { why: 'more than one stop: drag the right one' };
  const existing = sls[0] || null;
  if (existing && (pos.side === 'long' ? existing.price >= price : existing.price <= price))
    return { why: 'the stop is already at breakeven or beyond' };
  const bad = checkLeg({ kind: 'sl', side: pos.side, price, mark, tick });
  if (bad) return { why: `the price must first pass ${offPts > 0 ? 'the BE+ level (' + price + ')' : 'the entry'} by ${BE_CLEAR_TICKS} ticks (${bad})` };
  return { price, existing };
}

module.exports = { closeOrder, legOrder, legDeleteOrder, checkLeg, breakevenPrice, breakevenPlan, DEFAULT_LEVERAGE };
