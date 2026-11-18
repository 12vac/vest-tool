// Hooks installed at document-start, BEFORE Vest's code. The bare minimum:
//  - a copy of the native fetch (our requests do not go through other patches installed later)
//  - Proxy on the WebSocket constructor to LISTEN to the page's private socket (never send, never read the URL)
// The token fallback (XHR) is in session.js and is installed only if the session channel is silent.

const log = require('../diag/log');

const nativeFetch = window.fetch.bind(window);
const NativeWebSocket = window.WebSocket;
const PRIVATE_WS = /\/ws\/private|listenKey/i;

let onPrivateSocket = null; // set by feed.js
const pending = []; // sockets created before feed.js registers

function install() {
  if (typeof NativeWebSocket !== 'function' || typeof Proxy !== 'function') {
    log.warn('WebSocket or Proxy not available: private feed cannot be hooked, polling only');
    return;
  }
  const route = (sock, url) => {
    if (!PRIVATE_WS.test(String(url || ''))) return;
    if (onPrivateSocket) onPrivateSocket(sock);
    else pending.push(sock);
  };
  try {
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct: (Ctor, ctorArgs, newTarget) => {
        const sock = Reflect.construct(Ctor, ctorArgs, newTarget);
        guarded(() => route(sock, ctorArgs[0]));
        return sock;
      },
    });
  } catch (e) {
    log.warn('WebSocket Proxy not installed: ' + e.message);
  }
}

/** Runs fn and swallows any error: our hooks must never break the page. */
function guarded(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/**
 * Wraps obj[name] so that `spy` sees each call first: spy.call(thisArg, args) runs guarded, then the original runs
 * untouched with the same this and arguments. Returns a function that puts the original back.
 */
function observe(obj, name, spy) {
  const original = obj[name];
  if (typeof original !== 'function') return () => {};
  const wrapped = function (...args) {
    guarded(() => spy.call(this, args));
    return Reflect.apply(original, this, args);
  };
  obj[name] = wrapped;
  return () => {
    if (obj[name] === wrapped) obj[name] = original;
  };
}

function setPrivateSocketHandler(fn) {
  onPrivateSocket = fn;
  while (pending.length) fn(pending.shift());
}

module.exports = { install, nativeFetch, setPrivateSocketHandler, observe, guarded };
