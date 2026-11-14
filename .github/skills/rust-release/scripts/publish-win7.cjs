#!/usr/bin/env node
'use strict';
// A separate legacy publisher. No default release can select this mode.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { verifyReceipt, readArgs, directEnvironment } = require('./download-artifacts.cjs');
const legacy = require('../../../../scripts/lib/win7-release.cjs');
const { auditDirectory } = require('../../../../scripts/lib/windows7-pe.cjs');
const cef = require('../../../../apps/aichat-rust/scripts/cef-release.cjs');
const qiniu = require('../../../../scripts/lib/qiniu-release.cjs');
const identity = require('../../../../scripts/lib/rust-runtime-identity.cjs');

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function entry(filePath, url) {
  const stat = fs.lstatSync(filePath);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Release input must be an ordinary file');
  return { filePath: path.resolve(filePath), name: path.basename(filePath), url,
    remoteKey: new URL(url).pathname.slice(1), size: stat.size, sha256: qiniu.sha256(filePath) };
}
function collectRelease(directory, { version, mcpVersion, commit, publicKey }) {
  const clientFile = path.join(directory, 'client/windows-x64/latest-client.json');
  const client = legacy.validateClientManifest(legacy.verifyEnvelope(readJson(clientFile), publicKey));
  assert.equal(client.version, version); assert.equal(client.commit, commit);
  const installer = entry(path.join(directory, client.fileName), client.url);
  assert.equal(installer.size, client.size); assert.equal(installer.sha256, client.sha256);
  const mcpFile = path.join(directory, 'mcp/windows-x64.json');
  const mcp = legacy.validateMcpManifest(legacy.verifyEnvelope(readJson(mcpFile), publicKey));
  assert.equal(mcp.version, mcpVersion); assert.equal(mcp.commit, commit);
  const mcpArchive = entry(path.join(directory, 'mcp', mcp.version, mcp.fileName), mcp.url);
  const members = legacy.validateMcpArchive(fs.readFileSync(mcpArchive.filePath), mcp);
  const cefFile = path.join(directory, 'cef/legacy/windows-x64/stable.json');
  const browser = cef.verifyEnvelope(readJson(cefFile), publicKey);
  assert.equal(browser.channel, 'legacy'); assert.equal(browser.arch, 'x64'); assert.equal(browser.chromiumMajor, 109);
  assert.deepEqual(browser.minWindows, [6, 1, 7601]);
  const browserUrl = `https://cdn.keepwork.com/keepwork/aichat-cef/v1/objects/${browser.sha256}.zip`;
  const browserArchive = entry(path.join(directory, 'cef/objects', browser.sha256 + '.zip'), browserUrl);
  assert.equal(browserArchive.size, browser.size); assert.equal(browserArchive.sha256, browser.sha256);
  const payload = path.join(directory, 'installer-payload');
  const peReport = auditDirectory(payload);
  const installedMcp = legacy.verifyEnvelope(readJson(path.join(payload, 'resources/win7-mcp.signed.json')), publicKey);
  assert.deepEqual(installedMcp, mcp, 'Bundled and independently published MCP differ');
  for (const file of mcp.files) {
    const bytes = fs.readFileSync(path.join(payload, 'resources/win7-mcp', file.path));
    assert.equal(bytes.length, file.size); assert.equal(legacy.digest(bytes), file.sha256);
  }
  const compiled = identity.validateBinary(path.join(payload, 'resources/win7-mcp/bin/keepwork-mcp.exe'),
    { triple: legacy.TARGET }, mcp);
  assert.equal(compiled.variant, 'win7-win8'); assert.deepEqual(compiled.minWindows, [6, 1, 7601]);
  const bundledCef = cef.verifyEnvelope(readJson(path.join(payload, 'resources/cef-bundled.signed.json')), publicKey);
  assert.deepEqual(bundledCef, browser, 'Bundled and independently published CEF differ');
  assert.equal(qiniu.sha256(path.join(payload, 'resources/cef-bundled.zip')), browser.sha256);
  const archives = [installer, mcpArchive, browserArchive];
  const scopeFile = path.join(directory, 'build-scope.json');
  const buildScope = fs.existsSync(scopeFile) ? readJson(scopeFile) : null;
  if (buildScope) {
    assert.equal(buildScope.schemaVersion, 1); assert.equal(buildScope.variant, 'win7-win8');
    assert.equal(buildScope.commit, commit, 'Legacy signing scope belongs to another build');
  }
  const feeds = [
    { ...entry(clientFile, `${legacy.CLIENT_BASE}/windows-x64/latest-client.json`), metadata: client },
    { ...entry(mcpFile, `${legacy.MCP_BASE}/windows-x64.json`), metadata: mcp },
    { ...entry(cefFile, 'https://cdn.keepwork.com/keepwork/aichat-cef/v1/legacy/windows-x64/stable.json'), metadata: browser },
  ];
  return { directory, client, mcp, browser, archives, feeds, peReport, buildScope,
    binarySha256: legacy.digest(members.get('bin/keepwork-mcp.exe')) };
}
function relativeEvidence(root, value) {
  assert.ok(typeof value === 'string' && value && !path.isAbsolute(value)
    && !value.split(/[\\/]/).some(part => !part || part === '.' || part === '..'), 'Evidence paths must be confined relative files');
  const file = path.join(root, value), stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0, 'Missing native acceptance evidence');
  const realRoot = fs.realpathSync(root) + path.sep, realFile = fs.realpathSync(file);
  assert.ok(realFile.startsWith(realRoot), 'Acceptance evidence escapes its report directory');
  return realFile;
}
function verifyAcceptance(reportFile, release) {
  const report = readJson(reportFile), root = path.dirname(path.resolve(reportFile));
  assert.equal(report.schemaVersion, 1); assert.equal(report.variant, 'win7-win8');
  assert.equal(report.version, release.client.version); assert.equal(report.mcpVersion, release.mcp.version);
  assert.equal(report.commit, release.client.commit); assert.equal(report.installerSha256, release.client.sha256);
  assert.ok(Array.isArray(report.systems) && report.systems.length === 3, 'Require three distinct legacy-system acceptance results');
  const families = new Map([['windows7-sp1', '6.1.'], ['windows8', '6.2.'], ['windows8.1', '6.3.']]);
  const evidence = [];
  for (const result of report.systems) {
    assert.ok(families.has(result.osFamily), 'Wrong or duplicate native OS result');
    const prefix = families.get(result.osFamily); families.delete(result.osFamily);
    const file = relativeEvidence(root, result.mcpReport), mcp = readJson(file);
    assert.equal(mcp.scope, 'mcp-native-basic-smoke'); assert.equal(mcp.passed, true);
    assert.equal(mcp.nativeLegacyVerified, true);
    assert.equal(mcp.system.osFamily, result.osFamily);
    assert.ok(mcp.system.version.startsWith(prefix), 'Native OS version mismatch');
    assert.match(mcp.system.version, /^6\.[123]\.\d+(?:\.\d+)?$/, 'Invalid native OS version');
    const minimumBuild = { 'windows7-sp1': 7601, windows8: 9200, 'windows8.1': 9600 }[result.osFamily];
    assert.ok(Number(mcp.system.version.split('.')[2]) >= minimumBuild, 'Native OS build is below the supported baseline');
    if (result.osFamily === 'windows7-sp1') assert.ok(Number(mcp.system.servicePackMajor) >= 1, 'Native Windows 7 result needs SP1');
    assert.equal(mcp.system.productType, 1, 'Native legacy result must be a workstation');
    assert.match(mcp.system.architecture, /^64(?:-bit|\s*位)?$/i, 'Native legacy result must be x64');
    assert.equal(mcp.artifact.sha256, release.binarySha256);
    assert.equal(mcp.artifact.version, release.mcp.version); assert.equal(mcp.artifact.commit, release.mcp.commit);
    assert.equal(mcp.artifact.sourceHash, release.mcp.sourceHash);
    assert.ok(Array.isArray(mcp.cases) && mcp.cases.length === 2 && mcp.cases.every(value => value.passed === true)
      && mcp.cases.some(value => value.requireAuth === true) && mcp.cases.some(value => value.requireAuth === false), 'Missing native auth matrix');
    // UI/update acceptance is a separate operator-attested result with evidence;
    // a successful MCP-only PowerShell report never implies these passed.
    for (const key of ['cefUi', 'installerUpgrade']) {
      assert.equal(result[key]?.passed, true, 'Missing native ' + key + ' acceptance');
      const nativeFile = relativeEvidence(root, result[key].evidence);
      evidence.push({ osFamily: result.osFamily, kind: key, file: result[key].evidence,
        sha256: qiniu.sha256(nativeFile) });
    }
    evidence.push({ osFamily: result.osFamily, kind: 'mcp', file: result.mcpReport, sha256: qiniu.sha256(file) });
  }
  return { systems: report.systems.map(value => value.osFamily), evidence };
}
function compareVersions(left, right) {
  assert.ok(legacy.stableVersion(left) && legacy.stableVersion(right));
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}
async function publishWin7(options, { transport = qiniu, fetchImpl = fetch } = {}) {
  const { artifacts, version, mcpVersion, commit, publicKeyFile, acceptanceFile, publish = false } = options;
  assert.ok(legacy.stableVersion(version) && legacy.stableVersion(mcpVersion)); assert.match(commit, /^[a-f0-9]{40}$/);
  verifyReceipt(artifacts, { product: 'win7-win8', commit });
  const publicKey = fs.readFileSync(publicKeyFile);
  const release = collectRelease(path.join(artifacts, 'aichat-rust-win7-win8-x64'), { version, mcpVersion, commit, publicKey });
  const pending = [];
  if (release.client.sourceDirty !== false) pending.push('clean-release-source');
  if (release.buildScope?.signing !== 'production' || release.buildScope?.productionTrustRoot !== true)
    pending.push('production-signing-key');
  if (!acceptanceFile) pending.push('three-native-systems-with-cef-and-update-acceptance');
  const acceptance = acceptanceFile ? verifyAcceptance(acceptanceFile, release) : null;
  const plan = { schemaVersion: 1, variant: 'win7-win8', dryRun: !publish, version, mcpVersion, commit,
    productionReady: pending.length === 0, pending, acceptance,
    archives: release.archives, feeds: release.feeds.map(({ metadata, ...value }) => value) };
  if (!publish) return plan;
  assert.equal(pending.length, 0, 'Win7/Win8 publication still lacks required acceptance: ' + pending.join(', '));
  // The trust root must come from the operator, never from this run's arbitrary
  // preview key. A downloaded public key is useful for review, not promotion.
  const artifactRoot = fs.realpathSync(artifacts) + path.sep;
  assert.ok(!fs.realpathSync(publicKeyFile).startsWith(artifactRoot), 'Supply the established release trust root outside the artifact');
  const request = url => fetchImpl(url, { headers: { 'Cache-Control': 'no-cache', 'Accept-Encoding': 'identity' },
    redirect: 'error', signal: AbortSignal.timeout(60000) });
  for (const feed of release.feeds) {
    const response = await request(feed.url);
    if (response.ok) {
      const previous = legacy.verifyEnvelope(await response.json(), publicKey);
      const comparison = compareVersions(previous.version, feed.metadata.version);
      assert.ok(comparison <= 0, 'Refusing legacy feed downgrade');
      if (comparison === 0) assert.equal(previous.sha256, feed.metadata.sha256, 'Same legacy version has different immutable bytes');
    } else { await response.body?.cancel(); assert.equal(response.status, 404, 'Legacy feed preflight failed'); }
  }
  const missing = [];
  for (const item of release.archives) {
    const response = await request(item.url);
    if (response.ok) assert.equal(legacy.digest(Buffer.from(await response.arrayBuffer())), item.sha256, 'Existing immutable legacy archive differs');
    else { await response.body?.cancel(); assert.equal(response.status, 404, 'Legacy archive preflight failed'); missing.push(item); }
  }
  const config = { accessKey: qiniu.required(process.env.KP_QINIU_ACCESS_KEY, 'KP_QINIU_ACCESS_KEY'),
    secretKey: qiniu.required(process.env.KP_QINIU_SECRET_KEY, 'KP_QINIU_SECRET_KEY'), bucket: 'haqi', uploadHost: 'https://up-z2.qiniup.com' };
  for (const item of [...release.archives, ...release.feeds]) {
    assert.equal(fs.statSync(item.filePath).size, item.size); assert.equal(qiniu.sha256(item.filePath), item.sha256, 'Legacy artifact changed after preflight');
  }
  for (const item of missing) await transport.uploadEntry(config, item);
  await transport.refreshUrls(config, release.archives.map(value => value.url));
  await transport.verifyEntriesWithRetry(release.archives);
  // No mutable pointer moves until every immutable client/MCP/CEF byte passed.
  for (const item of release.feeds) await transport.uploadEntry(config, item);
  await transport.refreshUrls(config, release.feeds.map(value => value.url));
  await transport.verifyEntriesWithRetry(release.feeds);
  return { ...plan, published: true };
}
if (require.main === module) {
  (async () => {
    const args = readArgs(process.argv.slice(2), ['artifacts', 'version', 'mcp-version', 'commit', 'public-key', 'acceptance', 'publish']);
    assert.ok(args.artifacts && args.version && args['mcp-version'] && args.commit && args['public-key'],
      'Use --artifacts DIRECTORY --version X.Y.Z --mcp-version X.Y.Z --commit FULL_SHA --public-key TRUSTED.pem [--acceptance FILE] [--publish true]');
    assert.ok(!args.publish || args.publish === 'true', 'Only --publish true enables publication');
    if (args.publish) {
      const environment = directEnvironment();
      for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
    }
    const result = await publishWin7({ artifacts: path.resolve(args.artifacts), version: args.version,
      mcpVersion: args['mcp-version'], commit: args.commit, publicKeyFile: path.resolve(args['public-key']),
      acceptanceFile: args.acceptance && path.resolve(args.acceptance), publish: args.publish === 'true' });
    console.log(JSON.stringify(result, null, 2));
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { collectRelease, verifyAcceptance, publishWin7, compareVersions };
