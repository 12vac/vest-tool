// REST transport to Vest. Allowed: GET, the account token mint and ONLY the orders listed in ORDER_WRITES,
// and those only with the 'Orders' switch on (setOrdersEnabled). Everything else is refused here.

const { nativeFetch } = require('./hooks');
const log = require('../diag/log');

const API = 'https://api-gateway.hz.vestmarkets.com';
const READ_TIMEOUT_MS = 15000;
const ALLOWED_WRITES = new Set(['POST /v3/auth/account-token']);
const ORDER_WRITES = new Set([
  'POST /v3/positions/close',
  'POST /v3/positions/stop-loss',
  'PUT /v3/positions/stop-loss',
  'POST /v3/positions/take-profit',
  'PUT /v3/positions/take-profit',
  'DELETE /v3/positions/stop-loss',
  'DELETE /v3/positions/take-profit',
  'POST /v3/positions/cancel-order',
  // entries from the second card: limit/market, add, reduce
  'POST /v3/positions/open',
  'POST /v3/positions/append',
  'POST /v3/positions/reduce',
]);
// emergency FLATTEN ALL: closes and cancellations only, allowed even with 'Orders' off (they only reduce risk)
const EMERGENCY_WRITES = new Set(['POST /v3/positions/close', 'POST /v3/positions/cancel-order']);
let ordersEnabled = false; // never persisted: after a reload it starts off
const setOrdersEnabled = (v) => (ordersEnabled = !!v);

const rate = { remaining: null, limit: null, at: 0 };

class HttpError extends Error {
  constructor(path, status, body) {
    super(`${path} -> HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

/**
 * request(path, { token, method, body, shapeKey })
 * token: Bearer to use (null = public endpoint). Returns the response JSON.
 */
async function request(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const bare = path.split('?')[0];
  const op = method + ' ' + bare;
  const isOrder = ORDER_WRITES.has(op);
  if (method !== 'GET' && !ALLOWED_WRITES.has(op)) {
    if (!isOrder) throw new Error(`blocked: ${op} (not allowed)`);
    if (!ordersEnabled && !(opts.emergency && EMERGENCY_WRITES.has(op))) throw new Error('orders off: switch them on in the panel');
  }
  if (!path.startsWith('/v3/')) throw new Error('path not allowed: ' + bare);
  const headers = { Accept: 'application/json' };
  if (opts.token) headers.Authorization = 'Bearer ' + opts.token;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

  // timeout on reads only: an order interrupted halfway has an unknown outcome (better to wait for the answer)
  const ctl = isOrder ? null : new AbortController();
  const timer = isOrder ? null : setTimeout(() => ctl.abort(), READ_TIMEOUT_MS);
  let r;
  try {
    r = await nativeFetch(API + path, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: ctl ? ctl.signal : undefined,
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch (e) {
    throw new Error(`${bare}: ${e.name === 'AbortError' ? 'timeout' : 'network'}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
  noteRate(r.headers);
  const text = await r.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!r.ok) {
    const why = json && (json.message || json.msg || json.error);
    // 401: token rotated by Vest, handled by session.js (renewal + one retry); if it does not recover the caller says so
    if (r.status !== 401) log.warn(`${method} ${bare} -> ${r.status}${why ? ': ' + String(why).slice(0, 120) : ''}`);
    throw new HttpError(bare, r.status, json);
  }
  if (opts.shapeKey) log.noteShape(opts.shapeKey, json);
  return json;
}

/** Vest's request budget from the response headers (x-ratelimit-*), shown in the panel. */
function noteRate(h) {
  const left = h && typeof h.get === 'function' ? h.get('x-ratelimit-remaining') : null;
  if (left === null || left === undefined) return;
  rate.remaining = Number(left);
  rate.limit = Number(h.get('x-ratelimit-limit')) || rate.limit;
  rate.at = Date.now();
}

module.exports = { request, rate, HttpError, API, setOrdersEnabled, ordersEnabled: () => ordersEnabled };
