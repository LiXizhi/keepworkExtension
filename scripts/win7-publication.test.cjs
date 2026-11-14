const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fixture, cefFixture, key } = require('../apps/aichat-rust/tests/win7-package.test.cjs');
const { preparePayload, finalizeInstaller } = require('../apps/aichat-rust/scripts/package-win7.cjs');
const { collectRelease, verifyAcceptance, publishWin7 } = require('../.github/skills/rust-release/scripts/publish-win7.cjs');
const { downloadArtifacts, verifyReceipt, PROXY } = require('../.github/skills/rust-release/scripts/download-artifacts.cjs');

const commit = 'a'.repeat(40), artifactName = 'aichat-rust-win7-win8-x64';
const workflow = '.github/workflows/aichat-rust-windows-release.yml';
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-legacy-publication-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2)); }

function acceptanceFixture(t, release = {
  client: { version: '0.2.126', commit, sha256: 'c'.repeat(64) },
  mcp: { version: '0.2.61', commit, sourceHash: 'b'.repeat(64) }, binarySha256: 'd'.repeat(64),
}) {
  const directory = temporary(t);
  const report = { schemaVersion: 1, variant: 'win7-win8', version: release.client.version,
    mcpVersion: release.mcp.version, commit, installerSha256: release.client.sha256, systems: [] };
  const smokeFiles = [];
  for (const [osFamily, version] of [['windows7-sp1', '6.1.7601'], ['windows8', '6.2.9200'], ['windows8.1', '6.3.9600']]) {
    const mcpReport = osFamily + '-mcp.json', smoke = {
      schemaVersion: 1, scope: 'mcp-native-basic-smoke', passed: true, nativeLegacyVerified: true,
      nativeWin7Verified: osFamily === 'windows7-sp1', cefUiVerified: false,
      system: { osFamily, version, servicePackMajor: osFamily === 'windows7-sp1' ? 1 : 0,
        productType: 1, architecture: '64-bit' },
      artifact: { sha256: release.binarySha256, version: release.mcp.version,
        commit: release.mcp.commit, sourceHash: release.mcp.sourceHash },
      cases: [{ passed: true, requireAuth: false }, { passed: true, requireAuth: true }],
    };
    const file = path.join(directory, mcpReport); writeJson(file, smoke); smokeFiles.push(file);
    const cefUi = { passed: true, evidence: osFamily + '-cef.txt' };
    const installerUpgrade = { passed: true, evidence: osFamily + '-update.txt' };
    for (const entry of [cefUi, installerUpgrade]) fs.writeFileSync(path.join(directory, entry.evidence), 'Operator-attested acceptance fixture; not a real native test.');
    report.systems.push({ osFamily, mcpReport, cefUi, installerUpgrade });
  }
  const reportFile = path.join(directory, 'acceptance.json'); writeJson(reportFile, report);
  return { directory, release, report, reportFile, smokeFiles };
}

test('three distinct OS smoke reports require separate UI and update evidence', t => {
  const f = acceptanceFixture(t), result = verifyAcceptance(f.reportFile, f.release);
  assert.deepEqual(result.systems, ['windows7-sp1', 'windows8', 'windows8.1']);
  assert.equal(result.evidence.length, 9);
  assert.ok(result.evidence.every(entry => /^[a-f0-9]{64}$/.test(entry.sha256)));
});

for (const [label, change] of [
  ['a single OS result', report => { report.systems = report.systems.slice(0, 1); }],
  ['the same OS copied three times', report => { report.systems = [report.systems[0], report.systems[0], report.systems[0]]; }],
  ['a different source commit', report => { report.commit = 'f'.repeat(40); }],
  ['a different installer', report => { report.installerSha256 = 'f'.repeat(64); }],
  ['missing CEF UI evidence', report => { delete report.systems[0].cefUi; }],
  ['missing installer/update evidence', report => { delete report.systems[1].installerUpgrade; }],
  ['an unpassed CEF result', report => { report.systems[2].cefUi.passed = false; }],
  ['a traversing evidence path', report => { report.systems[0].cefUi.evidence = '../outside.txt'; }],
]) test(`publication acceptance refuses ${label}`, t => {
  const f = acceptanceFixture(t); change(f.report); writeJson(f.reportFile, f.report);
  assert.throws(() => verifyAcceptance(f.reportFile, f.release));
});

for (const [label, change, smokeIndex = 0] of [
  ['modern-host verification', smoke => { smoke.nativeLegacyVerified = false; }],
  ['a modern OS version relabeled as legacy', smoke => { smoke.system.version = '10.0.26100'; }],
  ['the wrong runtime binary', smoke => { smoke.artifact.sha256 = 'e'.repeat(64); }],
  ['the wrong runtime commit', smoke => { smoke.artifact.commit = 'e'.repeat(40); }],
  ['the wrong runtime sources', smoke => { smoke.artifact.sourceHash = 'e'.repeat(64); }],
  ['missing authentication coverage', smoke => { smoke.cases = smoke.cases.slice(0, 1); }],
  ['two copies of the same authentication mode', smoke => { smoke.cases[1].requireAuth = false; }],
  ['an unsuccessful authentication mode', smoke => { smoke.cases[1].passed = false; }],
  ['the wrong native smoke scope', smoke => { smoke.scope = 'source-fixture-only'; }],
  ['Windows 7 without SP1', smoke => { smoke.system.version = '6.1.7600'; smoke.system.servicePackMajor = 0; }],
  ['a prerelease Windows 8 build', smoke => { smoke.system.version = '6.2.8102'; }, 1],
  ['a prerelease Windows 8.1 build', smoke => { smoke.system.version = '6.3.9431'; }, 2],
  ['a 32-bit native result', smoke => { smoke.system.architecture = '32-bit'; }],
  ['a server result relabeled as a workstation', smoke => { smoke.system.productType = 3; }, 1],
]) test(`publication acceptance refuses ${label}`, t => {
  const f = acceptanceFixture(t);
  const smoke = JSON.parse(fs.readFileSync(f.smokeFiles[smokeIndex]));
  change(smoke); writeJson(f.smokeFiles[smokeIndex], smoke);
  assert.throws(() => verifyAcceptance(f.reportFile, f.release));
});

function downloadFixture(t, options = {}) {
  const root = temporary(t), calls = [], output = path.join(root, 'download');
  const request = { product: 'win7-win8', runId: '123', commit, output, repository: 'fixture/repository' };
  const exec = (command, args, settings) => {
    calls.push({ command, args, settings }); assert.equal(command, 'gh');
    if (args[0] === 'api') {
      if (args.some(value => String(value).includes('/artifacts'))) {
        return JSON.stringify([{ artifacts: options.artifacts || [{ name: artifactName, expired: false }] }]);
      }
      return JSON.stringify({ id: 123, head_sha: commit, path: workflow, status: 'completed',
        conclusion: 'success', event: 'workflow_dispatch', ...options.run });
    }
    assert.deepEqual(args.slice(0, 3), ['run', 'download', '123']);
    const directory = args[args.indexOf('--dir') + 1];
    if (options.sourceDirectory) fs.cpSync(options.sourceDirectory, directory, { recursive: true });
    else { fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, 'fixture.txt'), 'reviewed legacy artifact bytes'); }
    return '';
  };
  return { root, calls, request, exec, env: { PATH: '/fixture/path', NO_PROXY: '*',
    KP_QINIU_ACCESS_KEY: 'fixture-access', KP_QINIU_SECRET_KEY: 'fixture-secret' } };
}

test('legacy downloads keep the fixed source run, dedicated artifact identity and proxy isolation', t => {
  const f = downloadFixture(t), receipt = downloadArtifacts(f.request, f);
  assert.equal(receipt.product, 'win7-win8'); assert.equal(receipt.workflow, workflow);
  assert.deepEqual(receipt.artifacts, [artifactName]);
  assert.ok(verifyReceipt(f.request.output, { product: 'win7-win8', commit }));
  for (const call of f.calls) {
    assert.equal(call.settings.env.HTTPS_PROXY, PROXY);
    assert.equal(call.settings.env.NO_PROXY, '');
    assert.equal(call.settings.env.KP_QINIU_ACCESS_KEY, undefined);
    assert.equal(call.settings.env.KP_QINIU_SECRET_KEY, undefined);
  }
  assert.throws(() => verifyReceipt(f.request.output, { product: 'desktop', commit }));
});

for (const [label, options] of [
  ['a different workflow', { run: { path: '.github/workflows/aichat-rust-win7.yml' } }],
  ['a different run ID', { run: { id: 456 } }],
  ['a different commit', { run: { head_sha: 'b'.repeat(40) } }],
  ['a PR run', { run: { event: 'pull_request' } }],
  ['a failed run', { run: { conclusion: 'failure' } }],
  ['only a modern desktop artifact', { artifacts: [{ name: 'aichat-rust-release-packages', expired: false }] }],
  ['an expired legacy artifact', { artifacts: [{ name: artifactName, expired: true }] }],
  ['duplicate legacy artifacts', { artifacts: [{ name: artifactName }, { name: artifactName }] }],
]) test(`legacy downloads reject ${label} before downloading files`, t => {
  const f = downloadFixture(t, options);
  assert.throws(() => downloadArtifacts(f.request, f));
  assert.equal(f.calls.some(call => call.args[0] === 'run'), false);
  assert.equal(fs.existsSync(path.join(f.request.output, 'download-receipt.json')), false);
});

function publisherFixture(t, sourceDirty, buildScope = {
  schemaVersion: 1, variant: 'win7-win8', commit, signing: 'production', productionTrustRoot: true,
}) {
  const f = fixture(t); cefFixture(f);
  const prepared = preparePayload({ ...f.options, sourceDirty });
  const installer = path.join(prepared.output, `Keepwork_Win7_Win8_${prepared.version}_x64-setup.exe`);
  // Only the byte/signature gate is under test. No installer is executed.
  const stub = Buffer.alloc(256); stub.write('MZ'); fs.writeFileSync(installer, stub);
  const finalized = finalizeInstaller(prepared, installer, key.privateKey);
  if (buildScope) writeJson(path.join(finalized.output, 'build-scope.json'), buildScope);
  const download = downloadFixture(t, { sourceDirectory: finalized.output });
  downloadArtifacts(download.request, download);
  const trustedKey = path.join(f.root, 'operator-trusted-public.pem');
  fs.writeFileSync(trustedKey, key.publicKey.export({ type: 'spki', format: 'pem' }));
  const release = collectRelease(path.join(download.request.output, artifactName), {
    version: finalized.version, mcpVersion: finalized.manifest.version, commit, publicKey: key.publicKey,
  });
  const calls = [];
  const dependencies = {
    transport: new Proxy({}, { get: (object, name) => async () => { calls.push(String(name)); throw Error('Unexpected network write'); } }),
    fetchImpl: async () => { calls.push('fetch'); throw Error('Unexpected network access'); },
  };
  return { release, calls, dependencies, options: { artifacts: download.request.output,
    version: finalized.version, mcpVersion: finalized.manifest.version, commit, publicKeyFile: trustedKey } };
}

test('publication without three-OS acceptance stops before any network access or write', async t => {
  const f = publisherFixture(t, false);
  await assert.rejects(publishWin7({ ...f.options, publish: true }, f.dependencies), /acceptance/);
  assert.deepEqual(f.calls, []);
});

test('dirty-source publication is rejected even with a complete acceptance fixture', async t => {
  const f = publisherFixture(t, true), acceptance = acceptanceFixture(t, f.release);
  await assert.rejects(publishWin7({ ...f.options, acceptanceFile: acceptance.reportFile, publish: true }, f.dependencies), /clean-release-source/);
  assert.deepEqual(f.calls, []);
});

for (const [label, scope] of [
  ['preview signing', { schemaVersion: 1, variant: 'win7-win8', commit, signing: 'preview', productionTrustRoot: false }],
  ['a missing signing-scope record', null],
  ['a production label without the production trust root', { schemaVersion: 1, variant: 'win7-win8', commit, signing: 'production', productionTrustRoot: false }],
  ['a preview label with a contradictory production flag', { schemaVersion: 1, variant: 'win7-win8', commit, signing: 'preview', productionTrustRoot: true }],
]) test(`publication refuses ${label} despite clean sources and complete three-OS acceptance`, async t => {
  const f = publisherFixture(t, false, scope), acceptance = acceptanceFixture(t, f.release);
  const options = { ...f.options, acceptanceFile: acceptance.reportFile };
  const plan = await publishWin7({ ...options, publish: false }, f.dependencies);
  assert.equal(plan.productionReady, false);
  assert.deepEqual(plan.pending, ['production-signing-key']);
  assert.deepEqual(f.calls, []);
  await assert.rejects(publishWin7({ ...options, publish: true }, f.dependencies), /production-signing-key/);
  assert.deepEqual(f.calls, []);
});

test('production scope and full native acceptance can produce a ready plan without contacting the network', async t => {
  const f = publisherFixture(t, false), acceptance = acceptanceFixture(t, f.release);
  const plan = await publishWin7({ ...f.options, acceptanceFile: acceptance.reportFile, publish: false }, f.dependencies);
  assert.equal(plan.productionReady, true);
  assert.deepEqual(plan.pending, []);
  assert.deepEqual(f.calls, []);
});

test('local publication planning remains read-only and reports outstanding native gates', async t => {
  const f = publisherFixture(t, true);
  const plan = await publishWin7({ ...f.options, publish: false }, f.dependencies);
  assert.equal(plan.dryRun, true); assert.equal(plan.productionReady, false);
  assert.ok(plan.pending.includes('clean-release-source'));
  assert.ok(plan.pending.includes('three-native-systems-with-cef-and-update-acceptance'));
  assert.deepEqual(f.calls, []);
});
