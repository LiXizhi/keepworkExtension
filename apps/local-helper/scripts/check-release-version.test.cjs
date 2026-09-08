const assert = require('node:assert/strict');
const test = require('node:test');
const { decideRelease, parseStableVersion } = require('./check-release-version.cjs');

test('manual dispatch publishes the current stable version', () => {
  assert.deepEqual(decideRelease('workflow_dispatch', '', '0.1.15'), {
    publish: true,
    version: '0.1.15',
    previousVersion: '',
  });
});

test('push publishes only a strictly higher version', () => {
  assert.equal(decideRelease('push', '0.1.15', '0.1.15').publish, false);
  assert.equal(decideRelease('push', '0.1.15', '0.1.16').publish, true);
  assert.equal(decideRelease('push', '0.9.9', '1.0.0').publish, true);
  assert.throws(() => decideRelease('push', '1.0.0', '0.9.9'), /must increase/);
});

test('release versions must use stable X.Y.Z syntax', () => {
  for (const value of ['1.2', '1.2.3-beta.1', '01.2.3', 'v1.2.3']) {
    assert.throws(() => parseStableVersion(value, 'version'), /stable X.Y.Z/);
  }
});
