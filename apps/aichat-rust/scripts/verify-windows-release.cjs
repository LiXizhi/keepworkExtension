#!/usr/bin/env node
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appRoot, '../..');
const machines = { x64: 0x8664, arm64: 0xaa64 };
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function peMachine(file) {
  const bytes = fs.readFileSync(file);
  assert.ok(bytes.length >= 64 && bytes.toString('ascii', 0, 2) === 'MZ', `Invalid PE: ${file}`);
  const offset = bytes.readUInt32LE(0x3c);
  assert.ok(offset + 6 <= bytes.length && bytes.toString('ascii', offset, offset + 4) === 'PE\0\0', `Invalid PE header: ${file}`);
  return bytes.readUInt16LE(offset + 4);
}

function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    assert.ok(!entry.isSymbolicLink(), `Unexpected release symlink: ${file}`);
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}

function verify({ directory, arch, commit, binary, installer }) {
  assert.ok(machines[arch], 'Expected x64 or arm64');
  assert.match(commit, /^[a-f0-9]{40}$/, 'Expected full source commit');
  const desktopVersion = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')).version;
  const tauriVersion = JSON.parse(fs.readFileSync(path.join(appRoot, 'src-tauri/tauri.conf.json'), 'utf8')).version;
  const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(path.join(appRoot, 'src-tauri/Cargo.toml'), 'utf8'))[1];
  const lockVersion = /\[\[package\]\]\s+name = "aichat-rust"\s+version = "([^"]+)"/.exec(fs.readFileSync(path.join(appRoot, 'src-tauri/Cargo.lock'), 'utf8'))[1];
  assert.deepEqual([tauriVersion, cargoVersion, lockVersion], [desktopVersion, desktopVersion, desktopVersion]);
  const runtimeVersion = /^version\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(path.join(repoRoot, 'apps/mcp-rust/crates/keepwork-mcp/Cargo.toml'), 'utf8'))[1];
  const runtimeLockVersion = /\[\[package\]\]\s+name = "keepwork-mcp"\s+version = "([^"]+)"/.exec(fs.readFileSync(path.join(repoRoot, 'apps/mcp-rust/Cargo.lock'), 'utf8'))[1];
  assert.equal(runtimeLockVersion, runtimeVersion, 'Runtime lockfile version mismatch');
  const files = filesUnder(directory);
  const manifests = files.filter((file) => path.basename(file) === 'runtime.json');
  assert.equal(manifests.length, 1, 'Expected exactly one bundled runtime');
  const manifest = JSON.parse(fs.readFileSync(manifests[0], 'utf8'));
  for (const [key, value] of Object.entries({ schemaVersion: 2, product: 'keepwork-mcp-runtime', engine: 'rust', version: runtimeVersion, commit, platform: 'windows', arch, entry: 'bin/keepwork-mcp.exe' })) {
    assert.equal(manifest[key], value, `Unexpected runtime ${key}`);
  }
  assert.deepEqual(manifest.args, ['--port', '8089'], 'Unexpected runtime arguments');
  assert.deepEqual(manifest.env, {}, 'Unexpected runtime environment');
  assert.deepEqual(manifest.health, { url: 'http://127.0.0.1:8089/health', match: { name: 'keepwork-mcp' }, timeoutMs: 10000 }, 'Unexpected runtime health configuration');
  const runtime = path.join(path.dirname(manifests[0]), 'bin/keepwork-mcp.exe');
  const applications = files.filter((file) => ['keepwork.exe', 'aichat-rust.exe'].includes(path.basename(file).toLowerCase()));
  assert.equal(applications.length, 1, 'Expected exactly one desktop executable');
  assert.equal(peMachine(applications[0]), machines[arch], 'Desktop architecture mismatch');
  assert.equal(peMachine(runtime), machines[arch], 'Runtime architecture mismatch');
  assert.equal(sha256(runtime), sha256(binary), 'Packaged runtime differs from build output');
  assert.equal(path.basename(installer), `Keepwork_${desktopVersion}_${arch}-setup.exe`);
  return { desktopVersion, runtimeVersion, engine: 'rust', platform: 'windows', arch, commit, runtimeSha256: sha256(runtime), installer: { name: path.basename(installer), size: fs.statSync(installer).size, sha256: sha256(installer) } };
}

if (require.main === module) {
  try {
    const options = {};
    for (let index = 2; index < process.argv.length; index += 2) options[process.argv[index].replace(/^--/, '')] = process.argv[index + 1];
    const result = verify(options);
    if (options.output) fs.writeFileSync(options.output, `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { peMachine, verify };
