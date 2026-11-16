const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./harness.cjs');

test('missing Node reference is a hard failure in CI and explicitly required local runs', () => {
  for (const env of [{ CI: 'true' }, { CI: '1' }, { KEEPWORK_MCP_REQUIRE_NODE_REFERENCE: '1' }, { CI: 'true', KEEPWORK_MCP_REQUIRE_NODE_REFERENCE: '0' }]) {
    assert.throws(() => h.hasNodeReference({ env, exists: () => false }), /Required Node reference missing.*npm run build/);
    assert.equal(h.hasNodeReference({ env, exists: () => true }), true);
  }
});

test('optional local comparisons have an actionable skip reason without suppressing Rust tests', () => {
  assert.equal(h.hasNodeReference({ env: {}, exists: () => false }), false);
  assert.equal(h.hasNodeReference({ env: { CI: 'false' }, exists: () => false }), false);
  assert.match(h.nodeReferenceSkipReason, /comparison was not run.*npm run build/);
});
