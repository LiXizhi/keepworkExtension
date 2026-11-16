const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveReleaseTag, releaseVersionFromTag } = require('../scripts/publish-release.cjs');

const version = '0.2.112';
const script = path.join(__dirname, '../scripts/publish-release.cjs');
const canonical = `v${version}`;
const legacy = `aichat-rust-v${version}`;

function cli(args, env = {}) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env });
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-release-tags-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const suffix of ['x64-setup.exe', 'arm64-setup.exe', 'universal.dmg']) {
    fs.writeFileSync(path.join(directory, `Keepwork_${version}_${suffix}`), `installer fixture: ${suffix}`);
  }
  return directory;
}

test('new desktop releases default to a standard v tag and preserve explicitly selected historical identities', () => {
  assert.equal(resolveReleaseTag(version), canonical);
  for (const tag of [canonical, legacy]) {
    assert.equal(resolveReleaseTag(version, tag), tag);
    assert.equal(releaseVersionFromTag(tag), version);
  }
});

test('tag resolution rejects other products, branch names, malformed versions, and a different installer version', () => {
  assert.equal(typeof resolveReleaseTag, 'function');
  assert.equal(typeof releaseVersionFromTag, 'function');
  for (const tag of ['main', 'keepwork-v0.2.112', 'mcp-rust-v0.2.112', 'V0.2.112',
    'refs/tags/v0.2.112', '0.2.112', 'v0.2', 'v00.2.112', 'v0.2.112-beta.1',
    'v0.2.112+build.1', 'v0.2.112/next', 'aichat-rust-v0.2.112/next',
    'v0.2.112\n', 'aichat-rust-v0.2.112\n']) {
    assert.throws(() => releaseVersionFromTag(tag), tag);
    assert.throws(() => resolveReleaseTag(version, tag), tag);
  }
  for (const tag of ['v0.2.111', 'aichat-rust-v0.2.111']) {
    assert.throws(() => resolveReleaseTag(version, tag), tag);
  }
  assert.throws(() => resolveReleaseTag('0.2.112-beta.1'));
});

test('CI can extract either tag version without installers, credentials, or GitHub tools', () => {
  for (const tag of [canonical, legacy]) {
    const result = cli(['--version-from-tag', tag]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${version}\n`);
  }
  const result = cli(['--version-from-tag', 'main']);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
});

test('version extraction refuses publication flags instead of silently ignoring them', () => {
  for (const extra of [['--dry-run'], ['--version', version], ['--tag', canonical], ['--release-dir', '.']]) {
    const result = cli(['--version-from-tag', canonical, ...extra]);
    assert.equal(result.status, 1, JSON.stringify(extra));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /--version-from-tag must be used alone/);
  }
});

test('canonical, legacy, and local default dry-runs retain the same installer and update-feed URLs', t => {
  const directory = fixture(t);
  const args = ['--release-dir', directory, '--version', version, '--dry-run'];
  const local = cli(args);
  assert.equal(local.status, 0, local.stderr);
  for (const tag of [canonical, legacy]) {
    const fromRef = cli(args, { GITHUB_REF_NAME: tag });
    assert.equal(fromRef.status, 0, fromRef.stderr);
    assert.equal(fromRef.stdout, local.stdout);
    const explicit = cli([...args, '--tag', tag]);
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.equal(explicit.stdout, local.stdout);
  }
  assert.match(local.stdout, /keepwork\/aichat-rust\/0\.2\.112\/Keepwork_0\.2\.112_x64-setup\.exe/);
  assert.equal((local.stdout.match(/latest-client\.json/g) || []).length, 3);
});

test('invalid or conflicting tag identities fail before planning uploads or creating update feeds', t => {
  const directory = fixture(t);
  const files = fs.readdirSync(directory);
  const args = ['--release-dir', directory, '--version', version];
  for (const dry of [[], ['--dry-run']]) {
    for (const [extra, env] of [
      [[], { GITHUB_REF_NAME: 'v0.2.111' }],
      [['--tag', 'aichat-rust-v0.2.111'], {}],
      [['--tag', canonical], { GITHUB_REF_NAME: legacy }],
      [['--tag', legacy], { GITHUB_REF_NAME: canonical }],
      [[], { GITHUB_REF_NAME: 'main' }],
    ]) {
      const result = cli([...args, ...extra, ...dry], env);
      assert.equal(result.status, 1, JSON.stringify({ extra, env, dry }));
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /tag/i);
      assert.doesNotMatch(result.stderr, /GH_REPO|KP_QINIU|ENOENT|fetch failed/);
      assert.deepEqual(fs.readdirSync(directory), files);
    }
  }
});

test('the local publisher creates standard-tag drafts and only reuses existing historical releases', () => {
  const { ensureDesktopRelease } = require('../../../.github/skills/rust-release/scripts/publish-local.cjs');
  for (const tag of [canonical, legacy]) {
    for (const exists of [false, true]) {
      const calls = [];
      const exec = (file, args) => {
        assert.equal(file, 'gh');
        calls.push(args);
        if (args[0] === 'api') return 'c'.repeat(40) + '\n';
        if (args[0] === 'release' && args[1] === 'view') {
          if (exists) return JSON.stringify({ isDraft: false });
          throw Object.assign(new Error('HTTP 404: Not Found'), { status: 1, stderr: 'HTTP 404: Not Found' });
        }
        assert.deepEqual(args.slice(0, 2), ['release', 'create']);
        return '';
      };
      const run = () => ensureDesktopRelease({ tag, version, repository: 'fixture/repository', commit: 'c'.repeat(40) }, { exec, env: {} });
      if (tag === legacy && !exists) {
        assert.throws(run, /Historical tags may only rerun an existing GitHub release/);
      } else {
        run();
      }
      const creations = calls.filter(args => args[0] === 'release' && args[1] === 'create');
      assert.equal(creations.length, !exists && tag === canonical ? 1 : 0);
      if (creations.length) {
        assert.ok(creations[0].includes('--verify-tag'));
        assert.ok(creations[0].includes('--draft'));
        assert.ok(creations[0].includes(tag));
        assert.ok(creations[0].includes('fixture/repository'));
      }
    }
  }
});

test('authentication and GitHub outages cannot be mistaken for a missing desktop release', () => {
  const { ensureDesktopRelease } = require('../../../.github/skills/rust-release/scripts/publish-local.cjs');
  for (const status of [401, 403, 500]) {
    const calls = [];
    const exec = (_file, args) => {
      calls.push(args);
      if (args[0] === 'api') return 'c'.repeat(40) + '\n';
      throw Object.assign(new Error(`HTTP ${status}`), { status: 1, stderr: `HTTP ${status}` });
    };
    assert.throws(() => ensureDesktopRelease({ tag: canonical, version, repository: 'fixture/repository', commit: 'c'.repeat(40) }, { exec, env: {} }));
    assert.equal(calls.some(args => args[1] === 'create'), false);
  }
});

test('a tag pointing at another commit never creates or edits a GitHub release', () => {
  const { ensureDesktopRelease } = require('../../../.github/skills/rust-release/scripts/publish-local.cjs');
  const calls = [];
  const exec = (_file, args) => { calls.push(args); return 'b'.repeat(40); };
  assert.throws(() => ensureDesktopRelease({ tag: canonical, version, repository: 'fixture/repository', commit: 'c'.repeat(40) }, { exec, env: {} }), /source commit/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'api');
});
