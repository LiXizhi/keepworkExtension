const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateMcpRuntime } = require('../scripts/validate-mcp-runtime.cjs');

function fixture(t, commit) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-mcp-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.writeFileSync(path.join(root, 'runtime.json'), JSON.stringify({
    product: 'keepwork-mcp-node-runtime', platform: 'macos', arch: 'arm64', version: '0.1.31', entry: 'app/cli.cjs',
  }));
  fs.writeFileSync(path.join(root, 'app', 'package.json'), JSON.stringify({
    name: 'keepwork-mcp-runtime', version: '0.1.31', commit,
  }));
  return root;
}

test('Mac packaging rejects a staged MCP runtime when MCP sources changed after staging', t => {
  const stagedCommit = 'a'.repeat(40), currentCommit = 'b'.repeat(40);
  const root = fixture(t, stagedCommit);
  assert.throws(() => validateMcpRuntime(root, {
    platform: 'macos', arch: 'arm64', commit: currentCommit, hasSourceChangesSince: () => true,
  }), /Bundled MCP runtime is stale/);
});

test('Mac packaging accepts a staged runtime after desktop-only commits', t => {
  const commit = 'c'.repeat(40), root = fixture(t, commit);
  assert.equal(validateMcpRuntime(root, {
    platform: 'macos', arch: 'arm64', commit: 'd'.repeat(40), hasSourceChangesSince: () => false,
  }).version, '0.1.31');
});
