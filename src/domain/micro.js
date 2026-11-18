// Vest size (index units, $1 per point) expressed in CME micro contracts. Only markets with a known micro.
// MNQ $2/pt, MES $5/pt, MYM $0.5/pt, M2K $5/pt, MGC 10 oz, MCL 100 barrels.
const MICRO = [
  [/^(NQ|NDX|NAS100|US100)\b/i, 'MNQ', 2],
  [/^(ES|SPX|SP500|US500)\b/i, 'MES', 5],
  [/^(YM|DJI|US30)\b/i, 'MYM', 0.5],
  [/^(RTY|RUT|US2000)\b/i, 'M2K', 5],
  [/^(GC|XAU|GOLD)\b/i, 'MGC', 10],
  [/^(CL|WTI|OIL)\b/i, 'MCL', 100],
];

/** { qty, name } of the micros equivalent to `qty` units of market `label` (or `symbol`), or null. */
function microOf(qty, label, symbol) {
  const q = +qty;
  if (!(q > 0)) return null;
  for (const s of [label, symbol])
    for (const [re, name, mult] of MICRO) if (s && re.test(String(s))) return { qty: q / mult, name };
  return null;
}

module.exports = { microOf };
