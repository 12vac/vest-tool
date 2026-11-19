// Docked panel: Vest's page is narrowed by W px on the right and the panel fills that column at full height.
// Done with one <style> added to Vest's page (narrower <body>); switching off removes it and the page is exactly as before.
// The panel and the chart overlay hang on <html>, outside <body>, so they are not narrowed with it.
// transform on <body>: Vest's position:fixed elements (top bar, dialogs) are placed inside the narrowed body, not under the column.
const STYLE_ID = 'vt-dock-style';
const CLS = 'vt-dock';
let cur = 0; // width applied now, 0 = not docked

function css(w) {
  return `html.${CLS} { overflow: hidden !important; }
html.${CLS} body { position: relative !important; width: calc(100vw - ${w}px) !important; min-width: 0 !important;
  max-width: calc(100vw - ${w}px) !important; height: 100vh !important; overflow: hidden !important; transform: translateZ(0) !important; }`;
}

/** w > 0: dock with that width; 0: undock. Returns true when something changed. */
function apply(w) {
  w = w > 0 ? Math.round(w) : 0;
  if (w === cur) return false;
  cur = w;
  const old = document.getElementById(STYLE_ID);
  if (old) old.remove();
  document.documentElement.classList.toggle(CLS, w > 0);
  if (w > 0) {
    const tag = Object.assign(document.createElement('style'), { id: STYLE_ID, textContent: css(w) });
    document.documentElement.append(tag); // after Vest's own styles, so these rules win
  }
  // Vest and the TradingView chart measure themselves again on resize
  setTimeout(() => window.dispatchEvent(new Event('resize')), 0);
  return true;
}

module.exports = { apply, width: () => cur, css };
