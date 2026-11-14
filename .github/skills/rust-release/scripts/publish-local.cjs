#!/usr/bin/env node
// Reuse the product publishers on downloaded CI bytes; never rebuild/repack.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ARTIFACTS, verifyReceipt, directEnvironment, githubEnvironment, readArgs, sha256 } = require('./download-artifacts.cjs');
const qiniu = require('../../../../scripts/lib/qiniu-release.cjs');
const desktop = require('../../../../apps/aichat-rust/scripts/publish-release.cjs');
const mcp = require('../../../../apps/mcp-rust/scripts/publish-runtime.cjs');
const { writeCdnSummary } = require('../../../../scripts/lib/cdn-summary.cjs');

function githubCommand(exec, env, args) {
  return exec('gh', args, { encoding: 'utf8', env: githubEnvironment(env), stdio: ['ignore', 'pipe', 'pipe'] });
}

function ensureDesktopRelease({ tag, version, repository, commit }, { exec = execFileSync, env = process.env } = {}) {
  tag = desktop.resolveReleaseTag(version, tag);
  const gh = args => githubCommand(exec, env, args);
  // Resolve annotated as well as lightweight tags, without trusting targetCommitish.
  const actualCommit = gh(['api', `repos/${repository}/commits/${encodeURIComponent(tag)}`, '--jq', '.sha']).trim();
  if (actualCommit !== commit) throw Error('GitHub release tag does not match the downloaded source commit');
  try {
    return JSON.parse(gh(['release', 'view', tag, '--repo', repository, '--json', 'isDraft,body']));
  } catch (error) {
    // Authentication, outages and other unknown outcomes must never authorize creation.
    if (!/HTTP 404|release not found/i.test(String(error.stderr || ''))) throw error;
    if (tag.startsWith('aichat-rust-v')) throw Error('Historical tags may only rerun an existing GitHub release.');
    gh(['release', 'create', tag, '--repo', repository, '--verify-tag', '--draft',
      '--title', `KeepWork 第二大脑 ${version}（Windows / macOS）`, '--generate-notes']);
    return { isDraft: true };
  }
}

function desktopBundle(directory, version, commit, publisher) {
  const entries = publisher.collectReleaseFiles(directory, version);
  const manifests = ['x64', 'arm64'].map(arch => {
    const name = `release-manifest-${version}-${arch}.json`;
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
    const installer = entries.find(entry => entry.name === `Keepwork_${version}_${arch}-setup.exe`);
    if (manifest.desktopVersion !== version || manifest.commit !== commit || manifest.platform !== 'windows'
      || manifest.arch !== arch || manifest.engine !== 'rust' || manifest.installer?.name !== installer?.name
      || manifest.installer?.size !== installer?.size || manifest.installer?.sha256 !== installer?.sha256) {
      throw Error('Windows release manifest identity/installer mismatch: ' + name);
    }
    return name;
  });
  const sums = `SHA256SUMS-${version}.txt`;
  const expected = [...entries.map(entry => entry.name), ...manifests].sort();
  const seen = [];
  for (const line of fs.readFileSync(path.join(directory, sums), 'utf8').trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64}) [ *]([^/\\]+)$/.exec(line);
    if (!match || !expected.includes(match[2]) || sha256(path.join(directory, match[2])) !== match[1]) {
      throw Error('CI release checksums do not match downloaded files');
    }
    seen.push(match[2]);
  }
  if (JSON.stringify(seen.sort()) !== JSON.stringify(expected)) throw Error('CI release checksums are incomplete or duplicated');
  return { entries, assets: [...expected, sums].map(name => path.join(directory, name)) };
}

async function publishLocal({ product, artifacts, version, commit, tag, acceptance = 'required', publish = false }, {
  exec = execFileSync, env = process.env, desktopPublisher = desktop, mcpPublisher = mcp,
} = {}) {
  if (env.GITHUB_ACTIONS === 'true') throw Error('Run this publisher on the local device, outside GitHub Actions');
  qiniu.normalizeVersion(version);
  if (!artifacts) throw Error('Require --artifacts from a completed local download');
  if (typeof publish !== 'boolean') throw Error('Publish must be explicitly true or false');
  if (!['required', 'deferred'].includes(acceptance)) throw Error('Use --acceptance required or deferred');
  const directory = path.resolve(artifacts);
  const receipt = verifyReceipt(directory, { product, commit });
  const directEnv = directEnvironment(env);
  let plan;
  if (product === 'desktop') {
    tag = desktop.resolveReleaseTag(version, tag);
    plan = desktopBundle(path.join(directory, ARTIFACTS.desktop[0]), version, commit, desktopPublisher);
  } else {
    if (tag !== undefined) throw Error('MCP publication does not use a desktop release tag');
    const targets = ['windows-x64', 'windows-arm64', 'macos-arm64', 'macos-x64'];
    plan = [];
    // Verify every target and its original portable report before the first mutation.
    for (const target of targets) {
      const artifact = `mcp-rust-validation-${target.startsWith('macos-') ? 'macos-universal' : target}`;
      const root = path.join(directory, artifact);
      const release = mcpPublisher.collectRelease(path.join(root, 'package'), { target, version, commit });
      const specificReport = path.join(root, `report-${target}.json`);
      const reportFile = fs.existsSync(specificReport) ? specificReport : path.join(root, 'report.json');
      await mcpPublisher.verifyAcceptance(reportFile, release, { acceptance });
      plan.push({ release, reportFile });
    }
  }
  if (!publish) return { product, version, commit, runId: receipt.runId, publication: 'dry-run; no upload or feed promotion' };
  const config = {
    accessKey: qiniu.required(env.KP_QINIU_ACCESS_KEY, 'KP_QINIU_ACCESS_KEY'),
    secretKey: qiniu.required(env.KP_QINIU_SECRET_KEY, 'KP_QINIU_SECRET_KEY'),
    bucket: 'haqi', uploadHost: 'https://up-z2.qiniup.com',
  };
  // CI concurrency no longer protects publication; serialize local invocations too.
  const lock = path.join(os.tmpdir(), `keepwork-rust-${product}-publish.lock`);
  try { fs.mkdirSync(lock); } catch (error) {
    if (error.code === 'EEXIST') throw Error('Another local publisher holds ' + lock + '; inspect it before retrying');
    throw error;
  }
  const savedEnv = { ...process.env };
  try {
    // Qiniu's in-process node:https/fetch requests remain direct. Only the gh
    // subprocesses get the local proxy, including the final Release attachments.
    for (const key of Object.keys(process.env)) if (!(key in directEnv)) delete process.env[key];
    Object.assign(process.env, directEnv);
    const gh = args => githubCommand(exec, directEnv, args);
    if (product === 'desktop') {
      const release = ensureDesktopRelease({ tag, version, repository: receipt.repository, commit }, { exec, env: directEnv });
      const github = {
        async readBody() { return JSON.parse(gh(['release', 'view', tag, '--repo', receipt.repository, '--json', 'body'])).body; },
        async writeBody(body) {
          const notes = path.join(lock, 'notes.md');
          fs.writeFileSync(notes, body);
          gh(['release', 'edit', tag, '--repo', receipt.repository, '--notes-file', notes]);
        },
      };
      const feeds = await desktopPublisher.publishRelease(plan.entries, config, { github });
      // Preserve the old ordering: verified CDN bytes precede any attachment replacement.
      gh(['release', 'upload', tag, '--repo', receipt.repository, ...plan.assets, '--clobber']);
      // A retry of an older public release must not steal Latest from a newer one.
      gh(['release', 'edit', tag, '--repo', receipt.repository, '--draft=false', ...(release.isDraft ? ['--latest'] : [])]);
      writeCdnSummary({ title: 'KeepWork 第二大脑 — 本地 CDN 发布已验证', version, entries: [...plan.entries, ...feeds] });
    } else {
      for (const { release, reportFile } of plan) {
        const result = await mcpPublisher.publishRelease(release, config, { reportFile, acceptance });
        if (result.deferredGates.length) console.log(`${release.target} deferred gates: ${result.deferredGates.join(', ')}`);
        writeCdnSummary({ title: `Rust MCP ${release.target} — 本地 CDN 发布已验证`, version, entries: [release.archive, result.feed] });
      }
    }
    return { product, version, commit, runId: receipt.runId, publication: 'published and CDN verified' };
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

if (require.main === module) {
  (async () => {
    const args = readArgs(process.argv.slice(2), ['product', 'artifacts', 'version', 'commit', 'tag', 'acceptance', 'publish']);
    if (args.publish !== undefined && args.publish !== 'true') throw Error('Use --publish true only for actual local publication');
    const result = await publishLocal({ ...args, publish: args.publish === 'true' });
    console.log(JSON.stringify(result, null, 2));
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { publishLocal, ensureDesktopRelease, desktopBundle };
