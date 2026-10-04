const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { collect, publish } = require('../../../scripts/stable-release.cjs');
test('stable artifacts bind all platforms to one source and use a separate channel', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stable-release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const version = '0.1.31', commit = 'a'.repeat(40), data = Buffer.from('runtime archive fixture');
  for (const target of ['windows-x64', 'macos-arm64', 'macos-x64']) {
    const [platform, arch] = target.split('-');
    fs.writeFileSync(path.join(dir, `${target}.zip`), data);
    fs.writeFileSync(path.join(dir, `${target}.json`), JSON.stringify({ schemaVersion: 1, product: 'keepwork-mcp-node-runtime',
      platform, arch, version, commit, fileName: `${target}.zip`, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex'),
      url: `https://cdn.keepwork.com/keepwork/mcp-stable/${version}/${target}.zip` }));
  }
  const release = collect(dir, version, commit);
  assert.equal(release.archives.length, 6); assert.equal(release.descriptors.length, 3);
  assert.ok(release.archives.every(e => e.remoteKey.startsWith(`keepwork/mcp-stable/${version}/`)));
  assert.ok(release.descriptors.every(e => !e.remoteKey.includes(version)));
  const events = [];
  await publish(release.archives, {}, { uploadEntry: async (_c,e) => events.push(e.remoteKey), refreshUrls: async () => events.push('refresh'), verifyEntriesWithRetry: async () => events.push('verify') });
  assert.deepEqual(events.slice(-2), ['refresh', 'verify']);
  fs.writeFileSync(path.join(dir, 'windows-x64.zip'), 'corrupted');
  assert.throws(() => collect(dir, version, commit), /Invalid stable artifact/);
});
