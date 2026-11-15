const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const win7Release = require('../../../scripts/lib/win7-release.cjs');

function runContractFixture(t, fixtureName, { extraSources = [], includeDirectories = [] } = {}) {
  const cmake = process.env.CMAKE || 'cmake';
  const available = spawnSync(cmake, ['--version'], { encoding: 'utf8', timeout: 10000 });
  if (available.error?.code === 'ENOENT') return t.skip('CMake is unavailable for portable maintenance contracts');
  assert.ifError(available.error);
  assert.equal(available.status, 0, available.stdout + available.stderr);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-compat-maintenance-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const fixture = path.resolve(__dirname, '../windows/tests', fixtureName);
  const common = path.resolve(__dirname, '../windows/common');
  const quoted = file => '"' + file.replaceAll('\\', '/').replaceAll('"', '\\"') + '"';
  // Only the test build system is generated. The decision and orchestration
  // code come from production headers; no Windows process or user profile is used.
  fs.writeFileSync(path.join(temporary, 'CMakeLists.txt'), [
    'cmake_minimum_required(VERSION 3.21)',
    'project(keepwork_compat_maintenance_contracts LANGUAGES CXX)',
    'enable_testing()',
    `add_executable(compat-maintenance-test ${[fixture, ...extraSources].map(quoted).join(' ')})`,
    `target_include_directories(compat-maintenance-test PRIVATE ${[common, ...includeDirectories].map(quoted).join(' ')})`,
    'target_compile_features(compat-maintenance-test PRIVATE cxx_std_17)',
    'if(MSVC)',
    '  target_compile_options(compat-maintenance-test PRIVATE /utf-8)',
    'endif()',
    'add_test(NAME compat-maintenance COMMAND compat-maintenance-test)',
    '',
  ].join('\n'));
  const build = path.join(temporary, 'build');
  const run = args => {
    const result = spawnSync(cmake, args, { encoding: 'utf8', windowsHide: true, timeout: 55000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout + result.stderr;
  };
  run(['-S', temporary, '-B', build, '-DCMAKE_BUILD_TYPE=Release']);
  run(['--build', build, '--config', 'Release']);
  const output = run(['-E', 'chdir', build, 'ctest', '-C', 'Release', '--output-on-failure', '--verbose']);
  assert.match(output, /100% tests passed/);
  return output;
}

test('compatibility maintenance executes production restart contracts with isolated effects', {
  timeout: 120000,
}, t => {
  const output = runContractFixture(t, 'compat_maintenance_test.cpp');
  if (output) assert.match(output, /Compatibility maintenance: \d+ assertions passed/);
});

function nativeJsonHeaders() {
  // The native launcher already owns this pinned dependency. Use an existing
  // include directory, never fetch a package or change a user's installation
  // merely to execute these portable contracts.
  const candidates = [
    process.env.KEEPWORK_NLOHMANN_INCLUDE,
    process.env.NLOHMANN_JSON_INCLUDE_DIR,
    path.resolve(__dirname, '../windows/build/_deps/json-src/include'),
    path.join(os.tmpdir(), 'keepwork-json/json/include'),
    '/private/tmp/keepwork-json/json/include',
    '/opt/homebrew/include', '/usr/local/include', '/usr/include',
  ].filter(Boolean);
  return candidates.find(directory => fs.existsSync(path.join(directory, 'nlohmann/json.hpp')));
}

test('compatibility client updates validate the production channel, immutable candidates and exit handoff', {
  timeout: 120000,
}, t => {
  const jsonInclude = nativeJsonHeaders();
  if (!jsonInclude) return t.skip('Native launcher JSON headers unavailable; set KEEPWORK_NLOHMANN_INCLUDE to run client update contracts');
  const output = runContractFixture(t, 'client_update_policy_test.cpp', {
    extraSources: [path.resolve(__dirname, '../windows/common/policy.cpp')],
    includeDirectories: [jsonInclude],
  });
  if (output) assert.match(output, /Compatibility client update: \d+ assertions passed/);
});

test('legacy MCP restart ownership checks the production runtime and embedded build identity', {
  timeout: 120000,
}, t => {
  const jsonInclude = nativeJsonHeaders();
  if (!jsonInclude) return t.skip('Native launcher JSON headers unavailable; set KEEPWORK_NLOHMANN_INCLUDE to run old runtime identity contracts');
  const output = runContractFixture(t, 'mcp_restart_identity_test.cpp', {
    extraSources: [path.resolve(__dirname, '../windows/common/policy.cpp')],
    includeDirectories: [jsonInclude],
  });
  if (output) assert.match(output, /Compatibility MCP identity: \d+ assertions passed/);
});

test('native maintenance actions remain outside the webpage bridge and respect canceled browser exit', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../windows/cef-host/main.cpp'), 'utf8');
  const renderer = source.match(/class RendererApp\b[\s\S]*?\nclass Client\b/)?.[0];
  assert.ok(renderer, 'renderer registration must be inspectable for the native exposure contract');
  assert.doesNotMatch(renderer, /MaintenanceController|restart_mcp|check_updates|install_update|--restart-mcp|--install-update/,
    'trusted web documents receive no maintenance function or process arguments');
  for (const action of ['restart_mcp', 'check_updates']) {
    assert.match(source, new RegExp(`case Command::${action}:\\s*if \\(options_\\.maintenance && !options_\\.launcher\\.empty\\(\\)\\)`),
      `${action} requires the negotiated native launcher capability`);
  }
  const beforeUnload = source.match(/bool OnBeforeUnloadDialog\b[\s\S]*?\n  \}/)?.[0];
  assert.ok(beforeUnload, 'the native update-close path must observe webpage cancellation');
  assert.match(beforeUnload, /!maintenance_\.awaiting_close\(\)/,
    'ordinary close and reload behavior stay outside the updater confirmation path');
  assert.ok(beforeUnload.indexOf('maintenance_.CancelInstall()') >= 0
      && beforeUnload.indexOf('maintenance_.CancelInstall()') < beforeUnload.indexOf('callback->Continue('),
    'beforeunload rejection must revoke installation before returning control to the webpage');
});

test('official client update key stays pinned independently of local component signing keys', () => {
  const officialPem = fs.readFileSync(path.resolve(__dirname, '../keys/win7-release-public.pem'));
  const header = fs.readFileSync(path.resolve(__dirname, '../windows/common/client_update_key.hpp'), 'utf8');
  const initializer = header.match(/client_update_public_key\[\]\s*=\s*\{([^}]+)\}/)?.[1];
  assert.ok(initializer, 'the compiled official client trust root must be present');
  const blob = Buffer.from([...initializer.matchAll(/0x([a-f0-9]{2})\b/gi)].map(match => Number.parseInt(match[1], 16)));
  assert.deepEqual(blob, win7Release.publicKeyBlob(officialPem),
    'changing the tracked official PEM requires regenerating the compiled BCrypt public blob');
  const exponentBytes = blob.readUInt32LE(8), modulusBytes = blob.readUInt32LE(12);
  assert.deepEqual(Array.from({ length: 6 }, (_, index) => blob.readUInt32LE(index * 4)),
    [0x31415352, 2048, exponentBytes, modulusBytes, 0, 0]);
  assert.equal(blob.length, 24 + exponentBytes + modulusBytes);
  const pinnedKey = crypto.createPublicKey({ format: 'jwk', key: {
    kty: 'RSA', e: blob.subarray(24, 24 + exponentBytes).toString('base64url'),
    n: blob.subarray(24 + exponentBytes).toString('base64url'),
  } });
  assert.deepEqual(pinnedKey.export({ type: 'spki', format: 'der' }),
    crypto.createPublicKey(officialPem).export({ type: 'spki', format: 'der' }));
  const preview = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const payload = { schemaVersion: 1, product: 'aichat-desktop', variant: 'win7-win8', version: '0.2.155' };
  const signedByPreview = win7Release.signEnvelope(payload, preview.privateKey);
  assert.deepEqual(win7Release.verifyEnvelope(signedByPreview, preview.publicKey), payload,
    'the rejection fixture carries a real, valid signature for its separate preview key');
  assert.throws(() => win7Release.verifyEnvelope({
    ...signedByPreview, publicKey: preview.publicKey.export({ type: 'spki', format: 'pem' }),
  }, pinnedKey), /signature/,
  'a preview or feed-supplied public key cannot authorize an official client update');
  const native = fs.readFileSync(path.resolve(__dirname, '../windows/native.cpp'), 'utf8');
  assert.match(native, /verify_client_update_envelope\([^)]*\)\s*\{\s*return verify_release_signature\(envelope, client_update_public_key, sizeof\(client_update_public_key\)\)/,
    'the native client-feed entry point must use the fixed official key');
  assert.match(native, /verify_envelope\([^)]*\)\s*\{\s*return verify_release_signature\(envelope, release_public_key, sizeof\(release_public_key\)\)/,
    'component envelopes retain their separately pinned release key');
});
