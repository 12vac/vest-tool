const test = require('node:test');
const assert = require('node:assert/strict');

// minimal window: transport uses the native fetch captured by hooks.js at load
const sent = [];
global.window = {
  fetch: async (url, init) => {
    sent.push(`${init.method} ${new URL(url).pathname}`);
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  },
  WebSocket: function () {},
};
const transport = require('../src/core/transport');

test('orders off: closes and cancellations pass ONLY as emergency', async () => {
  transport.setOrdersEnabled(false);
  await assert.rejects(transport.request('/v3/positions/close', { method: 'POST', body: {} }), /orders off/);
  await assert.rejects(transport.request('/v3/positions/cancel-order', { method: 'POST', body: {} }), /orders off/);
  await transport.request('/v3/positions/close', { method: 'POST', body: {}, emergency: true });
  await transport.request('/v3/positions/cancel-order', { method: 'POST', body: {}, emergency: true });
  assert.deepEqual(sent.splice(0), ['POST /v3/positions/close', 'POST /v3/positions/cancel-order']);
});

test('emergency opens nothing: SL/TP and unlisted paths stay blocked', async () => {
  transport.setOrdersEnabled(false);
  await assert.rejects(transport.request('/v3/positions/stop-loss', { method: 'POST', body: {}, emergency: true }), /orders off/);
  // emergency NEVER opens: open/append/reduce stay blocked with Orders off, even marked as emergency
  await assert.rejects(transport.request('/v3/positions/open', { method: 'POST', body: {}, emergency: true }), /orders off/);
  await assert.rejects(transport.request('/v3/positions/append', { method: 'POST', body: {}, emergency: true }), /orders off/);
  await assert.rejects(transport.request('/v3/positions/open', { method: 'POST', body: {} }), /orders off/);
  await assert.rejects(transport.request('/v3/positions/withdraw', { method: 'POST', body: {}, emergency: true }), /blocked/);
  assert.equal(sent.length, 0);
});

test('orders on: only the listed ones are allowed (entries included), nothing else', async () => {
  transport.setOrdersEnabled(true);
  await transport.request('/v3/positions/take-profit', { method: 'PUT', body: {} });
  await transport.request('/v3/positions/append', { method: 'POST', body: {} });
  await assert.rejects(transport.request('/v3/capital/withdrawals', { method: 'POST', body: {} }), /blocked/);
  await assert.rejects(transport.request('/v3/user-state/accounts/A/leverages/S', { method: 'PUT', body: {} }), /blocked/);
  assert.deepEqual(sent.splice(0), ['PUT /v3/positions/take-profit', 'POST /v3/positions/append']);
  transport.setOrdersEnabled(false);
});
