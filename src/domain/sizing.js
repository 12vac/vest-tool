// Leverage, size from percentage, side and entry order bodies. PURE.
// Sizing rules worked out from how Vest's own order ticket behaves; not verified on the live site.

const { floorStep, decimalsOf } = require('./num');

const EPS = 1e-9;
const SPREAD = 0.001; // Vest's ticket keeps 0.1% aside for the spread
const FALLBACK_MAX_LEVERAGE = 5;

/** Leverage allowed by a margin ratio (0.02 -> 50x); null when the ratio is missing or not positive. */
const leverageOf = (ratio) => (ratio > 0 ? Math.floor(1 / ratio + EPS) : null);
const isSet = (v) => v !== null && v !== undefined && !Number.isNaN(v);

/**
 * Maximum leverage of an account on a market. Sources, first one that applies:
 * 1. the account's own plan, if the market lists it (capitalPlans);
 * 2. the generic ratio for capital accounts (or, if absent, for funded ones);
 * 3. the account's leverage, capped by the market's (5x if the account's is unknown).
 * margin = { initMarginRatio, capitalInitMarginRatio, fundedInitMarginRatio, capitalPlans: [{ accountType, planId, initMarginRatio }] }
 * acc = { accountType, planId, maxLeverage }
 */
function maxLeverageFor(margin, acc) {
  if (!margin) return null;
  const marketCap = leverageOf(margin.initMarginRatio);
  if (!acc) return marketCap;
  const plans = margin.capitalPlans || [];
  const own = plans.find((pl) => pl.planId === acc.planId && pl.accountType === acc.accountType);
  if (own) return leverageOf(own.initMarginRatio);
  const generic = 'capitalInitMarginRatio' in margin && margin.capitalInitMarginRatio !== undefined ? margin.capitalInitMarginRatio : margin.fundedInitMarginRatio;
  if (isSet(generic)) return leverageOf(generic);
  const accountLev = acc.maxLeverage > 0 ? acc.maxLeverage : FALLBACK_MAX_LEVERAGE;
  return marketCap ? Math.min(marketCap, accountLev) : accountLev;
}

/** Order leverage: the one saved on Vest when it is within (0, max]; otherwise the max. */
function orderLeverage(saved, max) {
  const usable = saved > 0 && max > 0 && saved <= max;
  if (usable) return saved;
  return max || null;
}

/** Position dollars the account can open. */
function tradingPower({ free, upnl, leverage, takerFee }) {
  if (!(leverage > 0) || !(free > 0)) return 0;
  return (Math.max(0, free + Math.min(0, upnl || 0)) * leverage) / (1 + leverage * (takerFee || 0)) / (1 + SPREAD);
}

/** Maximum size and size for a percentage of the maximum (rounded down to the step). */
const maxQty = (power, price, step) => (power > 0 && price > 0 ? floorStep(power / price, step) : 0);
const qtyForPct = (max, pct, step) => (max > 0 && pct > 0 ? floorStep((max * Math.min(100, pct)) / 100, step) : 0);

/**
 * Side of an entry order from the price where it is dropped compared to the current price.
 * LIMIT: below = buy (long), above = sell (short). STOP: above = buy, below = sell.
 */
function entrySide(kind, price, mark) {
  if (!(price > 0) || !(mark > 0) || price === mark) return null;
  if (kind === 'lm') return price < mark ? 'long' : 'short';
  if (kind === 'st') return price > mark ? 'long' : 'short';
  return null;
}

/** An entry level too close to the price (less than minTicks ticks) would fill at once: refused. */
const tooClose = (price, mark, tick, minTicks = 2) => Math.abs(price - mark) < minTicks * tick - EPS;

/** Has the local stop triggered? Long: price >= trigger. Short: price <= trigger. */
const stopHit = (side, trigger, price) => (side === 'long' ? price >= trigger : price <= trigger);

const fmt = (v, step) => v.toFixed(decimalsOf(step));

/** New position (market IOC or limit GTC), without SL/TP: they are placed later from the chart. Body as Vest's ticket. */
function openOrder({ symbol, side, qty, leverage, step, tick, type, price }) {
  const body = {
    orderType: type,
    leverage: String(leverage),
    side,
    symbol,
    quantity: fmt(qty, step),
    timeInForce: type === 'limit' ? 'GTC' : 'IOC',
    takeProfits: [],
    stopLosses: [],
  };
  if (type === 'limit') body.price = fmt(price, tick);
  return { method: 'POST', path: '/v3/positions/open', body };
}

/** Add to a position on the same side. */
function appendOrder({ pos, qty, leverage, step, tick, type, price }) {
  const body = {
    symbol: pos.symbol,
    positionId: pos.id,
    orderType: type,
    quantity: fmt(qty, step),
    leverage: String(leverage),
    isBuy: pos.side === 'long',
    timeInForce: type === 'limit' ? 'GTC' : 'IOC',
  };
  if (type === 'limit') body.price = fmt(price, tick);
  return { method: 'POST', path: '/v3/positions/append', body };
}

/** Market reduction, reduce only. */
function reduceOrder({ pos, qty, leverage, step }) {
  return {
    method: 'POST',
    path: '/v3/positions/reduce',
    body: {
      positionId: pos.id,
      orderType: 'market',
      leverage: String(leverage),
      quantity: fmt(qty, step),
      timeInForce: 'IOC',
      reduceOnly: true,
      symbol: pos.symbol,
    },
  };
}

module.exports = { maxLeverageFor, orderLeverage, tradingPower, maxQty, qtyForPct, entrySide, tooClose, stopHit, openOrder, appendOrder, reduceOrder, SPREAD };
