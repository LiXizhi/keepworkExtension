#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const qiniu = require('../../../scripts/lib/qiniu-release.cjs');
const { writeCdnSummary } = require('../../../scripts/lib/cdn-summary.cjs');
const { validateDesktopManifest, validateDesktopVersionStatus } = require('../../../scripts/lib/update-manifest.cjs');

const START = '<!-- keepwork-cdn-downloads:start -->';
const END = '<!-- keepwork-cdn-downloads:end -->';
const INSTALLERS = [
  { label: 'Windows x64（EXE）', suffix: 'x64-setup.exe' },
  { label: 'Windows ARM64（EXE）', suffix: 'arm64-setup.exe' },
  { label: 'macOS Universal（DMG）', suffix: 'universal.dmg' },
];
const UPDATE_TARGETS = ['win32-x64', 'win32-arm64', 'darwin-universal'];
const updateKey = target => `keepwork/aichat-rust/${target}/latest-client.json`;
const cdnUrl = key => `https://cdn.keepwork.com/${key}`;

function releaseVersionFromTag(tag) {
  const match = typeof tag === 'string' && /^(?:aichat-rust-)?v([0-9]+\.[0-9]+\.[0-9]+)$/.exec(tag);
  if (!match || match[0] !== tag) throw new Error('Release tag must be vX.Y.Z or historical aichat-rust-vX.Y.Z');
  return qiniu.normalizeVersion(match[1]);
}

function resolveReleaseTag(version, refName) {
  const normalized = qiniu.normalizeVersion(version);
  const tag = refName === undefined ? `v${normalized}` : refName;
  if (releaseVersionFromTag(tag) !== normalized) throw new Error('Release tag does not match installer version');
  return tag;
}

function collectReleaseFiles(directory, version) {
  qiniu.normalizeVersion(version);
  const names = INSTALLERS.map(({ suffix }) => `Keepwork_${version}_${suffix}`);
  const unexpected = fs.readdirSync(directory).filter(name => /\.(exe|dmg)$/i.test(name) && !names.includes(name));
  if (unexpected.length) throw new Error(`Unexpected release installers: ${unexpected.join(', ')}`);
  return INSTALLERS.map(({ label }, index) => {
    const name = names[index];
    const filePath = path.resolve(directory, name);
    const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size <= 0) throw new Error(`Required non-empty release installer is missing: ${name}`);
    const remoteKey = `keepwork/aichat-rust/${version}/${name}`;
    return {
      label, name, filePath, remoteKey, version,
      url: `https://cdn.keepwork.com/${remoteKey}`,
      size: stat.size, sha256: qiniu.sha256(filePath),
    };
  });
}

function compareVersions(a, b) {
  const left = qiniu.normalizeVersion(a).split('.').map(Number);
  const right = qiniu.normalizeVersion(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}

function collectUpdateFeeds(entries, version, publishedAt, previousByTarget = {}, feedDirectory) {
  qiniu.normalizeVersion(version);
  return UPDATE_TARGETS.map(target => {
    const windows = target.startsWith('win32-');
    const suffix = windows ? `${target.slice(6)}-setup.exe` : 'universal.dmg';
    const pkg = entries.find(entry => entry.name === `Keepwork_${version}_${suffix}`);
    if (!pkg) throw new Error(`Missing update installer for ${target}`);
    const previous = previousByTarget[target];
    if (Object.hasOwn(previousByTarget, target) && (!previous || typeof previous !== 'object' || Array.isArray(previous)
      || (previous.product && previous.product !== 'aichat-desktop'))) {
      throw new Error(`Invalid existing desktop update feed: ${target}`);
    }
    const versionStatus = previous && (previous.kind === 'version-status'
      || previous.releaseStatus === 'version-only' || previous.installable === false);
    if (previous) {
      if (versionStatus) validateDesktopVersionStatus(previous, { target });
      else validateDesktopManifest(previous, { target, legacy: true });
    }
    // A status record describes a source version, not this new package. Do not
    // carry its commit, timestamp, description or non-installable markers forward.
    const inherited = versionStatus ? {} : previous;
    const legacyZip = previous?.format === 'zip' || /\.zip(?:[?#]|$)/i.test(previous?.url || '');
    const oldInstaller = previous?.installer || (legacyZip || versionStatus ? undefined : previous);
    const oldVersion = oldInstaller?.version || previous?.version;
    if ((oldInstaller || versionStatus) && oldVersion) {
      const comparison = compareVersions(oldVersion, version);
      if (comparison > 0) throw new Error(`Refusing desktop update downgrade: ${target}`);
      if (comparison === 0 && oldInstaller && (oldInstaller.url !== pkg.url || oldInstaller.size !== pkg.size
        || oldInstaller.sha256?.toLowerCase() !== pkg.sha256)) {
        throw new Error(`Same desktop version has a different installer: ${target}`);
      }
    }
    const installer = {
      version, publishedAt: oldVersion === version ? (oldInstaller?.publishedAt || publishedAt) : publishedAt,
      format: windows ? 'exe' : 'dmg', fileName: pkg.name,
      url: pkg.url, size: pkg.size, sha256: pkg.sha256,
    };
    // Historical download consumers still require the top-level ZIP. Native
    // clients use the additive installer, including its independent version.
    const manifest = legacyZip ? {
      schemaVersion: 1, product: 'aichat-desktop', platform: windows ? 'windows' : 'macos', arch: target.split('-')[1],
      ...inherited, installer,
    } : {
      ...inherited, schemaVersion: 1, product: 'aichat-desktop',
      platform: windows ? 'windows' : 'macos', arch: target.split('-')[1],
      ...installer, installer,
    };
    validateDesktopManifest(manifest, { target });
    const filePath = path.join(feedDirectory ?? path.join(path.dirname(entries[0].filePath), 'update-feeds'), target, 'latest-client.json');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(manifest, null, 2)}\n`);
    const remoteKey = updateKey(target);
    return {
      name: `${target}/latest-client.json`, filePath, remoteKey, url: cdnUrl(remoteKey),
      size: fs.statSync(filePath).size, sha256: qiniu.sha256(filePath),
      mimeType: 'application/json', cacheControl: 'public, max-age=60, must-revalidate',
    };
  });
}

function updateReleaseBody(body, entries) {
  body ??= '';
  const block = [
    START, '### CDN 下载', '',
    '| 平台 | CDN 下载地址 |', '| --- | --- |',
    ...entries.map(entry => `| ${entry.label} | [${entry.url}](${entry.url}) |`),
    '', END,
  ].join('\n');
  const start = body.indexOf(START);
  const end = body.indexOf(END);
  if (start === -1 && end === -1) return `${block}\n\n${body}`;
  if (start === -1 || end < start || body.indexOf(START, start + START.length) !== -1
    || body.indexOf(END, end + END.length) !== -1) {
    throw new Error('Malformed or duplicate CDN download markers in release notes');
  }
  return body.slice(0, start) + block + body.slice(end + END.length);
}

async function publishRelease(entries, config, {
  transport = qiniu, fetchImpl = fetch, github, publishedAt = new Date().toISOString(), feedDirectory,
} = {}) {
  const missing = [];
  // Check every versioned object before making the first CDN change. A retry
  // may reuse identical objects, but cannot replace this version with new bytes.
  for (const entry of entries) {
    const response = await fetchImpl(`${entry.url}?kp_release_preflight=${Date.now()}`, {
      headers: { 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(10 * 60_000),
    });
    if (response.status === 404) {
      await response.body?.cancel();
      missing.push(entry);
    } else if (response.ok) {
      const data = Buffer.from(await response.arrayBuffer());
      const digest = crypto.createHash('sha256').update(data).digest('hex');
      if (data.length !== entry.size || digest !== entry.sha256) {
        throw new Error(`Immutable CDN installer differs: ${entry.name}; reuse the original artifacts or release a new version`);
      }
    } else {
      await response.body?.cancel();
      throw new Error(`CDN preflight HTTP ${response.status} for ${entry.name}`);
    }
  }
  const previousByTarget = {};
  for (const target of UPDATE_TARGETS) {
    const response = await fetchImpl(`${cdnUrl(updateKey(target))}?kp_update_preflight=${Date.now()}`, {
      headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(30_000),
    });
    if (response.ok) previousByTarget[target] = await response.json();
    else {
      await response.body?.cancel();
      if (response.status !== 404) throw new Error(`Desktop feed preflight HTTP ${response.status}: ${target}`);
    }
  }
  const feeds = collectUpdateFeeds(entries, entries[0].version, publishedAt, previousByTarget, feedDirectory);
  // Enforce immutability at storage as well as at the CDN: a cached 404 must
  // never permit overwriting an existing version with different installer bytes.
  for (const entry of missing) await transport.uploadEntry({ ...config, insertOnly: true }, entry);
  if (missing.length) await transport.refreshUrls(config, missing.map(entry => entry.url));
  // Verify the actual download URLs, including cached responses seen by users.
  await transport.verifyEntriesWithRetry(entries, 20, 30_000, false);
  // Promote discovery only after every referenced installer is verified.
  const feedConfig = { ...config, insertOnly: false };
  for (const feed of feeds) await transport.uploadEntry(feedConfig, feed);
  await transport.refreshUrls(config, feeds.map(feed => feed.url));
  await transport.verifyEntriesWithRetry(feeds, 20, 30_000, false);
  const body = await github.readBody();
  await github.writeBody(updateReleaseBody(body, entries));
  return feeds;
}

function githubRelease(tag, repository) {
  return {
    async readBody() {
      const json = execFileSync('gh', ['release', 'view', tag, '--repo', repository, '--json', 'body'], { encoding: 'utf8' });
      return JSON.parse(json).body;
    },
    async writeBody(body) {
      const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-release-notes-'));
      try {
        const notesFile = path.join(temporary, 'notes.md');
        fs.writeFileSync(notesFile, body);
        execFileSync('gh', ['release', 'edit', tag, '--repo', repository, '--notes-file', notesFile], { stdio: 'inherit' });
      } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
      }
    },
  };
}

async function main() {
  const args = qiniu.readArgs(process.argv.slice(2));
  for (const key of Object.keys(args)) {
    if (!['dryRun', 'release-dir', 'version', 'tag', 'version-from-tag'].includes(key)) throw new Error(`Unknown argument: ${key}`);
  }
  if (Object.hasOwn(args, 'version-from-tag')) {
    if (args.dryRun || Object.keys(args).some(key => !['dryRun', 'version-from-tag'].includes(key))) {
      throw new Error('--version-from-tag must be used alone');
    }
    console.log(releaseVersionFromTag(args['version-from-tag']));
    return;
  }
  const version = qiniu.normalizeVersion(args.version);
  if (args.tag !== undefined && process.env.GITHUB_REF_NAME !== undefined && args.tag !== process.env.GITHUB_REF_NAME) {
    throw new Error('Release tag does not match GITHUB_REF_NAME');
  }
  const tag = resolveReleaseTag(version, args.tag ?? process.env.GITHUB_REF_NAME);
  const directory = path.resolve(qiniu.required(args['release-dir'], 'release-dir'));
  const entries = collectReleaseFiles(directory, version);
  if (args.dryRun) {
    console.log(updateReleaseBody('', entries));
    console.log(collectUpdateFeeds(entries, version, new Date().toISOString()).map(feed => feed.url).join('\n'));
    return;
  }
  const repository = qiniu.required(process.env.GH_REPO || process.env.GITHUB_REPOSITORY, 'GH_REPO');
  const config = {
    accessKey: qiniu.required(process.env.KP_QINIU_ACCESS_KEY, 'KP_QINIU_ACCESS_KEY'),
    secretKey: qiniu.required(process.env.KP_QINIU_SECRET_KEY, 'KP_QINIU_SECRET_KEY'),
    bucket: 'haqi', uploadHost: 'https://up-z2.qiniup.com',
  };
  const feeds = await publishRelease(entries, config, { github: githubRelease(tag, repository) });
  writeCdnSummary({ title: 'KeepWork 第二大脑 — CDN 下载与自动更新清单已发布', version, entries: [...entries, ...feeds] });
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { releaseVersionFromTag, resolveReleaseTag, collectReleaseFiles, collectUpdateFeeds, updateReleaseBody, publishRelease };
