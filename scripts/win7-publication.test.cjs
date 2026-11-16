const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
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

function waiverFixture(t, release) {
  const directory = temporary(t), waiverFile = path.join(directory, 'native-acceptance-waiver.json');
  const waiver = { schemaVersion: 1, variant: 'win7-win8', version: release.client.version,
    mcpVersion: release.mcp.version, commit: release.client.commit, installerSha256: release.client.sha256,
    osFamilies: ['windows7-sp1', 'windows8', 'windows8.1'], authorizedBy: 'user',
    authorization: 'Win7 SP1、Win8、Win8.1 这三个不用测了，直接发 CDN，把这个接入 SKILL',
    nativeLegacyVerified: false };
  writeJson(waiverFile, waiver);
  return { waiverFile, waiver };
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

test('all-edition runs download only the dedicated legacy artifact into the legacy receipt', t => {
  const f = downloadFixture(t, { artifacts: [
    { name: 'aichat-rust-release-packages', expired: false },
    { name: artifactName, expired: false },
    { name: 'rust-desktop-validation-windows-latest', expired: false },
  ] });
  const receipt = downloadArtifacts(f.request, f);
  const downloads = f.calls.filter(call => call.args[0] === 'run');
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].args[downloads[0].args.indexOf('--name') + 1], artifactName);
  assert.deepEqual(receipt.artifacts, [artifactName]);
  assert.ok(receipt.files.every(file => file.path.startsWith(artifactName + '/')));
  assert.ok(verifyReceipt(f.request.output, { product: 'win7-win8', commit }));
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

test('explicit user waiver produces a ready plan while preserving the unverified native status', async t => {
  const f = publisherFixture(t, false), waiver = waiverFixture(t, f.release);
  const before = fs.readFileSync(waiver.waiverFile);
  const plan = await publishWin7({ ...f.options, nativeAcceptanceWaiverFile: waiver.waiverFile }, f.dependencies);
  assert.equal(plan.productionReady, true);
  assert.equal(plan.dryRun, true);
  assert.deepEqual(plan.pending, []);
  assert.equal(plan.acceptance.mode, 'waived-by-user');
  assert.equal(plan.acceptance.nativeLegacyVerified, false);
  assert.equal(plan.nativeAcceptance, 'waived-by-user');
  assert.equal(plan.nativeLegacyVerified, false);
  assert.deepEqual(plan.acceptance.systems, waiver.waiver.osFamilies);
  assert.equal(plan.acceptance.authorization, waiver.waiver.authorization);
  assert.equal(plan.acceptance.waiverSha256, crypto.createHash('sha256').update(before).digest('hex'));
  assert.deepEqual(fs.readFileSync(waiver.waiverFile), before);
  assert.deepEqual(f.calls, []);
});

for (const [label, change] of [
  ['another schema', value => { value.schemaVersion = 2; }],
  ['a modern variant', value => { value.variant = 'modern'; }],
  ['a different desktop version', value => { value.version = '0.2.999'; }],
  ['a different MCP version', value => { value.mcpVersion = '0.2.999'; }],
  ['a different source commit', value => { value.commit = 'f'.repeat(40); }],
  ['a different installer digest', value => { value.installerSha256 = 'f'.repeat(64); }],
  ['a missing legacy OS', value => { value.osFamilies.pop(); }],
  ['a duplicate legacy OS', value => { value.osFamilies[1] = value.osFamilies[0]; }],
  ['an unrelated OS', value => { value.osFamilies[0] = 'windows10'; }],
  ['an additional OS', value => { value.osFamilies.push('windows10'); }],
  ['missing user attribution', value => { delete value.authorizedBy; }],
  ['agent attribution', value => { value.authorizedBy = 'agent'; }],
  ['missing authorization', value => { delete value.authorization; }],
  ['blank authorization', value => { value.authorization = '  \n '; }],
  ['a non-text authorization', value => { value.authorization = true; }],
  ['claimed native verification', value => { value.nativeLegacyVerified = true; }],
  ['unknown native verification', value => { delete value.nativeLegacyVerified; }],
]) test(`native acceptance waiver refuses ${label} before any network access`, async t => {
  const f = publisherFixture(t, false), waiver = waiverFixture(t, f.release);
  change(waiver.waiver); writeJson(waiver.waiverFile, waiver.waiver);
  await assert.rejects(publishWin7({ ...f.options, nativeAcceptanceWaiverFile: waiver.waiverFile, publish: true }, f.dependencies));
  assert.deepEqual(f.calls, []);
});

test('native acceptance evidence and user waiver cannot be supplied together', async t => {
  const f = publisherFixture(t, false), waiver = waiverFixture(t, f.release), acceptance = acceptanceFixture(t, f.release);
  await assert.rejects(publishWin7({ ...f.options, nativeAcceptanceWaiverFile: waiver.waiverFile,
    acceptanceFile: acceptance.reportFile, publish: true }, f.dependencies));
  assert.deepEqual(f.calls, []);
});

for (const [label, sourceDirty, scope, pending] of [
  ['dirty release source', true, undefined, 'clean-release-source'],
  ['preview signing', false, { schemaVersion: 1, variant: 'win7-win8', commit,
    signing: 'preview', productionTrustRoot: false }, 'production-signing-key'],
  ['missing signing scope', false, null, 'production-signing-key'],
  ['an absent production trust root', false, { schemaVersion: 1, variant: 'win7-win8', commit,
    signing: 'production', productionTrustRoot: false }, 'production-signing-key'],
]) test(`user waiver does not bypass ${label}`, async t => {
  const f = publisherFixture(t, sourceDirty, scope), waiver = waiverFixture(t, f.release);
  const options = { ...f.options, nativeAcceptanceWaiverFile: waiver.waiverFile };
  const plan = await publishWin7(options, f.dependencies);
  assert.equal(plan.productionReady, false);
  assert.deepEqual(plan.pending, [pending]);
  assert.equal(plan.acceptance.nativeLegacyVerified, false);
  await assert.rejects(publishWin7({ ...options, publish: true }, f.dependencies), new RegExp(pending));
  assert.deepEqual(f.calls, []);
});

test('user waiver preserves signed artifact and download receipt checks', async t => {
  const f = publisherFixture(t, false), waiver = waiverFixture(t, f.release);
  const clientFile = path.join(f.options.artifacts, artifactName, 'client/windows-x64/latest-client.json');
  const bytes = fs.readFileSync(clientFile);
  fs.appendFileSync(clientFile, '\n');
  await assert.rejects(publishWin7({ ...f.options, nativeAcceptanceWaiverFile: waiver.waiverFile, publish: true }, f.dependencies), /receipt|SHA-256|files changed/i);
  fs.writeFileSync(clientFile, bytes);
  const otherKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  fs.writeFileSync(f.options.publicKeyFile, otherKey.publicKey.export({ type: 'spki', format: 'pem' }));
  await assert.rejects(publishWin7({ ...f.options, nativeAcceptanceWaiverFile: waiver.waiverFile, publish: true }, f.dependencies), /signature/i);
  assert.deepEqual(f.calls, []);
});

for (const kind of ['installer byte integrity', 'Windows 7 PE compatibility']) {
  test(`user waiver preserves ${kind} after receipt verification`, async t => {
    const f = publisherFixture(t, false), waiver = waiverFixture(t, f.release);
    const file = kind === 'installer byte integrity' ? f.release.archives[0].filePath
      : path.join(f.options.artifacts, artifactName, 'installer-payload/Keepwork.exe');
    const bytes = fs.readFileSync(file);
    if (kind === 'installer byte integrity') bytes[bytes.length - 1] ^= 1;
    else bytes.writeUInt16LE(10, 0x98 + 48);
    fs.writeFileSync(file, bytes);
    // This fixture models a consistently inventoried but invalid package, so
    // rejection must come from the signed-byte or PE gate after the receipt.
    const receiptFile = path.join(f.options.artifacts, 'download-receipt.json');
    const receipt = JSON.parse(fs.readFileSync(receiptFile));
    const name = path.relative(f.options.artifacts, file).split(path.sep).join('/');
    receipt.files.find(entry => entry.path === name).sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    writeJson(receiptFile, receipt);
    assert.ok(verifyReceipt(f.options.artifacts, { product: 'win7-win8', commit }));
    await assert.rejects(publishWin7({ ...f.options, nativeAcceptanceWaiverFile: waiver.waiverFile, publish: true }, f.dependencies),
      kind === 'installer byte integrity' ? /[a-f0-9]{64}/ : /minimum OS\/subsystem exceeds Windows 7/);
    assert.deepEqual(f.calls, []);
  });
}

test('user waiver does not allow an existing immutable feed to change bytes at the same version', async t => {
  const f = publisherFixture(t, false), waiver = waiverFixture(t, f.release);
  const legacy = require('./lib/win7-release.cjs');
  const existing = legacy.signEnvelope({ ...f.release.client, sha256: 'f'.repeat(64) }, key.privateKey);
  await assert.rejects(publishWin7({ ...f.options, nativeAcceptanceWaiverFile: waiver.waiverFile, publish: true }, {
    ...f.dependencies,
    fetchImpl: async () => ({ ok: true, json: async () => existing }),
  }), /Same legacy version has different immutable bytes/);
  assert.deepEqual(f.calls, []);
});

test('waived publication retains immutable archive verification before moving signed feeds', async t => {
  const f = publisherFixture(t, false), waiver = waiverFixture(t, f.release), events = [];
  const saved = new Map(['KP_QINIU_ACCESS_KEY', 'KP_QINIU_SECRET_KEY'].map(name => [name, process.env[name]]));
  t.after(() => { for (const [name, value] of saved) if (value === undefined) delete process.env[name]; else process.env[name] = value; });
  process.env.KP_QINIU_ACCESS_KEY = 'fixture-access';
  process.env.KP_QINIU_SECRET_KEY = 'fixture-secret';
  const transport = {
    uploadEntry: async (config, entry) => { events.push(['upload', entry.url]); },
    refreshUrls: async (config, urls) => { events.push(['refresh', ...urls]); },
    verifyEntriesWithRetry: async entries => { events.push(['verify', ...entries.map(entry => entry.url)]); },
  };
  const fetchImpl = async url => { events.push(['fetch', url]); return { ok: false, status: 404 }; };
  const plan = await publishWin7({ ...f.options, nativeAcceptanceWaiverFile: waiver.waiverFile, publish: true }, { transport, fetchImpl });
  assert.equal(plan.published, true);
  assert.equal(plan.productionReady, true);
  assert.equal(plan.acceptance.nativeLegacyVerified, false);
  assert.equal(plan.acceptance.mode, 'waived-by-user');
  assert.equal(plan.nativeAcceptance, 'waived-by-user');
  assert.equal(plan.nativeLegacyVerified, false);
  const archiveUrls = plan.archives.map(entry => entry.url), feedUrls = plan.feeds.map(entry => entry.url);
  assert.deepEqual(events.filter(event => event[0] === 'upload').map(event => event[1]), [...archiveUrls, ...feedUrls]);
  const verifiedArchives = events.findIndex(event => event[0] === 'verify' && event[1] === archiveUrls[0]);
  const firstFeedWrite = events.findIndex(event => event[0] === 'upload' && event[1] === feedUrls[0]);
  assert.ok(verifiedArchives >= 0 && verifiedArchives < firstFeedWrite);
  assert.deepEqual(events.at(-1), ['verify', ...feedUrls]);
});

test('CLI accepts the explicit native waiver and keeps publication disabled by default', t => {
  const f = publisherFixture(t, false), waiver = waiverFixture(t, f.release);
  const text = execFileSync(process.execPath, [path.resolve('.github/skills/rust-release/scripts/publish-win7.cjs'),
    '--artifacts', f.options.artifacts, '--version', f.options.version, '--mcp-version', f.options.mcpVersion,
    '--commit', commit, '--public-key', f.options.publicKeyFile, '--native-acceptance-waiver', waiver.waiverFile],
  { encoding: 'utf8', timeout: 30000 });
  const plan = JSON.parse(text);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.productionReady, true);
  assert.equal(plan.published, undefined);
  assert.equal(plan.acceptance.mode, 'waived-by-user');
  assert.equal(plan.acceptance.nativeLegacyVerified, false);
});
