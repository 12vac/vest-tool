// Data shapes: only field NAMES and TYPES, never values. Used by the startup check and the diagnostics
// (shareable without exposing tokens, ids or amounts). PURE.

/** Describes a value: recursive { field: type }, array -> [shape of the first element]. */
function describe(v, depth = 3) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return depth > 0 && v.length ? [describe(v[0], depth - 1)] : [];
  if (typeof v === 'object') {
    if (depth <= 0) return 'object';
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = describe(v[k], depth - 1);
    return out;
  }
  return typeof v; // 'string' | 'number' | 'boolean'
}

/** Required fields missing in obj. */
const missing = (obj, keys) => (obj && typeof obj === 'object' ? keys.filter((k) => !(k in obj)) : keys.slice());

/** Removes from any text whatever looks like a JWT or a Bearer (for logs and diagnostics). */
const redact = (s) =>
  String(s)
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, '[JWT]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [X]')
    .replace(/listenKey=[^&\s"']+/gi, 'listenKey=[X]');

module.exports = { describe, missing, redact };
