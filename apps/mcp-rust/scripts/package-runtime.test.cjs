const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { packageRuntime } = require('./package-runtime.cjs');

function entries(bytes) {
  const end = bytes.lastIndexOf(Buffer.from('PK\x05\x06'));
  let cursor = bytes.readUInt32LE(end + 16);
  const result = new Map();
  for (let index = 0; index < bytes.readUInt16LE(end + 10); index++) {
    const nameSize = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameSize).toString();
    const offset = bytes.readUInt32LE(cursor + 42), size = bytes.readUInt32LE(cursor + 20);
    const dataOffset = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
    const data = bytes.subarray(dataOffset, dataOffset + size);
    if (!name.endsWith('/')) result.set(name, bytes.readUInt16LE(cursor + 10) === 8 ? zlib.inflateRawSync(data) : data);
    cursor += 46 + nameSize + extra + comment;
  }
  return result;
}

test('Rust v2 deliverable has matching archive, native identity and independent feed URL', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-rust-package-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const info = { marker: 'keepwork-mcp-build-v1', product: 'keepwork-mcp-runtime', engine: 'rust',
    version: '0.3.0', commit: 'a'.repeat(40), sourceHash: 'b'.repeat(64), target: 'aarch64-apple-darwin',
    capabilities: { agentSessionApi: 'v1', agentInventoryApi: 'v1', agentContextApi: 'v1', agentModeApi: 'v1' }, endMarker: 'keepwork-mcp-build-end' };
  const binary = path.join(root, '编译产物 $test');
  const data = Buffer.from('fixture binary\0' + JSON.stringify(info)); fs.writeFileSync(binary, data);
  const output = path.join(root, 'release');
  const result = packageRuntime({ binary, output, target: info.target, expected: info });
  const zip = fs.readFileSync(result.archive);
  assert.equal(result.manifest.schemaVersion, 2); assert.equal(result.manifest.engine, 'rust');
  assert.equal(result.manifest.url, 'https://cdn.keepwork.com/keepwork/mcp-stable-rs/0.3.0/macos-arm64.zip');
  assert.equal(result.manifest.size, zip.length);
  assert.equal(result.manifest.sha256, crypto.createHash('sha256').update(zip).digest('hex'));
  const files = entries(zip); assert.deepEqual([...files.keys()].sort(), ['LICENSE', 'bin/keepwork-mcp', 'runtime.json']);
  assert.deepEqual(files.get('bin/keepwork-mcp'), data);
  const runtime = JSON.parse(files.get('runtime.json'));
  for (const key of ['schemaVersion', 'product', 'engine', 'version', 'commit', 'sourceHash', 'platform', 'arch']) assert.equal(runtime[key], result.manifest[key]);
  assert.equal(runtime.entry, 'bin/keepwork-mcp');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, 'macos-arm64.json'))), result.manifest);
  assert.throws(() => packageRuntime({ binary, output, target: info.target, expected: info }), /already exists/);
  for (const baseUrl of ['http://example.com/feed', 'https://user:secret@example.com/feed', 'https://example.com/feed?token=x']) {
    assert.throws(() => packageRuntime({ binary, output, target: info.target, expected: info, baseUrl }), /HTTPS URL/);
  }
  assert.throws(() => packageRuntime({ binary, output, target: 'other', expected: info }), /Unsupported/);
  assert.throws(() => packageRuntime({ binary, output, target: info.target, expected: { ...info, sourceHash: 'c'.repeat(64) } }), /stale/);
});
