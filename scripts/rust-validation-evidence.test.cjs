const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process');
const evidence = require('./rust-validation-evidence.cjs');
const { packageRuntime } = require('../apps/mcp-rust/scripts/package-runtime.cjs');
const { readRuntimeArchive } = require('./lib/runtime-archive.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-validation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function run(output, id, source, commandArgs = []) {
  return spawnSync(process.execPath, [path.join(__dirname, 'rust-validation-evidence.cjs'), 'run', '--output', output, '--id', id, '--level', 'source', '--', process.execPath, '-e', source, ...commandArgs], { encoding: 'utf8' });
}

test('commands keep literal arguments, durable success logs and the first failed result', async t => {
  const output = fixture(t);
  const literal = 'literal $(echo must-stay-literal) `not-a-command` "空 格"';
  const result = run(output, 'source-checks-unit', 'console.log(process.argv[1])', [literal]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), literal);
  const record = JSON.parse(fs.readFileSync(path.join(output, 'checks/source-checks-unit.json'), 'utf8'));
  assert.equal(record.status, 'passed');
  assert.match(record.sourceHash, /^[a-f0-9]{64}$/);
  assert.match(record.evidenceSha256[record.evidence[0]], /^[a-f0-9]{64}$/);
  assert.ok(fs.existsSync(path.join(output, record.evidence[0])));
  assert.deepEqual(JSON.parse(record.command).slice(0, 2), [process.execPath, '-e']);
  const failure = run(output, 'source-checks-failure', 'console.error("first failure"); process.exit(7)');
  assert.equal(failure.status, 7, failure.stderr);
  const repeated = run(output, 'source-checks-failure', 'console.log("second attempt")');
  assert.equal(repeated.status, 1);
  assert.match(repeated.stderr, /Evidence already exists/);
  assert.equal(fs.readFileSync(path.join(output, 'logs/source-checks-failure.log'), 'utf8').trim(), 'first failure');
  const report = await evidence.collect({ output, product: 'aichat-rust' });
  assert.equal(report.overallStatus, 'failed');
  assert.equal(report.checks.find(check => check.id === 'source-checks').status, 'failed');
  assert.equal(report.checks.find(check => check.id === 'persona-live').status, 'pending');
  assert.equal((await evidence.verify(path.join(output, 'report.json'))).overallStatus, 'failed');
  await assert.rejects(evidence.verify(path.join(output, 'report.json'), { requireComplete: true }), /incomplete/);
  fs.appendFileSync(path.join(output, 'logs/source-checks-unit.log'), '\nmodified after validation');
  await assert.rejects(evidence.verify(path.join(output, 'report.json')), /Evidence SHA-256 mismatch/);
});

test('collection hashes installer bytes while unexecuted package, account and hardware acceptance stays pending', async t => {
  const output = fixture(t);
  const installer = path.join(output, 'Keepwork fixture.exe');
  fs.writeFileSync(installer, 'isolated installer fixture');
  const result = run(output, 'source-checks-unit', 'console.log("fixture only")');
  assert.equal(result.status, 0, result.stderr);
  const report = await evidence.collect({ output, product: 'aichat-rust', artifact: installer });
  assert.equal(report.artifact.sha256, crypto.createHash('sha256').update('isolated installer fixture').digest('hex'));
  assert.equal(report.artifact.signing.status, 'unknown');
  assert.equal(report.runtime, null);
  assert.equal(report.web, null);
  assert.equal(report.overallStatus, 'pending');
  assert.equal(report.checks.find(check => check.id === 'package-integrity').status, 'pending');
  assert.equal(report.checks.find(check => check.id === 'clean-install').status, 'pending');
  assert.equal(report.checks.find(check => check.id === 'native-interaction').status, 'pending');
  assert.equal(typeof report.sourceDirty, 'boolean');
  await evidence.verify(path.join(output, 'report.json'));
  fs.appendFileSync(installer, 'changed');
  await assert.rejects(evidence.verify(path.join(output, 'report.json')), /size\/SHA-256/);
});

test('verification rejects false aggregate success, missing evidence, duplicate IDs and downgraded live gates', async t => {
  const output = fixture(t);
  assert.equal(run(output, 'source-checks-unit', 'console.log("source")').status, 0);
  const report = await evidence.collect({ output, product: 'aichat-rust' });
  const clone = () => JSON.parse(JSON.stringify(report));
  const options = { directory: output };
  const fakeSuccess = clone(); fakeSuccess.overallStatus = 'passed';
  assert.throws(() => evidence.validateReport(fakeSuccess, options), /schema|Overall status/);
  const missing = clone(); missing.checks[0].evidence = ['missing-file.log'];
  assert.throws(() => evidence.validateReport(missing, options), /ENOENT/);
  const duplicate = clone(); duplicate.checks.push(duplicate.checks[0]);
  assert.throws(() => evidence.validateReport(duplicate, options), /Duplicate check/);
  const emptyPass = clone(); emptyPass.checks[0].evidence = [];
  assert.throws(() => evidence.validateReport(emptyPass, options), /schema/);
  const fakeLive = clone(); Object.assign(fakeLive.checks.find(check => check.id === 'persona-live'), { status: 'passed', level: 'source', evidence: report.checks[0].evidence });
  assert.throws(() => evidence.validateReport(fakeLive, options), /requires live evidence/);
  const omitted = clone(); omitted.checks = omitted.checks.filter(check => check.id !== 'clean-install');
  assert.throws(() => evidence.validateReport(omitted, options), /Required release check/);
});

test('missing executables create failed receipts; evidence cannot silently switch product identity', async t => {
  const output = fixture(t);
  const missing = spawnSync(process.execPath, [path.join(__dirname, 'rust-validation-evidence.cjs'), 'run', '--output', output, '--id', 'source-checks-missing', '--', path.join(output, 'missing-executable')], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  const check = JSON.parse(fs.readFileSync(path.join(output, 'checks/source-checks-missing.json'), 'utf8'));
  assert.equal(check.status, 'failed');
  assert.match(check.reason, /ENOENT/);
  assert.ok(fs.statSync(path.join(output, check.evidence[0])).size > 0);
  await assert.rejects(evidence.collect({ output, product: 'mcp-rust' }), /product does not match/);
});

test('standalone MCP reports retain every unexecuted release gate with a bounded explanation', async t => {
  const output = fixture(t);
  const report = await evidence.collect({ output, product: 'mcp-rust' });
  assert.equal(report.checks.length, evidence.gates['mcp-rust'].length);
  assert.ok(report.checks.every(check => check.status === 'pending' && check.reason));
  assert.match(report.version, /^\d+\.\d+\.\d+/);
  assert.equal(report.overallStatus, 'pending');
  await evidence.verify(path.join(output, 'report.json'));
  assert.equal(evidence.parseArgs(['collect', '--product', 'mcp-rust']).product, 'mcp-rust');
  assert.throws(() => evidence.parseArgs(['collect', '--product', 'typo']), /Unknown Rust product/);
  assert.throws(() => evidence.parseArgs(['run', '--id']), /Missing value/);
  await assert.rejects(evidence.runCheck({ output, id: '../escape', command: ['node'] }), /bounded lowercase/);
  await assert.rejects(evidence.runCheck({ output, id: 'batch', command: ['pnpm.cmd'] }), /direct executable/);
});

test('source fingerprints include new sources and lockfiles while ignoring build outputs', t => {
  const root = fixture(t);
  const source = path.join(root, 'apps/aichat-rust/src');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'main.ts'), 'export const value = 1');
  const first = evidence.sourceFingerprint('aichat-rust', root);
  const generated = path.join(root, 'apps/aichat-rust/src-tauri/target/debug');
  fs.mkdirSync(generated, { recursive: true });
  fs.writeFileSync(path.join(generated, 'compiler-output'), 'generated bytes');
  assert.equal(evidence.sourceFingerprint('aichat-rust', root), first);
  fs.writeFileSync(path.join(source, 'new.ts'), 'export const another = 2');
  const second = evidence.sourceFingerprint('aichat-rust', root);
  assert.notEqual(second, first);
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{"changed":true}');
  assert.notEqual(evidence.sourceFingerprint('aichat-rust', root), second);
  const mcp = evidence.sourceFingerprint('mcp-rust', root);
  fs.writeFileSync(path.join(source, 'main.ts'), 'export const value = 3');
  assert.equal(evidence.sourceFingerprint('mcp-rust', root), mcp, 'unrelated desktop code is outside MCP inputs');
});

test('historical desktop app bundles and disk images never change either product source fingerprint', t => {
  const root = fixture(t);
  const source = path.join(root, 'apps/aichat-rust/src/main.ts');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, 'export const value = 1');
  const fingerprints = () => Object.fromEntries(['aichat-rust', 'mcp-rust'].map(product => [product, evidence.sourceFingerprint(product, root)]));
  const baseline = fingerprints();
  const observed = [];
  for (const relative of [
    'apps/aichat-rust/releases/0.2.1/Keepwork.app/Contents/MacOS/Keepwork',
    'apps/aichat-rust/releases/0.2.2/Keepwork 0.2.2.dmg',
  ]) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'tiny historical package fixture');
    observed.push({ operation: 'add ' + relative, ...fingerprints() });
    fs.appendFileSync(file, ' changed');
    observed.push({ operation: 'modify ' + relative, ...fingerprints() });
    fs.rmSync(file);
    observed.push({ operation: 'delete ' + relative, ...fingerprints() });
  }
  assert.deepEqual(observed, observed.map(({ operation }) => ({ operation, ...baseline })));
});

test('real desktop inputs and releases-named source modules remain fingerprinted', t => {
  const root = fixture(t);
  for (const relative of [
    'apps/aichat-rust/src/main.ts',
    'apps/aichat-rust/package.json',
    'apps/aichat-rust/src-tauri/Cargo.toml',
    'apps/aichat-rust/src-tauri/Cargo.lock',
    'apps/aichat-rust/src-tauri/tauri.conf.json',
    'apps/aichat-rust/tests/input.test.cjs',
    'apps/aichat-rust/src/releases/index.ts',
    'apps/aichat-rust/src-tauri/src/releases/mod.rs',
  ]) {
    const before = evidence.sourceFingerprint('aichat-rust', root);
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'first source fixture');
    const added = evidence.sourceFingerprint('aichat-rust', root);
    assert.notEqual(added, before, 'new input must be fingerprinted: ' + relative);
    fs.appendFileSync(file, ' changed');
    assert.notEqual(evidence.sourceFingerprint('aichat-rust', root), added, 'modified input must be fingerprinted: ' + relative);
    fs.rmSync(file);
    assert.equal(evidence.sourceFingerprint('aichat-rust', root), before, 'deleting only this input must restore its prior fingerprint: ' + relative);
  }
});

test('a source change during a successful command becomes a failed receipt and cannot mix with later checks', async t => {
  const output = fixture(t);
  const first = 'a'.repeat(64), next = 'b'.repeat(64);
  let reads = 0;
  const code = await evidence.runCheck({ output, id: 'source-checks-changed', level: 'source', command: [process.execPath, '-e', 'console.log("isolated command succeeded")'], fingerprint: () => reads++ === 0 ? first : next });
  assert.equal(code, 1);
  const check = JSON.parse(fs.readFileSync(path.join(output, 'checks/source-checks-changed.json'), 'utf8'));
  assert.equal(check.status, 'failed');
  assert.equal(check.sourceHash, first);
  assert.match(check.reason, /Source inputs changed/);
  const report = await evidence.collect({ output, product: 'aichat-rust' });
  assert.equal(report.sourceHash, first);
  assert.equal(report.overallStatus, 'failed');
  await assert.rejects(evidence.runCheck({ output, id: 'source-checks-newer', level: 'source', command: [process.execPath, '-e', 'process.exit(0)'], fingerprint: () => next }), /identity changed \(sourceHash\)/);
  const mixed = JSON.parse(JSON.stringify(report));
  mixed.checks[0].sourceHash = next;
  assert.throws(() => evidence.validateReport(mixed, { directory: output }), /fingerprint differs/);
});

test('complete acceptance requires known clean source; absent cleanliness metadata is unknown', async t => {
  const output = fixture(t);
  const report = await evidence.collect({ output, product: 'mcp-rust' });
  fs.writeFileSync(path.join(output, 'manual-receipt.txt'), 'Isolated validation of receipt metadata only.');
  const bytes = fs.readFileSync(path.join(output, 'manual-receipt.txt'));
  report.artifact = { path: 'manual-receipt.txt', size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), signing: { status: 'unknown' } };
  report.runtime = { engine: 'rust', version: report.version, commit: report.commit, owner: 'fixture', capabilities: {} };
  report.sourceDirty = false;
  report.overallStatus = 'passed';
  for (const check of report.checks) { check.status = 'passed'; check.evidence = ['manual-receipt.txt']; }
  evidence.validateReport(report, { directory: output, requireComplete: true });
  delete report.sourceDirty;
  assert.throws(() => evidence.validateReport(report, { directory: output, requireComplete: true }), /clean source identity/);
});

function runtimeFixture(output, arch = 'arm64') {
  fs.mkdirSync(output, { recursive: true });
  const info = { marker: 'keepwork-mcp-build-v1', product: 'keepwork-mcp-runtime', engine: 'rust',
    version: '0.3.0', commit: 'a'.repeat(40), sourceHash: 'b'.repeat(64),
    target: arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin',
    capabilities: { agentSessionApi: 'v1', agentInventoryApi: 'v1', agentContextApi: 'v1', agentModeApi: 'v1' },
    endMarker: 'keepwork-mcp-build-end' };
  const binary = path.join(output, `fixture-${arch}`);
  fs.writeFileSync(binary, Buffer.from('nonexecutable identity fixture\0' + JSON.stringify(info)));
  const packaged = packageRuntime({ binary, target: info.target, output: path.join(output, 'package'), expected: info });
  return { ...packaged, info };
}

function runtimeContext(output, info) {
  const context = { product: 'mcp-rust', version: info.version, commit: info.commit,
    sourceDirty: false, sourceHash: 'c'.repeat(64), platform: 'macos', arch: 'arm64' };
  fs.writeFileSync(path.join(output, 'context.json'), JSON.stringify(context));
  fs.mkdirSync(path.join(output, 'checks'), { recursive: true });
  const log = 'Synthetic source/fixture evidence for collector unit tests; no native/account acceptance.\n';
  fs.writeFileSync(path.join(output, 'fixture.log'), log);
  for (const [id, level] of [['source-checks-build', 'source'], ['fixture-contracts-host', 'fixture']]) {
    const receipt = { id, level, status: 'passed', evidence: ['fixture.log'], sourceHash: context.sourceHash,
      evidenceSha256: { 'fixture.log': crypto.createHash('sha256').update(log).digest('hex') } };
    fs.writeFileSync(path.join(output, 'checks', id + '.json'), JSON.stringify(receipt));
  }
  return context;
}

function mutateRuntimeArchive(archive, mutate) {
  const members = readRuntimeArchive(fs.readFileSync(archive));
  const metadata = JSON.parse(members.get('runtime.json'));
  mutate(metadata);
  members.set('runtime.json', Buffer.from(JSON.stringify(metadata)));
  const stage = fs.mkdtempSync(path.join(path.dirname(archive), 'rewrite-'));
  try {
    for (const [name, bytes] of members) {
      const file = path.join(stage, name);
      if (name.endsWith('/')) { fs.mkdirSync(file, { recursive: true }); continue; }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
    }
    fs.rmSync(archive);
    if (process.platform === 'win32') {
      execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
        "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:KP_EVIDENCE_ZIP_SOURCE, $env:KP_EVIDENCE_ZIP_OUTPUT)"],
      { env: { ...process.env, KP_EVIDENCE_ZIP_SOURCE: stage, KP_EVIDENCE_ZIP_OUTPUT: archive }, stdio: 'pipe' });
    } else execFileSync('zip', ['-q', '-r', archive, '.'], { cwd: stage, stdio: 'pipe' });
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

test('two macOS archives keep independent portable reports and their actual target identities', async t => {
  const root = fixture(t), output = path.join(root, 'original');
  const arm = runtimeFixture(output), intel = runtimeFixture(output, 'x64');
  const context = runtimeContext(output, arm.info);
  for (const [arch, runtime] of [['arm64', arm], ['x64', intel]]) {
    const reportName = `report-macos-${arch}.json`;
    const report = await evidence.collect({ output, product: 'mcp-rust', artifact: runtime.archive, reportName });
    assert.equal(report.platform, 'macos');
    assert.equal(report.arch, arch);
    assert.equal(report.artifact.path, `package/macos-${arch}.zip`);
    assert.deepEqual(report.runtime, { engine: 'rust', version: arm.info.version, commit: arm.info.commit,
      owner: 'standalone', capabilities: arm.info.capabilities, source: 'build-info' });
    assert.equal(report.overallStatus, 'pending');
    assert.ok(report.checks.filter(check => ['native', 'packaged', 'live'].includes(check.level))
      .every(check => check.status === 'pending'), 'packaging cannot satisfy unexecuted target-native or live gates');
    if (arch === 'x64') {
      for (const check of report.checks.filter(check => ['source', 'fixture'].includes(check.level))) {
        assert.match(check.summary, /Executed on macos-arm64; archive target macos-x64/);
      }
    }
    await evidence.verify(path.join(output, reportName));
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, 'context.json'))), context,
    'the captured validation host must never become the package target');
  assert.equal(fs.existsSync(path.join(output, 'report.json')), false);
  const legacy = await evidence.collect({ output, product: 'mcp-rust', artifact: arm.archive });
  assert.equal(JSON.parse(fs.readFileSync(path.join(output, 'report.json'))).artifact.sha256, legacy.artifact.sha256);
  const copied = path.join(root, 'downloaded artifact');
  fs.cpSync(output, copied, { recursive: true });
  fs.rmSync(output, { recursive: true });
  for (const name of ['report.json', 'report-macos-arm64.json', 'report-macos-x64.json']) {
    await evidence.verify(path.join(copied, name));
  }
});

test('collector CLI uses a selected report filename and rejects output-directory escapes', async t => {
  const output = fixture(t), runtime = runtimeFixture(output, 'x64');
  runtimeContext(output, runtime.info);
  const cli = spawnSync(process.execPath, [path.join(__dirname, 'rust-validation-evidence.cjs'),
    'collect', '--product', 'mcp-rust', '--output', output, '--artifact', runtime.archive,
    '--report-name', 'report-macos-x64.json'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.match(cli.stdout, /report-macos-x64\.json/);
  assert.equal((await evidence.verify(path.join(output, 'report-macos-x64.json'))).arch, 'x64');
  for (const name of ['', '../outside.json', '/tmp/outside.json', '..\\outside.json', 'folder/report.json',
    '.hidden.json', 'report.txt', 'report.json\0', 'CON.json', 'aux.report.json']) {
    assert.throws(() => evidence.parseArgs(['collect', '--report-name', name]), /filename|Missing value/);
    await assert.rejects(evidence.collect({ output, product: 'mcp-rust', artifact: runtime.archive, reportName: name }), /filename/);
  }
  assert.throws(() => evidence.parseArgs(['run', '--report-name', 'report.json']), /only supported by collect/);
});

test('packaged runtime reports reject wrong context, metadata, target and embedded identity', async t => {
  const output = fixture(t), runtime = runtimeFixture(output);
  const context = runtimeContext(output, runtime.info);
  const options = { output, product: 'mcp-rust', artifact: runtime.archive };
  for (const change of [{ version: '9.0.0' }, { commit: 'd'.repeat(40) }]) {
    fs.writeFileSync(path.join(output, 'context.json'), JSON.stringify({ ...context, ...change }));
    await assert.rejects(evidence.collect(options), /identity\/target/);
  }
  fs.writeFileSync(path.join(output, 'context.json'), JSON.stringify(context));
  const original = fs.readFileSync(runtime.archive);
  for (const changes of [{ arch: 'universal' }, { arch: 'x64' }, { platform: 'other' },
    { product: 'aichat-desktop' }, { engine: 'node' }, { sourceHash: 'd'.repeat(64) }, { entry: '../outside' }]) {
    fs.writeFileSync(runtime.archive, original);
    mutateRuntimeArchive(runtime.archive, metadata => Object.assign(metadata, changes));
    await assert.rejects(evidence.collect(options), /identity|target|missing|stale/i, JSON.stringify(changes));
  }
  assert.equal(fs.existsSync(path.join(output, 'report.json')), false, 'invalid packages never leave a usable report');
});

test('cross-target packaging cannot inherit passed native, packaged or live acceptance from its host', async t => {
  const output = fixture(t), runtime = runtimeFixture(output, 'x64');
  runtimeContext(output, runtime.info);
  for (const level of ['native', 'packaged', 'live']) {
    const receipt = { id: 'host-only-observation', level, status: 'passed', evidence: ['fixture.log'] };
    fs.writeFileSync(path.join(output, 'checks/host-only-observation.json'), JSON.stringify(receipt));
    await assert.rejects(evidence.collect({ output, product: 'mcp-rust', artifact: runtime.archive }), /cannot reuse passed host/);
  }
});
