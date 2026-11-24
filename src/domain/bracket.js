// BRACKET follows a DCA (pure): after an add moved the average entry, where SL and TP should go to keep the bracket
// distances from the NEW average. Returns the moves to make, or a reason when nothing is done.
// Since v0.20.62 the average is AVG ALL (position + entry LIMITs waiting on the same side, Gerry 2026-11-23) and the SL
// never sits between two entries: if avg - SL is at or past the farthest LIMIT, the SL goes SL points beyond that LIMIT.
const { roundToTick } = require('./num');

/**
 * side 'long'|'short', avg = new average entry (AVG ALL), oldAvg = average before the add, sl / tp = distances in points
 * (tp NaN = none), far = farthest entry LIMIT waiting (optional),
 * legs = [{ id, kind 'sl'|'tp', price, qty }], tick.
 * Rules: one SL and at most one TP are moved (several partial legs: left alone, they were placed on purpose);
 * a SL already at breakeven or in profit of the OLD entry (BE / trailing / safe runner moved it) is left where it is;
 * a missing SL is added, a missing TP is added only if a TP distance is set.
 * -> { moves: [{ kind, leg|null, price }], skip: [text] }
 */
function follow({ side, avg, oldAvg, sl, tp, legs, tick, far }) {
  const d = side === 'long' ? 1 : -1;
  const moves = [],
    skip = [];
  if (!(avg > 0) || !(tick > 0)) return { moves, skip: ['no entry price'] };
  const sls = legs.filter((l) => l.kind === 'sl'),
    tps = legs.filter((l) => l.kind === 'tp');
  if (sl > 0) {
    let px = roundToTick(avg - d * sl, tick, d > 0 ? 'down' : 'up');
    // a LIMIT at or beyond that SL would never fill before it: the SL goes beyond the farthest LIMIT
    if (far > 0 && d * (px - far) > -tick / 2) px = roundToTick(far - d * sl, tick, d > 0 ? 'down' : 'up');
    if (sls.length > 1) skip.push('more than one SL: not moved');
    else if (sls.length === 1 && oldAvg > 0 && d * (sls[0].price - oldAvg) >= 0) skip.push(`SL ${sls[0].price} already at breakeven or in profit: not moved`);
    else if (!sls.length || Math.abs(sls[0].price - px) >= tick / 2) moves.push({ kind: 'sl', leg: sls[0] || null, price: px });
  }
  if (tp > 0) {
    const px = roundToTick(avg + d * tp, tick, d > 0 ? 'up' : 'down');
    if (tps.length > 1) skip.push('more than one TP: not moved');
    else if (!tps.length || Math.abs(tps[0].price - px) >= tick / 2) moves.push({ kind: 'tp', leg: tps[0] || null, price: px });
  }
  return { moves, skip };
}

module.exports = { follow };
