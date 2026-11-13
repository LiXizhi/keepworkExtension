const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const evidence = require('./rust-validation-evidence.cjs');

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
