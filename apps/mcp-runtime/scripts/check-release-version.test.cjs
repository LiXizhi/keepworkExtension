const test = require('node:test');
const assert = require('node:assert/strict');
const { decideRelease, parseStableVersion } = require('./check-release-version.cjs');

test('workflow dispatch always publishes current stable version', () => {
  assert.deepEqual(decideRelease('workflow_dispatch', '', '0.1.0'), {
    publish: true,
    version: '0.1.0',
    previousVersion: '',
  });
});

test('push publishes only when version increases', () => {
  assert.equal(decideRelease('push', '0.1.0', '0.1.0').publish, false);
  assert.equal(decideRelease('push', '0.1.0', '0.1.1').publish, true);
  assert.throws(() => decideRelease('push', '0.2.0', '0.1.9'), /must increase/);
});

test('release versions must use stable X.Y.Z syntax', () => {
  assert.throws(() => parseStableVersion('0.1.0-beta.1', 'version'), /stable X.Y.Z/);
});
