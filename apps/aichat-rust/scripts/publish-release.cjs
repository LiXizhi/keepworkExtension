#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const qiniu = require('../../../scripts/lib/qiniu-release.cjs');
const { writeCdnSummary } = require('../../../scripts/lib/cdn-summary.cjs');

const START = '<!-- keepwork-cdn-downloads:start -->';
const END = '<!-- keepwork-cdn-downloads:end -->';
const INSTALLERS = [
  { label: 'Windows x64（EXE）', suffix: 'x64-setup.exe' },
  { label: 'Windows ARM64（EXE）', suffix: 'arm64-setup.exe' },
  { label: 'macOS Universal（DMG）', suffix: 'universal.dmg' },
];

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
      label, name, filePath, remoteKey,
      url: `https://cdn.keepwork.com/${remoteKey}`,
      size: stat.size, sha256: qiniu.sha256(filePath),
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

async function publishRelease(entries, config, { transport = qiniu, fetchImpl = fetch, github } = {}) {
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
  // Enforce immutability at storage as well as at the CDN: a cached 404 must
  // never permit overwriting an existing version with different installer bytes.
  for (const entry of missing) await transport.uploadEntry({ ...config, insertOnly: true }, entry);
  if (missing.length) await transport.refreshUrls(config, missing.map(entry => entry.url));
  // Verify the actual download URLs, including cached responses seen by users.
  await transport.verifyEntriesWithRetry(entries, 20, 30_000, false);
  const body = await github.readBody();
  await github.writeBody(updateReleaseBody(body, entries));
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
    if (!['dryRun', 'release-dir', 'version'].includes(key)) throw new Error(`Unknown argument: ${key}`);
  }
  const version = qiniu.normalizeVersion(args.version);
  const directory = path.resolve(qiniu.required(args['release-dir'], 'release-dir'));
  const entries = collectReleaseFiles(directory, version);
  if (args.dryRun) {
    console.log(updateReleaseBody('', entries));
    return;
  }
  const tag = `aichat-rust-v${version}`;
  if (process.env.GITHUB_REF_NAME && process.env.GITHUB_REF_NAME !== tag) throw new Error('Release tag does not match installer version');
  const repository = qiniu.required(process.env.GH_REPO || process.env.GITHUB_REPOSITORY, 'GH_REPO');
  const config = {
    accessKey: qiniu.required(process.env.KP_QINIU_ACCESS_KEY, 'KP_QINIU_ACCESS_KEY'),
    secretKey: qiniu.required(process.env.KP_QINIU_SECRET_KEY, 'KP_QINIU_SECRET_KEY'),
    bucket: 'haqi', uploadHost: 'https://up-z2.qiniup.com',
  };
  await publishRelease(entries, config, { github: githubRelease(tag, repository) });
  writeCdnSummary({ title: 'KeepWork 第二大脑 — CDN 下载已写入 GitHub Release', version, entries });
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { collectReleaseFiles, updateReleaseBody, publishRelease };
