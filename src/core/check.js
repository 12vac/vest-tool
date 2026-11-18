// Startup check: does Vest still answer as expected? READS only, no orders.
// 'fail' = a field the panel uses changed or is missing: the numbers shown may be wrong.
// 'warn' = an optional feature is missing (feed, chart): the panel is slower or has no lines, but is not wrong.

const session = require('./session');
const { request } = require('./transport');
const store = require('./store');
const tv = require('../chart/tv');
const { missing } = require('../domain/shapes');

const { S } = store;
const DEFAULT_SYMBOL = 'NDX-USD-PERP';

async function probe(key, name, fn) {
  let r;
  try {
    r = await fn();
  } catch (e) {
    r = ['fail', e.message];
  }
  const [level, msg] = r;
  const i = S.checks.findIndex((c) => c.key === key);
  const row = { key, name, level, msg };
  if (i >= 0) S.checks[i] = row;
  else S.checks.push(row);
  store.changed();
  return level;
}

const fieldsMsg = (m, ok) => (m.length ? ['fail', 'Missing fields: ' + m.join(', ')] : ['pass', ok]);

async function run() {
  S.checks = [];
  store.changed();
  await probe('session', 'Vest session', async () => {
    const st = session.status();
    if (st.state !== 'ok') return ['fail', 'No user token: log in or reload the page'];
    return ['pass', `User token read (${st.source === 'channel' ? 'session channel' : 'XHR fallback'})`];
  });
  if (session.status().state !== 'ok') return;

  let firstId = null;
  await probe('accounts', 'Accounts and balances', async () => {
    const [a, b] = await Promise.all([
      session.userGet('/v3/capital/accounts/active'),
      session.userGet('/v3/accounts?active=true&limit=500'),
    ]);
    if (!a || !Array.isArray(a.accounts)) return ['fail', 'Account list missing from the response'];
    if (!a.accounts.length) return ['warn', 'No active account'];
    firstId = a.accounts[0].id;
    if (!b || !Array.isArray(b.accounts) || !b.accounts.length) return ['fail', 'Balances missing'];
    const m = [
      ...missing(a.accounts[0], ['id', 'initial_capital', 'max_drawdown_limit', 'account_type']),
      ...missing(b.accounts[0], ['account_id', 'amount']),
    ];
    return fieldsMsg(m, `${a.accounts.length} active accounts, balances readable`);
  });

  await probe('token', 'Account token', async () => {
    if (!firstId) return ['fail', 'Not checked: no account'];
    const t = await session.accountToken(firstId);
    if (!t.token) return ['fail', 'No token'];
    return ['pass', t.canTrade == null ? 'Minted (canTrade flag missing)' : 'Minted'];
  });

  await probe('positions', 'Positions and orders', async () => {
    if (!firstId) return ['fail', 'Not checked: no account'];
    const [p, o] = await Promise.all([
      session.accountGet(firstId, '/v3/positions/opened'),
      session.accountGet(firstId, '/v3/positions/opened-orders'),
    ]);
    return fieldsMsg([...missing(p, ['positions']), ...missing(o, ['orders'])], 'Readable');
  });

  await probe('series', 'Equity series', async () => {
    const now = Date.now();
    const r = await session.userGet(`/v3/trading-performance/series?from=${now - 30 * 60000}&to=${now}&points=30`);
    if (!r || !Array.isArray(r.items)) return ['fail', 'items missing'];
    if (!r.items.length) return ['warn', 'Empty (equity fallback not available)'];
    return fieldsMsg(missing(r.items[0], ['account_id', 'equity_value']), 'Readable');
  });

  await probe('market', 'Market rules', async () => {
    const r = await request(`/v3/exchangeInfo?symbols=${DEFAULT_SYMBOL}`);
    const x = ((r && r.symbols) || []).find((s) => s && s.symbol === DEFAULT_SYMBOL);
    if (!x) return ['fail', DEFAULT_SYMBOL + ' assente'];
    return fieldsMsg(missing(x, ['sizeDecimals', 'minTickSize']), `${DEFAULT_SYMBOL}: tick ${x.minTickSize}, ${x.sizeDecimals} decimals`);
  });

  await probe('prices', 'Mark prices', async () => {
    const r = await request(`/v3/ticker/latest?symbols=${DEFAULT_SYMBOL}`);
    const t = ((r && r.tickers) || [])[0];
    if (!t) return ['fail', 'tickers missing'];
    return fieldsMsg(missing(t, ['symbol', 'markPrice']), 'Readable');
  });

  checkLive();
}

/** Time-dependent checks (feed, chart): re-evaluated at every call. */
function checkLive() {
  const f = S.feed;
  let feed;
  if (!f.attached) feed = ['warn', 'Private socket not hooked (script loaded late?): polling every 20 s'];
  else if (!store.feedLive()) feed = ['warn', 'Hooked but silent for over 75 s: polling every 20 s'];
  // without account changes Vest sends only pings: live is a full pass, the fields are checked at the first event
  else if (!f.stateAt) feed = ['pass', 'Live (no account changes so far: fields are checked at the first one)'];
  else if (f.missing.length) feed = ['fail', 'account_state without: ' + f.missing.join(', ')];
  else feed = ['pass', 'Vivo'];
  setRow('feed', 'Private feed', feed);

  const found = tv.find();
  const cap = tv.capabilities(found);
  let chart;
  if (!found) chart = ['warn', 'tradingViewApi not found (open the trading page)'];
  else if (!cap.createOrderLine) chart = ['warn', 'createOrderLine missing: no lines'];
  else {
    const sym = tv.chartSymbol(found);
    const miss = Object.entries(cap).filter(([, v]) => !v).map(([k]) => k);
    const market = tv.marketOfChart(sym, S.symbols);
    const known = Object.keys(S.symbols).length;
    if (!market && known)
      chart = ['warn', `Chart symbol "${sym || '?'}" matches no known market: no lines. Known names: ${Object.values(S.symbols).flatMap((m) => m.aliases).join(', ')}`];
    else chart = [miss.length ? 'warn' : 'pass', `Chart "${sym || '?'}" = ${market || '(markets not read yet)'}${miss.length ? ' · missing: ' + miss.join(', ') : ''}`];
  }
  setRow('chart', 'Chart', chart);
}

function setRow(key, name, [level, msg]) {
  const i = S.checks.findIndex((c) => c.key === key);
  const row = { key, name, level, msg };
  const prev = i >= 0 ? S.checks[i] : null;
  if (prev && prev.level === level && prev.msg === msg) return;
  if (i >= 0) S.checks[i] = row;
  else S.checks.push(row);
  store.changed();
}

module.exports = { run, checkLive };
