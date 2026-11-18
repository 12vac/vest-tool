// Everything in dollars. Vest linear contracts: P&L = (price - entry) x quantity x pointValue (pointValue 1 USD).
// PURE. Fees and slippage are NOT included: a "$100" SL can cost more (stop at market).

const { roundToTick } = require('./num');

const dirOf = (side) => {
  if (side === 'long') return 1;
  if (side === 'short') return -1;
  throw new Error('invalid side: ' + side);
};

/** $ P&L of a position at the given price. */
function pnlUsd(side, qty, entry, price, pointValue = 1) {
  return dirOf(side) * qty * (price - entry) * pointValue;
}

/**
 * SL or TP price for a dollar amount.
 * SL: risk <= usd (the price is rounded toward the entry, never beyond).
 * TP: tick nearest to the requested amount.
 * Returns { price, usd } with usd = actual amount after rounding (SL negative, TP positive).
 */
function priceForUsd({ kind, side, qty, entry, usd, tick, pointValue = 1 }) {
  if (kind !== 'sl' && kind !== 'tp') throw new Error('kind must be sl or tp');
  if (!(qty > 0)) throw new Error('invalid quantity');
  if (!(entry > 0)) throw new Error('invalid entry price');
  if (!(usd > 0)) throw new Error('$ amount must be > 0');
  if (!(tick > 0)) throw new Error('invalid tick');
  const d = dirOf(side);
  const dist = usd / (qty * pointValue); // distance in price
  const sign = kind === 'sl' ? -d : d; // long SL below, short SL above; TP the opposite
  const raw = entry + sign * dist;
  let mode = 'nearest';
  if (kind === 'sl') mode = sign < 0 ? 'up' : 'down'; // toward the entry
  const price = roundToTick(raw, tick, mode);
  if (!(price > 0)) throw new Error('resulting price <= 0');
  if (price === entry) throw new Error(`$${usd} is less than one tick with this quantity`);
  const eff = pnlUsd(side, qty, entry, price, pointValue);
  if (kind === 'sl' && !(eff < 0)) throw new Error('SL on the wrong side');
  if (kind === 'tp' && !(eff > 0)) throw new Error('TP on the wrong side');
  return { price, usd: eff };
}

/** $ value of one tick for this quantity. */
const tickValueUsd = (qty, tick, pointValue = 1) => qty * tick * pointValue;

module.exports = { dirOf, pnlUsd, priceForUsd, tickValueUsd };
