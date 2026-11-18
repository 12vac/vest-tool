// Session: USER token from Vest's session channel (BroadcastChannel 'vest-session-sync'),
// fallback on the Authorization header of the page's XHRs only if the channel is silent.
// ACCOUNT tokens minted with POST /v3/auth/account-token, cached until 60 s before expiry.
// Tokens live ONLY in this closure: never on window, never in storage, never in the log.

const { decodeJwt, toMs } = require('./jwt');
const { request, HttpError } = require('./transport');
const log = require('../diag/log');
const hooks = require('./hooks');

const CHANNEL = 'vest-session-sync';
const RENEW_MARGIN_MS = 60000;
const FALLBACK_AFTER_MS = 5000;

let user = null; // { token, exp, uid, source }
let bc = null;
let xhrTapped = false;
const waiters = new Set();
const listeners = new Set();

const status = () =>
  user
    ? { state: user.exp - Date.now() > 5000 ? 'ok' : 'expired', source: user.source, uid: user.uid }
    : { state: 'waiting', source: null, uid: null };

function emit() {
  for (const fn of listeners) fn(status());
}

/** Accepts only a user token: userId claim, no accountId, exp in the future. */
function offer(token, expHint, source) {
  if (typeof token !== 'string' || !token) return;
  const c = decodeJwt(token);
  if (!c.userId || c.accountId) return;
  const exp = toMs(expHint) || toMs(c.exp);
  if (!(exp > Date.now() + 5000)) return;
  const uid = String(c.userId);
  if (user && user.uid === uid && user.token !== token && exp < user.exp) return; // the later expiry wins
  const changedUser = user && user.uid !== uid;
  user = { token, exp, uid, source };
  if (changedUser) {
    accountTokens.clear();
    log.warn('Vest user changed: account tokens cleared');
  }
  for (const w of [...waiters]) w();
  emit();
}

function onChannel(ev) {
  const m = ev && ev.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'logout') {
    user = null;
    accountTokens.clear();
    log.warn('Vest: logout');
    emit();
    return;
  }
  if (m.type !== 'login' && m.type !== 'session-update' && m.type !== 'session-snapshot') return;
  const s = m.snapshot;
  const p = s && s.userPair;
  if (!p) return;
  offer(p.accessToken, p.accessTokenExpiresAt, 'channel');
}

const ping = () => {
  try {
    if (bc) bc.postMessage({ type: 'request-session' });
  } catch {
    /* channel closed */
  }
};

/** Fallback: reads the Authorization header of the page's XHRs (prototype patch, only if needed). */
function tapXhr() {
  if (xhrTapped) return;
  xhrTapped = true;
  hooks.observe(XMLHttpRequest.prototype, 'setRequestHeader', ([name, value]) => {
    const bearer = /^authorization$/i.test(name) && /^Bearer\s+(.+)$/i.exec(String(value));
    if (bearer) offer(bearer[1].trim(), 0, 'xhr');
  });
  log.warn('Session channel silent: XHR fallback enabled');
}

function start() {
  if (typeof BroadcastChannel === 'function') {
    try {
      bc = new BroadcastChannel(CHANNEL);
      bc.onmessage = onChannel;
    } catch {
      bc = null;
    }
  }
  ping();
  let n = 0;
  const iv = setInterval(() => {
    if (user || ++n > 30) return clearInterval(iv);
    ping();
  }, 2000);
  setTimeout(() => {
    if (!user) tapXhr();
  }, bc ? FALLBACK_AFTER_MS : 0);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') ping();
  });
  // renewal: Vest rotates the user token before it expires and invalidates the old one (seen as a 401 on the mint).
  // The current session is requested from the page every minute, and every 15 s in the last 2 minutes.
  let lastPing = Date.now();
  setInterval(() => {
    if (!user || user.exp - Date.now() < 120000 || Date.now() - lastPing >= 60000) {
      ping();
      lastPing = Date.now();
    }
    emit();
  }, 15000);
}

/** The user token in use was rejected (401): drops it and asks the page for the current one. */
function renewUser(rejected) {
  if (user && user.token === rejected) {
    user = null;
    log.info('Vest renewed the session token: using the new one');
    emit();
  }
  // fallback only if the channel is silent: the page always uses the current token in its XHR requests
  const t = setTimeout(() => {
    if (!user) tapXhr();
  }, 3000);
  return userToken(8000).finally(() => clearTimeout(t));
}

/** Runs fn(userToken); on 401 renews the user token and retries ONCE. */
async function withUser(fn) {
  const ut = await userToken(10000);
  try {
    return await fn(ut);
  } catch (e) {
    if (!(e instanceof HttpError) || e.status !== 401) throw e;
    const fresh = await renewUser(ut);
    return fn(fresh);
  }
}

/** Valid user token, waiting for it up to ms. */
function userToken(ms = 0) {
  if (user && user.exp - Date.now() > 5000) return Promise.resolve(user.token);
  if (!ms) return Promise.reject(new Error('no Vest session'));
  ping();
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(t);
      waiters.delete(done);
      if (user && user.exp - Date.now() > 5000) resolve(user.token);
      else reject(new Error('no Vest session'));
    };
    const t = setTimeout(done, ms);
    waiters.add(done);
  });
}

// ── account tokens
const accountTokens = new Map(); // accountId -> { token, exp, canTrade }
const minting = new Map(); // accountId -> Promise

function accountToken(accountId) {
  const c = accountTokens.get(accountId);
  if (c && c.exp - RENEW_MARGIN_MS > Date.now()) return Promise.resolve(c);
  if (minting.has(accountId)) return minting.get(accountId);
  const p = (async () => {
    try {
      const r = await withUser((ut) => request('/v3/auth/account-token', { method: 'POST', token: ut, body: { accountId } }));
      const tok = r && (r.apiKey || r.accessToken);
      if (!tok) throw new Error('account-token: no token in the response');
      const cl = decodeJwt(tok);
      if (cl.accountId && cl.accountId !== accountId) throw new Error('account-token: the token is not for this account');
      // shape of the response, without the token
      log.noteShape('POST /v3/auth/account-token', r); // shape only; the refreshToken in the response is not kept
      log.noteShape('account token claims', cl); // describe() keeps only names and types
      const v = { token: tok, exp: toMs(r.accessExpiresAtMs) || toMs(cl.exp), canTrade: 'canTrade' in cl ? !!cl.canTrade : null };
      accountTokens.set(accountId, v);
      return v;
    } finally {
      minting.delete(accountId);
    }
  })();
  minting.set(accountId, p);
  return p;
}

/** GET with an account token; on 401 renews the token once. */
async function accountGet(accountId, path, shapeKey) {
  const { token } = await accountToken(accountId);
  try {
    return await request(path, { token, shapeKey });
  } catch (e) {
    if (!(e instanceof HttpError) || e.status !== 401) throw e;
    accountTokens.delete(accountId);
    const fresh = await accountToken(accountId);
    return request(path, { token: fresh.token, shapeKey });
  }
}

/** GET with the user token. */
async function userGet(path, shapeKey) {
  return withUser((ut) => request(path, { token: ut, shapeKey }));
}

const canTradeOf = (accountId) => {
  const c = accountTokens.get(accountId);
  return c ? c.canTrade : null;
};

module.exports = {
  start,
  status,
  onChange: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
  userToken,
  accountToken,
  accountGet,
  userGet,
  canTradeOf,
  dropAccountToken: (id) => accountTokens.delete(id),
  uid: () => (user ? user.uid : null),
};
