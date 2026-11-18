// Price <-> pixel on the chart's main pane, linear or logarithmic scale. PURE.
// vr = { from, to, log } visible price range; height = pane height in px (y = 0 at the top).

/** Position of a price along the axis: the price itself, or its log on a log scale. */
const axis = (vr, price) => (vr.log ? Math.log(price) : price);

function priceToY(price, vr, height) {
  const top = axis(vr, vr.to);
  const span = top - axis(vr, vr.from);
  return (height * (top - axis(vr, price))) / span;
}

function yToPrice(y, vr, height) {
  const top = axis(vr, vr.to);
  const span = top - axis(vr, vr.from);
  const a = top - (span * y) / height;
  return vr.log ? Math.exp(a) : a;
}

/** Bars of right margin needed to leave `px` free after the last candle. */
const roomBars = (px, barSpacing) => (barSpacing > 0 ? Math.ceil(px / barSpacing) + 1 : 0);

module.exports = { priceToY, yToPrice, roomBars };
