const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { createRuntimeManifest } = require('./stage-runtime.cjs');

const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.join(__dirname, '..'), encoding: 'utf8' }).trim();
const runtimePackage = { name: 'keepwork-mcp-runtime', version: '0.1.52', commit };
const builtAt = '2026-11-11T12:00:00.000Z';

for (const [platform, arch, published, node] of [
  ['darwin', 'arm64', 'macos', 'bin/node'],
  ['macos', 'x64', 'macos', 'bin/node'],
  ['win32', 'x64', 'windows', 'node.exe'],
  ['windows', 'x64', 'windows', 'node.exe'],
]) test(`Node staging publishes the Rust-compatible manifest for ${platform}-${arch}`, () => {
  const manifest = createRuntimeManifest({ runtimePackage, nodeVersion: '22.23.2', target: { platform, arch }, builtAt });
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.product, 'keepwork-mcp-node-runtime');
  assert.equal(manifest.engine, 'node');
  assert.equal(manifest.commit, runtimePackage.commit);
  assert.match(manifest.commit, /^[a-f0-9]{40}$/);
  assert.equal(manifest.version, runtimePackage.version);
  assert.equal(manifest.builtAt, builtAt);
  assert.equal(manifest.platform, published);
  assert.equal(manifest.arch, arch);
  assert.equal(manifest.node, node);
  assert.equal(manifest.entry, 'app/cli.cjs');
  assert.deepEqual(manifest.args, ['--port', '8089']);
  assert.equal(manifest.health.url, 'http://127.0.0.1:8089/health');
});

test('staging rejects missing or abbreviated source identity rather than inventing a commit', () => {
  for (const value of [undefined, '', 'abcdef1', 'z'.repeat(40)]) {
    assert.throws(() => createRuntimeManifest({ runtimePackage: { ...runtimePackage, commit: value }, nodeVersion: '22.23.2', target: { platform: 'darwin', arch: 'arm64' }, builtAt }), /commit|metadata|identity/i);
  }
});
