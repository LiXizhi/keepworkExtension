const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { manifestForFile } = require('./generate-release-manifest.cjs');

test('generates a runtime manifest for a release archive', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-mcp-manifest-'));
  try {
    const file = path.join(dir, 'Keepwork-MCP-NodeRuntime-0.1.0-macos-arm64.tar.gz');
    fs.writeFileSync(file, 'archive-placeholder');
    const manifest = manifestForFile(file, {
      version: '0.1.0',
      platform: 'macos',
      arch: 'arm64',
      'base-url': 'https://cdn.keepwork.com/keepwork/node-runtimes/keepwork-mcp',
    });
    assert.equal(manifest.id, 'keepwork-mcp');
    assert.equal(manifest.fileName, path.basename(file));
    assert.equal(manifest.url, `https://cdn.keepwork.com/keepwork/node-runtimes/keepwork-mcp/${encodeURIComponent(path.basename(file))}`);
    assert.equal(manifest.sha256, crypto.createHash('sha256').update('archive-placeholder').digest('hex'));
    assert.equal(manifest.health.match.name, 'keepwork-mcp');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
