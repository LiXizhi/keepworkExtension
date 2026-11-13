#!/usr/bin/env node
// Explicit publication only. Build/CI packaging never promotes the stable feed.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const qiniu = require('../../../scripts/lib/qiniu-release.cjs');
const { validateRustManifest, timestamp } = require('../../../scripts/lib/update-manifest.cjs');
const { readRuntimeArchive } = require('../../../scripts/lib/runtime-archive.cjs');
const { validateBinary } = require('../../../scripts/lib/rust-runtime-identity.cjs');
const { writeCdnSummary } = require('../../../scripts/lib/cdn-summary.cjs');

const BASE = 'https://cdn.keepwork.com/keepwork/mcp-stable-rs';
const TRIPLES = {
  'macos-arm64': 'aarch64-apple-darwin', 'macos-x64': 'x86_64-apple-darwin',
  'windows-arm64': 'aarch64-pc-windows-msvc', 'windows-x64': 'x86_64-pc-windows-msvc',
  'linux-arm64': 'aarch64-unknown-linux-gnu', 'linux-x64': 'x86_64-unknown-linux-gnu',
};
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const entry = (filePath, url) => ({ name: path.basename(filePath), filePath, url,
  remoteKey: new URL(url).pathname.slice(1), size: fs.statSync(filePath).size, sha256: qiniu.sha256(filePath) });

function collectRelease(directory, { target, version, commit }) {
  if (!TRIPLES[target]) throw Error('Unsupported Rust publication target');
  qiniu.normalizeVersion(version);
  if (!/^[a-f0-9]{40}$/.test(commit || '')) throw Error('Expected a full release commit');
  const metadata = validateRustManifest(JSON.parse(fs.readFileSync(path.join(directory, `${target}.json`), 'utf8')));
  if (`${metadata.platform}-${metadata.arch}` !== target || metadata.version !== version || metadata.commit !== commit
    || metadata.url !== `${BASE}/${version}/${target}.zip`) throw Error('Rust publication identity/URL mismatch');
  const archive = entry(path.join(directory, metadata.fileName), metadata.url);
  if (archive.size !== metadata.size || archive.sha256 !== metadata.sha256) throw Error('Rust archive size/SHA-256 mismatch');
  const members = readRuntimeArchive(fs.readFileSync(archive.filePath));
  const runtime = JSON.parse(members.get('runtime.json')?.toString() || 'null');
  const binaryName = `bin/keepwork-mcp${metadata.platform === 'windows' ? '.exe' : ''}`;
  if (!runtime || !members.get('LICENSE')?.length || !members.get(binaryName)?.length || runtime.entry !== binaryName) throw Error('Rust archive required members are missing');
  for (const key of ['schemaVersion', 'product', 'engine', 'version', 'commit', 'sourceHash', 'platform', 'arch']) {
    if (runtime[key] !== metadata[key]) throw Error('Rust archive runtime identity mismatch: ' + key);
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-publication-identity-'));
  try {
    const binary = path.join(temporary, 'binary');
    fs.writeFileSync(binary, members.get(binaryName));
    const info = validateBinary(binary, { triple: TRIPLES[target] }, metadata);
    if (info.builtAt !== undefined) {
      for (const key of ['builtAt', 'builtAtSource']) {
        if (runtime[key] !== info[key] || metadata[key] !== info[key]) {
          throw Error('Rust compiled build timestamp mismatch: ' + key);
        }
      }
    }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  return { metadata, archive, target, feedUrl: `${BASE}/${target}.json` };
}

// These gates need a real account, network or interacting desktop and can never run
// inside CI. An explicitly requested deferred publication still demands a clean source
// snapshot and verified archive identity, and records every skipped gate in the receipt.
const DEFERRED_GATES = ['package-integrity', 'runtime-live-identity', 'runtime-update-rollback',
  'compatibility-matrix', 'cli-live', 'messaging-live'];

async function verifyAcceptance(reportFile, release, { acceptance = 'required' } = {}) {
  if (!reportFile) throw Error('Publishing requires a release acceptance report (complete release acceptance unless deferred is explicit)');
  if (!['required', 'deferred'].includes(acceptance)) throw Error('Unknown acceptance mode: ' + acceptance);
  const evidence = require('../../../scripts/rust-validation-evidence.cjs');
  const report = acceptance === 'required'
    ? await evidence.verify(reportFile, { requireComplete: true })
    : await evidence.verify(reportFile);
  if (report.product !== 'mcp-rust' || report.version !== release.metadata.version || report.commit !== release.metadata.commit
    || report.platform !== release.metadata.platform || report.arch !== release.metadata.arch
    || report.artifact?.sha256 !== release.archive.sha256 || report.artifact?.size !== release.archive.size) {
    throw Error('Release acceptance does not match the final Rust archive/target/runtime');
  }
  // collectRelease already proved the archive's compiled identity. A report that never
  // recorded the runtime block cannot contradict it; one that did must agree exactly.
  const runtimeMatches = report.runtime === null
    ? true
    : report.runtime.engine === 'rust' && report.runtime.version === release.metadata.version
      && report.runtime.commit === release.metadata.commit;
  if (!runtimeMatches) throw Error('Release acceptance does not match the final Rust archive/target/runtime');
  if (acceptance === 'deferred') {
    if (report.sourceDirty !== false) throw Error('Deferred publication requires a clean source snapshot');
    const pending = report.checks.filter(check => check.status !== 'passed').map(check => check.id);
    const unexpected = pending.filter(id => !DEFERRED_GATES.includes(id));
    if (unexpected.length) throw Error('Deferred publication cannot skip: ' + unexpected.join(', '));
    return { ...report, deferredGates: pending };
  }
  return report;
}

function compareVersions(left, right) {
  const a = qiniu.normalizeVersion(left).split('.').map(Number), b = qiniu.normalizeVersion(right).split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

async function publishRelease(release, config, { reportFile, acceptance = 'required', fetchImpl = fetch, transport = qiniu, now = () => new Date().toISOString() } = {}) {
  // No network writes (or reads) precede the existing final-package release gate.
  const acceptanceReport = await verifyAcceptance(reportFile, release, { acceptance });
  const request = url => fetchImpl(`${url}?kp_release_preflight=${Date.now()}`, {
    headers: { 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(60_000), redirect: 'error',
  });
  const feedResponse = await request(release.feedUrl);
  let previous;
  if (feedResponse.ok) {
    previous = validateRustManifest(await feedResponse.json());
    if (`${previous.platform}-${previous.arch}` !== release.target) throw Error('Existing Rust feed target mismatch');
    const comparison = compareVersions(previous.version, release.metadata.version);
    if (comparison > 0) throw Error('Refusing Rust update downgrade');
    if (comparison === 0 && ['url', 'size', 'sha256', 'commit', 'sourceHash'].some(key => previous[key] !== release.metadata[key])) throw Error('Same Rust version has different immutable package bytes/identity');
  } else {
    await feedResponse.body?.cancel();
    if (feedResponse.status !== 404) throw Error(`Rust feed preflight HTTP ${feedResponse.status}`);
  }
  const archiveResponse = await request(release.archive.url);
  const missing = archiveResponse.status === 404;
  if (archiveResponse.ok) {
    const bytes = Buffer.from(await archiveResponse.arrayBuffer());
    if (bytes.length !== release.archive.size || digest(bytes) !== release.archive.sha256) throw Error('Immutable Rust CDN archive differs');
  } else {
    await archiveResponse.body?.cancel();
    if (!missing) throw Error(`Rust archive preflight HTTP ${archiveResponse.status}`);
  }
  const publishedAt = previous?.version === release.metadata.version && previous.publishedAt ? previous.publishedAt : now();
  timestamp(publishedAt, 'publishedAt');
  const manifest = { ...release.metadata, publishedAt };
  validateRustManifest(manifest);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-publication-feed-'));
  try {
    const file = path.join(temporary, `${release.target}.json`);
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
    const feed = { ...entry(file, release.feedUrl),
      mimeType: 'application/json', cacheControl: 'public, max-age=60, must-revalidate' };
    if (missing) {
      await transport.uploadEntry({ ...config, insertOnly: true }, release.archive);
      await transport.refreshUrls(config, [release.archive.url]);
    }
    await transport.verifyEntriesWithRetry([release.archive], 20, 30_000, false);
    await transport.uploadEntry({ ...config, insertOnly: false }, feed);
    await transport.refreshUrls(config, [feed.url]);
    await transport.verifyEntriesWithRetry([feed], 20, 30_000, false);
    return { manifest, feed: { ...feed, filePath: undefined }, deferredGates: acceptanceReport.deferredGates || [] };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

async function main() {
  const args = qiniu.readArgs(process.argv.slice(2));
  for (const key of Object.keys(args)) if (!['dryRun', 'publish', 'release-dir', 'target', 'version', 'commit', 'report', 'acceptance'].includes(key)) throw Error('Unknown argument: ' + key);
  if (args.publish !== undefined && args.publish !== 'true') throw Error('Use --publish true only after release approval');
  const acceptance = args.acceptance || 'required';
  if (!['required', 'deferred'].includes(acceptance)) throw Error('Use --acceptance required or --acceptance deferred');
  const release = collectRelease(path.resolve(qiniu.required(args['release-dir'], 'release-dir')), args);
  console.log(JSON.stringify({ ...release, acceptance, publication: args.publish === 'true' && !args.dryRun ? 'requested' : 'dry-run; no upload or feed promotion' }, null, 2));
  if (args.publish !== 'true' || args.dryRun) return;
  const config = { accessKey: qiniu.required(process.env.KP_QINIU_ACCESS_KEY, 'KP_QINIU_ACCESS_KEY'),
    secretKey: qiniu.required(process.env.KP_QINIU_SECRET_KEY, 'KP_QINIU_SECRET_KEY'), bucket: 'haqi', uploadHost: 'https://up-z2.qiniup.com' };
  const result = await publishRelease(release, config, { reportFile: args.report, acceptance });
  if (result.deferredGates.length) console.log('Deferred gates (not executed for this publication): ' + result.deferredGates.join(', '));
  writeCdnSummary({ title: 'Rust MCP — CDN 归档与独立更新清单已验证', version: release.metadata.version, entries: [release.archive, result.feed] });
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { collectRelease, verifyAcceptance, publishRelease, main };
