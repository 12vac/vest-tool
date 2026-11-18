// Vest HTML elements over the chart to hide when the trade overlay replaces them.
// Seen on the site (Inspect): hovering the position line, Vest shows buttons
// <button data-testid="chart-chip-tp"> / "chart-chip-sl" in a <div class="fixed ..."> of the main page (not in the chart).
// They are hidden with ONE CSS rule added/removed: no change to Vest's elements, no simulated clicks.

const RULE = '[data-testid^="chart-chip-"] { display: none !important; }';
let style = null;

function setHidden(on) {
  if (on && !style) {
    style = document.createElement('style');
    style.textContent = RULE;
    (document.head || document.documentElement).appendChild(style);
  } else if (!on && style) {
    style.remove();
    style = null;
  }
}

module.exports = { setHidden, RULE };
