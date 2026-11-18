// Vest private feed: LISTENING to the socket opened by the page. Never send(), never close, never read the URL.
// Channels used: account_state (positions, stop/target, balance), capital_account (failed account/limits), command_events.

const hooks = require('./hooks');
const store = require('./store');
const A = require('../domain/account');
const { missing } = require('../domain/shapes');
const log = require('../diag/log');

const FEED_FIELDS = ['account_id', 'account_seq', 'positions', 'final_balance'];
const { S } = store;
let current = null;
let onAccountsChanged = () => {};

function attach(ws) {
  const again = S.feed.attached > 0;
  current = ws;
  S.feed.attached++;
  S.feed.lastAt = Date.now();
  S.feed.open = ws.readyState === 1;
  const handlers = {
    open() {
      S.feed.open = true;
      store.changed();
    },
    message(e) {
      S.feed.lastAt = Date.now();
      S.feed.open = true;
      onMessage(e.data);
    },
    close() {
      S.feed.open = false;
      log.warn('Private feed closed');
      store.changed();
    },
  };
  // only the latest socket counts: an old one that Vest replaced is ignored
  for (const [type, fn] of Object.entries(handlers)) ws.addEventListener(type, (e) => ws === current && fn(e));
  log.info(again ? 'Private feed hooked again' : 'Private feed hooked');
  if (again) onAccountsChanged('feed re-hooked'); // whatever happened meanwhile: full re-read
  store.changed();
}

function onMessage(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('{')) return; // only JSON objects
  let m;
  try {
    m = JSON.parse(raw);
  } catch {
    return;
  }
  if (!m || typeof m.channel !== 'string') return;
  log.noteShape('ws:' + m.channel, m);
  const d = m.data;
  if (!d || typeof d !== 'object') return;
  try {
    if (m.channel === 'account_state') onAccountState(d);
    else if (m.channel === 'capital_account') onCapitalAccount(d);
    else if (m.channel === 'command_events') onCommandEvent(d);
  } catch (e) {
    log.error(`feed ${m.channel}: ${e.message}`);
  }
}

function onAccountState(d) {
  S.feed.stateAt = Date.now();
  S.feed.missing = missing(d, FEED_FIELDS);
  const id = d.account_id;
  if (!id || !S.accounts[id]) return; // account not active or not read yet
  const r = A.applyFeedState(S.state[id], d, Date.now());
  if (!r.applied) return;
  S.state[id] = r.state;
  store.changed();
}

function onCapitalAccount(d) {
  // [D] status 2 = limits updated (e.g. daily reset). Other values: not verified -> the list is re-read
  // instead of deducing that the account failed.
  log.info(`capital_account: status ${d.status}`);
  onAccountsChanged('capital_account');
}

function onCommandEvent(d) {
  if (String(d.status).toUpperCase() === 'REJECTED')
    log.warn(`Vest rejected an order after accepting it (code ${d.error_code ?? '?'})`);
}

function start(onResync) {
  onAccountsChanged = onResync;
  hooks.setPrivateSocketHandler(attach);
}

module.exports = { start };
