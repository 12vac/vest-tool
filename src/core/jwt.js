// LOCAL decoding of a JWT payload (no signature check: only used to read userId/accountId/exp).
function decodeJwt(t) {
  try {
    const segment = String(t).split('.')[1];
    const b64 = segment.replace(/[-_]/g, (ch) => (ch === '-' ? '+' : '/'));
    const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, '=');
    return JSON.parse(atob(padded));
  } catch {
    return {};
  }
}

/** Expiry in ms; accepts seconds or milliseconds (Vest uses both depending on the field). */
const toMs = (v) => {
  const n = Number.parseFloat(v);
  if (!(n > 0)) return 0;
  return n < 1e11 ? n * 1000 : n;
};

module.exports = { decodeJwt, toMs };
