const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { downloadArtifacts, githubEnvironment, directEnvironment, verifyReceipt, PROXY } =
  require('../.github/skills/rust-release/scripts/download-artifacts.cjs');
const { publishLocal } = require('../.github/skills/rust-release/scripts/publish-local.cjs');
const desktopPublisher = require('../apps/aichat-rust/scripts/publish-release.cjs');

const commit = 'a'.repeat(40);
const names = {
  desktop: ['aichat-rust-release-packages'],
  mcp: ['mcp-rust-validation-windows-x64', 'mcp-rust-validation-windows-arm64', 'mcp-rust-validation-macos-universal'],
};
const workflows = {
  desktop: '.github/workflows/aichat-rust-windows-release.yml',
  mcp: '.github/workflows/mcp-rust.yml',
};

function fixture(t, product = 'desktop', options = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-local-release-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const output = path.join(temporary, 'download');
  const calls = [];
  const env = {
    PATH: '/fixture/path', GH_TOKEN: 'fixture-authentication',
    HTTPS_PROXY: 'http://wrong-proxy:8000', http_proxy: 'http://wrong-proxy:9000',
    NO_PROXY: '*', no_proxy: 'github.com',
  };
  const exec = (file, args, settings) => {
    calls.push({ file, args, settings });
    assert.equal(file, 'gh');
    if (args[0] === 'api') {
      if (args.some(arg => String(arg).includes('/artifacts'))) {
        return JSON.stringify([{ artifacts: options.artifacts || names[product].map((name, index) => ({
          id: index + 1, name, expired: false, size_in_bytes: 123,
          ...options.artifact,
        })) }]);
      }
      return JSON.stringify({
        id: 123, path: workflows[product], status: 'completed', conclusion: 'success',
        head_sha: commit, event: 'workflow_dispatch', ...options.run,
      });
    }
    assert.deepEqual(args.slice(0, 3), ['run', 'download', '123']);
    const directory = args[args.indexOf('--dir') + 1];
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'fixture.txt'), `fixture bytes for ${args[args.indexOf('--name') + 1]}`);
    options.populate?.(directory, args[args.indexOf('--name') + 1]);
    if (options.downloadFailure) throw new Error('fixture proxy unavailable');
    return '';
  };
  return { output, calls, env, exec, request: { product, runId: '123', commit, output, repository: 'fixture/repository' } };
}

test('GitHub downloads override inherited bypasses and proxy settings without mutating the caller environment', () => {
  const original = { HTTPS_PROXY: 'http://inherited', no_proxy: '*', GH_TOKEN: 'fixture-secret', PATH: '/fixture/path',
    KP_QINIU_ACCESS_KEY: 'fixture-access', KP_QINIU_SECRET_KEY: 'fixture-secret' };
  const snapshot = { ...original };
  const github = githubEnvironment(original);
  assert.equal(PROXY, 'http://127.0.0.1:7890');
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    assert.equal(github[key], PROXY, key);
  }
  for (const key of ['NO_PROXY', 'no_proxy']) assert.ok(!github[key], key);
  assert.equal(github.KP_QINIU_ACCESS_KEY, undefined, 'Qiniu access keys do not enter the GitHub download process');
  assert.equal(github.KP_QINIU_SECRET_KEY, undefined);
  assert.equal(directEnvironment(original).KP_QINIU_SECRET_KEY, original.KP_QINIU_SECRET_KEY);
  const direct = directEnvironment(github);
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    assert.ok(!direct[key], `Qiniu publication must not inherit ${key}`);
  }
  assert.equal(direct.GH_TOKEN, original.GH_TOKEN);
  assert.equal(direct.PATH, original.PATH);
  assert.deepEqual(original, snapshot);
});

for (const product of ['desktop', 'mcp']) {
  test(`downloads only the ${product} artifacts from the successful fixed source run through the local proxy`, t => {
    const f = fixture(t, product);
    downloadArtifacts(f.request, f);
    const downloads = f.calls.filter(call => call.args[0] === 'run');
    assert.deepEqual(downloads.map(call => call.args[call.args.indexOf('--name') + 1]), names[product]);
    for (const { settings, args } of f.calls) {
      assert.equal(settings.env.HTTPS_PROXY, PROXY);
      assert.equal(settings.env.http_proxy, PROXY);
      assert.ok(!settings.env.NO_PROXY);
      assert.ok(!settings.env.no_proxy);
      assert.equal(settings.env.GH_TOKEN, 'fixture-authentication');
      assert.equal(args.some(arg => String(arg).includes('fixture-authentication')), false);
    }
    assert.ok(verifyReceipt(f.output, { product, commit }));
    for (const name of names[product]) assert.ok(fs.existsSync(path.join(f.output, name, 'fixture.txt')));
    fs.appendFileSync(path.join(f.output, names[product][0], 'fixture.txt'), 'tampered bytes');
    assert.throws(() => verifyReceipt(f.output, { product, commit }), /size|hash|checksum|bytes|SHA-256/i);
  });
}

for (const [label, run] of [
  ['a different source commit', { head_sha: 'b'.repeat(40) }],
  ['a different workflow', { path: '.github/workflows/untrusted.yml' }],
  ['a different workflow run ID', { id: 456 }],
  ['an unfinished run', { status: 'in_progress', conclusion: null }],
  ['a failed run', { conclusion: 'failure' }],
  ['a pull request build', { event: 'pull_request' }],
]) {
  test(`refuses ${label} before downloading or producing a usable receipt`, t => {
    const f = fixture(t, 'desktop', { run });
    assert.throws(() => downloadArtifacts(f.request, f));
    assert.equal(f.calls.some(call => call.args[0] === 'run'), false);
    assert.throws(() => verifyReceipt(f.output, { product: 'desktop', commit }));
  });
}

test('expired artifacts are rejected before any download starts', t => {
  const f = fixture(t, 'desktop', { artifact: { expired: true } });
  assert.throws(() => downloadArtifacts(f.request, f));
  assert.equal(f.calls.some(call => call.args[0] === 'run'), false);
});

for (const [label, artifacts] of [
  ['missing', []],
  ['duplicate', [{ name: names.desktop[0], expired: false }, { name: names.desktop[0], expired: false }]],
]) {
  test(`${label} named artifacts are rejected before any download starts`, t => {
    const f = fixture(t, 'desktop', { artifacts });
    assert.throws(() => downloadArtifacts(f.request, f));
    assert.equal(f.calls.some(call => call.args[0] === 'run'), false);
  });
}

test('a failed download cannot leave a receipt that authorizes a partial publication', t => {
  const f = fixture(t, 'mcp', { downloadFailure: true });
  assert.throws(() => downloadArtifacts(f.request, f), /proxy unavailable/);
  assert.throws(() => verifyReceipt(f.output, { product: 'mcp', commit }));
});

test('an existing output directory cannot silently mix old files into a new run', t => {
  const f = fixture(t);
  fs.mkdirSync(f.output);
  fs.writeFileSync(path.join(f.output, 'keep.txt'), 'existing download');
  assert.throws(() => downloadArtifacts(f.request, f));
  assert.equal(fs.readFileSync(path.join(f.output, 'keep.txt'), 'utf8'), 'existing download');
  assert.equal(f.calls.some(call => call.args[0] === 'run'), false);
});

test('receipt identities cannot be reused for another product or source commit', t => {
  const f = fixture(t);
  downloadArtifacts(f.request, f);
  assert.throws(() => verifyReceipt(f.output, { product: 'mcp', commit }));
  assert.throws(() => verifyReceipt(f.output, { product: 'desktop', commit: 'b'.repeat(40) }));
});

test('receipt verification rejects files added after download and symbolic links', t => {
  const f = fixture(t);
  downloadArtifacts(f.request, f);
  const extra = path.join(f.output, names.desktop[0], 'extra.exe');
  fs.writeFileSync(extra, 'unverified installer');
  assert.throws(() => verifyReceipt(f.output, { product: 'desktop', commit }));
  fs.unlinkSync(extra);
  if (process.platform === 'win32') return; // Symlink creation requires extra Windows privileges.
  fs.symlinkSync(path.join(f.output, names.desktop[0], 'fixture.txt'), extra);
  assert.throws(() => verifyReceipt(f.output, { product: 'desktop', commit }), /symbolic link/i);
});

const version = '1.2.3';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const credentials = { KP_QINIU_ACCESS_KEY: 'fixture-access', KP_QINIU_SECRET_KEY: 'fixture-secret' };

function desktopFixture(t, options = {}) {
  const f = fixture(t, 'desktop', {
    populate(directory) {
      for (const suffix of ['x64-setup.exe', 'arm64-setup.exe', 'universal.dmg']) {
        fs.writeFileSync(path.join(directory, `Keepwork_${version}_${suffix}`), `fixture ${suffix}`);
      }
      const entries = desktopPublisher.collectReleaseFiles(directory, version);
      const files = entries.map(entry => entry.name);
      for (const arch of ['x64', 'arm64']) {
        const name = `release-manifest-${version}-${arch}.json`;
        const installer = entries.find(entry => entry.name === `Keepwork_${version}_${arch}-setup.exe`);
        fs.writeFileSync(path.join(directory, name), JSON.stringify({
          desktopVersion: version, commit, platform: 'windows', arch, engine: 'rust',
          installer: { name: installer.name, size: installer.size, sha256: installer.sha256 },
          ...options.manifest,
        }));
        files.push(name);
      }
      const checksums = files.sort().map(name => `${digest(fs.readFileSync(path.join(directory, name)))}  ${name}`).join('\n');
      fs.writeFileSync(path.join(directory, `SHA256SUMS-${version}.txt`), checksums + '\n');
    },
  });
  downloadArtifacts(f.request, f);
  return { ...f, request: { product: 'desktop', artifacts: f.output, version, commit, tag: `v${version}` } };
}

test('local desktop publication defaults to a verified plan without credentials or GitHub mutations', async t => {
  const f = desktopFixture(t);
  const calls = [];
  const result = await publishLocal(f.request, { env: {}, exec: (...args) => calls.push(args) });
  assert.match(result.publication, /dry-run/);
  assert.deepEqual(calls, []);
});

test('missing local Qiniu credentials fail before creating a GitHub draft', async t => {
  const f = desktopFixture(t);
  const calls = [];
  await assert.rejects(publishLocal({ ...f.request, publish: true }, {
    env: {}, exec: (...args) => calls.push(args),
  }), /KP_QINIU/);
  assert.deepEqual(calls, []);
});

test('a Windows manifest from another source cannot be published even with valid file checksums', async t => {
  const f = desktopFixture(t, { manifest: { commit: 'b'.repeat(40) } });
  const calls = [];
  await assert.rejects(publishLocal({ ...f.request, publish: true }, {
    env: credentials, exec: (...args) => calls.push(args),
  }), /manifest identity/i);
  assert.deepEqual(calls, []);
});

test('failed desktop CDN verification leaves the draft unpublished and never replaces GitHub assets', async t => {
  const f = desktopFixture(t);
  const calls = [];
  const exec = (_file, args, settings) => {
    calls.push(args);
    assert.equal(settings.env.HTTPS_PROXY, PROXY);
    assert.equal(settings.env.KP_QINIU_ACCESS_KEY, undefined);
    assert.equal(settings.env.KP_QINIU_SECRET_KEY, undefined);
    if (args[0] === 'api') return commit;
    if (args[1] === 'view') throw Object.assign(new Error('Not Found'), { stderr: 'HTTP 404: Not Found' });
    assert.deepEqual(args.slice(0, 2), ['release', 'create']);
    return '';
  };
  await assert.rejects(publishLocal({ ...f.request, publish: true }, {
    env: { ...credentials, HTTPS_PROXY: PROXY }, exec,
    desktopPublisher: { ...desktopPublisher, async publishRelease() { throw Error('CDN checksum mismatch'); } },
  }), /CDN checksum mismatch/);
  assert.equal(calls.some(args => args[1] === 'create'), true);
  assert.equal(calls.some(args => args[1] === 'upload' || args.includes('--draft=false')), false);
});

test('successful local desktop publication verifies CDN before attachments, public state and Latest', async t => {
  for (const isDraft of [true, false]) await t.test(isDraft ? 'a new draft becomes Latest after verification' : 'an existing public release retains its Latest state', async t => {
    const f = desktopFixture(t);
    const events = [];
    const before = { ...process.env };
    const exec = (_file, args, settings) => {
      assert.equal(settings.env.HTTPS_PROXY, PROXY);
      assert.equal(settings.env.http_proxy, PROXY);
      assert.ok(!settings.env.NO_PROXY);
      assert.equal(settings.env.KP_QINIU_ACCESS_KEY, undefined);
      assert.equal(settings.env.KP_QINIU_SECRET_KEY, undefined);
      if (args[0] === 'api') return commit;
      if (args[1] === 'view') return JSON.stringify({ isDraft, body: 'existing notes' });
      if (args.includes('--draft=false')) assert.equal(args.includes('--latest'), isDraft,
        'retrying an already public release must not replace the latest newer release');
      events.push(args[1] === 'upload' ? 'assets' : args.includes('--draft=false') ? 'public' : 'notes');
      return '';
    };
    const result = await publishLocal({ ...f.request, publish: true }, {
      exec, env: { ...credentials, HTTPS_PROXY: PROXY, http_proxy: PROXY, NO_PROXY: '*' },
      desktopPublisher: {
        ...desktopPublisher,
        async publishRelease(_entries, config, { github }) {
          assert.equal(config.accessKey, credentials.KP_QINIU_ACCESS_KEY);
          assert.ok(!process.env.HTTPS_PROXY);
          assert.ok(!process.env.http_proxy);
          assert.equal(await github.readBody(), 'existing notes');
          events.push('CDN-verified');
          await github.writeBody('existing notes and verified CDN links');
          return [];
        },
      },
    });
    assert.deepEqual(events, ['CDN-verified', 'notes', 'assets', 'public']);
    assert.match(result.publication, /published/);
    assert.deepEqual({ ...process.env }, before, 'temporary direct publication settings are restored');
  });
});

function mcpFixture(t) {
  const f = fixture(t, 'mcp', {
    populate(directory, artifact) {
      const targets = artifact.endsWith('macos-universal') ? ['macos-arm64', 'macos-x64'] : [artifact.replace('mcp-rust-validation-', '')];
      fs.mkdirSync(path.join(directory, 'package'));
      for (const target of targets) {
        fs.writeFileSync(path.join(directory, 'package', `${target}.zip`), `fixture ${target}`);
        fs.writeFileSync(path.join(directory, `report-${target}.json`), '{}');
      }
    },
  });
  downloadArtifacts(f.request, f);
  const events = [];
  const publisher = {
    collectRelease(directory, identity) {
      events.push(`collect:${identity.target}`);
      const filePath = path.join(directory, `${identity.target}.zip`);
      return { target: identity.target, metadata: identity, archive: {
        filePath, name: `${identity.target}.zip`, remoteKey: `${identity.target}.zip`,
        url: `https://cdn.keepwork.com/fixture/${identity.target}.zip`, size: fs.statSync(filePath).size,
        sha256: digest(fs.readFileSync(filePath)),
      } };
    },
    async verifyAcceptance(reportFile, release, { acceptance }) {
      assert.equal(path.basename(reportFile), `report-${release.target}.json`);
      assert.equal(acceptance, 'deferred');
      events.push(`verify:${release.target}`);
    },
    async publishRelease(release, config, { acceptance }) {
      assert.equal(config.secretKey, credentials.KP_QINIU_SECRET_KEY);
      assert.equal(acceptance, 'deferred');
      events.push(`publish:${release.target}`);
      return { deferredGates: [], feed: { ...release.archive, name: `${release.target}.json` } };
    },
  };
  return { ...f, events, publisher,
    request: { product: 'mcp', artifacts: f.output, version, commit, acceptance: 'deferred', publish: true } };
}

test('all four MCP targets must pass acceptance before the first upload or feed promotion', async t => {
  const f = mcpFixture(t);
  const result = await publishLocal(f.request, { env: credentials, mcpPublisher: f.publisher });
  assert.match(result.publication, /published/);
  const targets = ['windows-x64', 'windows-arm64', 'macos-arm64', 'macos-x64'];
  const firstWrite = f.events.findIndex(event => event.startsWith('publish:'));
  for (const target of targets) assert.ok(f.events.indexOf(`verify:${target}`) < firstWrite);
  assert.deepEqual(f.events.filter(event => event.startsWith('publish:')), targets.map(target => `publish:${target}`));
});

test('a rejected final MCP target prevents every platform upload', async t => {
  const f = mcpFixture(t);
  const verify = f.publisher.verifyAcceptance;
  f.publisher.verifyAcceptance = async (...args) => {
    await verify(...args);
    if (args[1].target === 'macos-x64') throw Error('last platform evidence mismatch');
  };
  await assert.rejects(publishLocal(f.request, { env: credentials, mcpPublisher: f.publisher }), /last platform/);
  assert.equal(f.events.some(event => event.startsWith('publish:')), false);
});
