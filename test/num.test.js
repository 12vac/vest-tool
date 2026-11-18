const test = require('node:test');
const assert = require('node:assert/strict');
const { cmpSeq } = require('../src/domain/num');

test('cmpSeq: integers as strings, even huge ones', () => {
  assert.ok(cmpSeq('10', '9') > 0);
  assert.ok(cmpSeq('9007199254740993', '9007199254740992') > 0);
  assert.equal(cmpSeq('007', '7'), 0);
  assert.ok(Number.isNaN(cmpSeq('abc', '1')));
});
