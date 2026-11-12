const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { writeCdnSummary } = require('./lib/cdn-summary.cjs');
const qiniu = require('./lib/qiniu-release.cjs');

const repo = path.resolve(__dirname, '..');
const commit = 'a'.repeat(40);
const targets = ['windows-x64', 'macos-arm64', 'macos-x64'];
const example = {
  name: 'windows-x64.zip', url: 'https://cdn.keepwork.com/custom/windows-x64.zip',
  size: 1234, sha256: 'b'.repeat(64), filePath: '/private/build/secret', remoteKey: 'private-key',
};

function temporaryDirectory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdn-summary-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function summaryFile(t) {
  const previous = process.env.GITHUB_STEP_SUMMARY;
  t.after(() => {
    if (previous === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = previous;
  });
  const file = path.join(temporaryDirectory(t), 'summary.md');
  process.env.GITHUB_STEP_SUMMARY = file;
  return file;
}

test('appends clickable, complete CDN links and provenance without local paths or other entry fields', t => {
  const file = summaryFile(t);
  fs.writeFileSync(file, 'Existing build summary\n');
  assert.equal(writeCdnSummary({ title: 'MCP NodeRuntime', version: '1.2.3', entries: [example], note: 'Fixed URLs may be overwritten.' }), true);
  const first = fs.readFileSync(file, 'utf8');
  assert.ok(first.startsWith('Existing build summary\n'));
  for (const value of ['MCP NodeRuntime', '1.2.3', example.name, example.url, '1234', example.sha256, 'Fixed URLs']) assert.ok(first.includes(value), value);
  assert.match(first, /\]\(<https:\/\/cdn\.keepwork\.com\/custom\/windows-x64\.zip>\)/);
  assert.ok(!first.includes(example.filePath));
  assert.ok(!first.includes(example.remoteKey));
  writeCdnSummary({ title: 'Stable channel', version: '1.2.3', entries: [example] });
  assert.ok(fs.readFileSync(file, 'utf8').startsWith(first));
});

test('without Actions summary environment, recording is a no-op', t => {
  summaryFile(t);
  delete process.env.GITHUB_STEP_SUMMARY;
  assert.equal(writeCdnSummary({ title: 'Local publication', entries: [example] }), false);
});

test('summary write errors do not turn a successful publication into a failed release', t => {
  summaryFile(t);
  process.env.GITHUB_STEP_SUMMARY = path.join(temporaryDirectory(t), 'missing', 'summary.md');
  const warnings = [];
  t.mock.method(process.stderr, 'write', value => { warnings.push(value); return true; });
  assert.equal(writeCdnSummary({ title: 'Already published', entries: [example] }), false);
  assert.ok(warnings.length > 0);
});

test('untrusted Markdown characters and line breaks cannot create extra summary table rows', t => {
  const file = summaryFile(t);
  writeCdnSummary({
    title: 'MCP\n# fake title', version: '1.2.3\n# fake version', note: 'Skipped\n# fake note',
    entries: [{ ...example, name: 'windows|[x64]\n# fake file.zip', url: 'https://cdn.keepwork.com/file (x)|<a>.zip' }],
  });
  const text = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(text, /^# fake /m);
  assert.ok(!text.includes('windows|[x64]'));
  assert.match(text, /https:\/\/cdn\.keepwork\.com\/file%20\(x\)%7[Cc]%3[Cc]a%3[Ee]\.zip/);
});

test('skipped publications show an explanation without suggesting CDN files were published', t => {
  const file = summaryFile(t);
  writeCdnSummary({ title: 'MCP publication skipped', version: '1.2.3', note: 'Superseded by a newer main commit.' });
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /skipped/);
  assert.match(text, /Superseded/);
  assert.doesNotMatch(text, /https:\/\//);
  assert.doesNotMatch(text, /\|\s*SHA-256/);
});

// Execute the real CLI main with isolated files and fake transports. No network,
// Git remotes, CDN uploads or global module-cache changes are needed.
function loadMain(relative, args, { overrides = {}, summaries = [], events = [], env = {}, fetch = async () => new Response('', { status: 404 }) } = {}) {
  const file = path.join(repo, relative);
  const localRequire = createRequire(file);
  const sandbox = {
    module: { exports: {} }, __dirname: path.dirname(file), __filename: file, Buffer, URL, fetch,
    console: { log() {}, error() {} },
    process: { argv: [process.execPath, file, ...args], env: { KP_QINIU_ACCESS_KEY: 'fixture-access', KP_QINIU_SECRET_KEY: 'fixture-secret', ...env }, stdout: { write() {} }, stderr: { write() {} } },
    require(request) {
      if (request.endsWith('/cdn-summary.cjs')) return { writeCdnSummary(value) { events.push('summary'); summaries.push(value); } };
      if (Object.hasOwn(overrides, request)) return overrides[request];
      return localRequire(request);
    },
  };
  vm.runInNewContext(`${fs.readFileSync(file, 'utf8')}\nmodule.exports.__main = main;`, sandbox, { filename: file });
  return sandbox.module.exports.__main;
}

function runtimeFixture(t, { stable = false } = {}) {
  const dir = temporaryDirectory(t);
  const version = stable ? require('../apps/mcp-runtime/package.json').version : '1.2.3';
  const prefix = stable ? `keepwork/mcp-stable/${version}/` : 'custom/runtime/';
  for (const target of targets) {
    const [platform, arch] = target.split('-');
    const archive = path.join(dir, `${target}.zip`);
    fs.writeFileSync(archive, `fixture:${target}`);
    fs.writeFileSync(path.join(dir, `${target}.json`), JSON.stringify({
      schemaVersion: 1, product: 'keepwork-mcp-node-runtime', version, commit, platform, arch,
      fileName: `${target}.zip`, url: `https://cdn.keepwork.com/${prefix}${target}.zip`,
      size: fs.statSync(archive).size, sha256: qiniu.sha256(archive), nodeVersion: '22.23.2', builtAt: '2026-11-12T00:00:00.000Z',
    }));
  }
  return { dir, version, prefix };
}

test('runtime CLI reports only verified releases and explicitly explains superseded builds', async t => {
  const { dir, version, prefix } = runtimeFixture(t);
  const args = ['--release-dir', dir, '--version', version, '--commit', commit, '--prefix', prefix, '--domain', 'https://cdn.keepwork.com', '--bucket', 'haqi', '--upload-host', 'https://up-z2.qiniup.com'];
  for (const mode of ['success', 'dry-run', 'superseded', 'verify-failed']) {
    const summaries = [], events = [];
    const main = loadMain('apps/mcp-runtime/scripts/release.cjs', [...args, ...(mode === 'dry-run' ? ['--dry-run'] : [])], {
      summaries, events, overrides: {
        'node:child_process': { execFileSync: () => `${mode === 'superseded' ? 'c'.repeat(40) : commit}\trefs/heads/main\n` },
        '../../../scripts/lib/qiniu-release.cjs': { ...qiniu,
          uploadEntry: async () => events.push('upload'), refreshUrls: async () => events.push('refresh'),
          verifyEntriesWithRetry: async () => { events.push('verify'); if (mode === 'verify-failed') throw Error('CDN mismatch'); },
        },
      },
    });
    if (mode === 'verify-failed') { await assert.rejects(main, /CDN mismatch/); assert.equal(summaries.length, 0); }
    else {
      await main();
      if (mode === 'dry-run') assert.deepEqual(events, []);
      else if (mode === 'superseded') { assert.equal(summaries.length, 1); assert.equal(summaries[0].entries?.length || 0, 0); assert.deepEqual(events, ['summary']); }
      else {
        assert.equal(summaries.length, 1);
        assert.equal(summaries[0].entries.length, 6);
        assert.ok(summaries[0].entries.every(entry => entry.url.startsWith(`https://cdn.keepwork.com/${prefix}`)));
        assert.deepEqual(events.slice(-2), ['verify', 'summary']);
      }
    }
  }
});

test('stable CLI records immutable artifact upload and channel promotion as separate successful stages', async t => {
  const { dir } = runtimeFixture(t, { stable: true });
  for (const mode of ['artifacts', 'promote']) {
    const summaries = [], events = [];
    const main = loadMain('scripts/stable-release.cjs', ['--mode', mode, '--dir', dir, '--commit', commit], {
      summaries, events, overrides: {
        './lib/qiniu-release.cjs': { ...qiniu, uploadEntry: async () => events.push('upload'), refreshUrls: async () => events.push('refresh'), verifyEntriesWithRetry: async () => events.push('verify') },
      },
    });
    await main();
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].entries.length, mode === 'artifacts' ? 6 : 3);
    assert.deepEqual(events.slice(-2), ['verify', 'summary']);
    assert.ok(summaries[0].entries.every(entry => entry.url.includes('/keepwork/mcp-stable/')));
  }
});

test('Local Helper CLI summarizes actual upload URLs after verification and does not report dry-runs or failures', async t => {
  const dir = temporaryDirectory(t), version = '1.2.3', name = `KP-Local-Helper-Setup-${version}-x64.exe`;
  fs.writeFileSync(path.join(dir, name), 'installer fixture');
  fs.writeFileSync(path.join(dir, `${name}.blockmap`), 'blockmap fixture');
  fs.writeFileSync(path.join(dir, 'latest.yml'), `version: ${version}\npath: ${name}\n`);
  fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify({
    schemaVersion: 1, product: 'kp-local-helper', channel: 'internal', signed: false, version, fileName: name,
    capabilities: ['mcp', 'local-model'], localModelProtocolVersion: '1.0.0',
    url: `https://cdn.keepwork.com/custom/helper/${name}`, size: fs.statSync(path.join(dir, name)).size, sha256: qiniu.sha256(path.join(dir, name)),
  }));
  const args = ['--release-dir', dir, '--version', version, '--prefix', 'custom/helper/', '--domain', 'https://cdn.keepwork.com', '--bucket', 'haqi', '--upload-host', 'https://up-z2.qiniup.com'];
  for (const mode of ['success', 'dry-run', 'failed']) {
    const summaries = [], events = [];
    const main = loadMain('apps/local-helper/scripts/publish-qiniu-release.cjs', [...args, ...(mode === 'dry-run' ? ['--dry-run'] : [])], {
      summaries, events, overrides: { '../../../scripts/lib/qiniu-release.cjs': { ...qiniu,
        uploadEntry: async () => events.push('upload'), refreshUrls: async () => events.push('refresh'),
        verifyEntriesWithRetry: async () => { events.push('verify'); if (mode === 'failed') throw Error('CDN mismatch'); },
      } },
    });
    if (mode === 'failed') await assert.rejects(main, /CDN mismatch/);
    else await main();
    assert.equal(summaries.length, mode === 'success' ? 1 : 0);
    if (mode === 'success') {
      assert.equal(summaries[0].entries.length, 4);
      assert.ok(summaries[0].entries.every(entry => entry.url.startsWith('https://cdn.keepwork.com/custom/helper/')));
      assert.deepEqual(events.slice(-2), ['verify', 'summary']);
    }
  }
});

test('Desktop CLI summarizes each platform only after publishing all binaries and descriptors', async t => {
  const dir = temporaryDirectory(t);
  fs.writeFileSync(path.join(dir, 'KeepWork-SecondBrain-1.2.3-x64.zip'), 'zip fixture');
  fs.writeFileSync(path.join(dir, 'KeepWork-SecondBrain-1.2.3-x64.exe'), 'installer fixture');
  fs.writeFileSync(path.join(dir, 'latest.yml'), 'version: 1.2.3\n');
  for (const mode of ['success', 'dry-run', 'failed']) {
    const summaries = [], events = [];
    const args = ['--dir', dir, '--target', 'win32-x64', ...(mode === 'dry-run' ? ['--dry-run'] : [])];
    const main = loadMain('scripts/publish-desktop.cjs', args, { summaries, events, overrides: {
      './stable-release.cjs': { publish: async () => { events.push('verified'); if (mode === 'failed') throw Error('CDN mismatch'); } },
    } });
    if (mode === 'failed') await assert.rejects(main, /CDN mismatch/);
    else await main();
    assert.equal(summaries.length, mode === 'success' ? 1 : 0);
    if (mode === 'success') {
      assert.equal(summaries[0].version, '1.2.3');
      assert.equal(summaries[0].entries.length, 5);
      assert.match(summaries[0].title, /win32-x64/);
      assert.deepEqual(events, ['verified', 'verified', 'summary']);
    }
  }
});

test('Launcher CLI lists only objects actually published or verified across modes and reruns', async t => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const env = {
    KP_DESKTOP_LAUNCHER_PUBLIC_KEY: Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64'),
    KP_DESKTOP_MANIFEST_PRIVATE_KEY: privateKey.export({ format: 'pem', type: 'pkcs8' }),
  };
  for (const variant of ['code', 'initial', 'launchers', 'code-and-launchers', 'refresh-platforms', 'code:retry', 'code-and-launchers:retry', 'code:failed']) {
    const [mode, outcome] = variant.split(':');
    const dir = temporaryDirectory(t), summaries = [], events = [], published = [];
    const descriptor = (bytes) => {
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      fs.writeFileSync(path.join(dir, `${sha256}.zip`), bytes);
      return { version: '1.2.3', size: bytes.length, contract: 'd'.repeat(64), sha256 };
    };
    const app = descriptor(Buffer.from('app fixture'));
    fs.writeFileSync(path.join(dir, 'app.json'), JSON.stringify(app));
    const platforms = {};
    for (const target of targets) {
      platforms[target] = descriptor(Buffer.from(target));
      fs.writeFileSync(path.join(dir, `${target}.json`), JSON.stringify(platforms[target]));
      fs.writeFileSync(path.join(dir, `Keepwork-Launcher-${target}.zip`), target);
    }
    const previous = { schema: 1, sequence: outcome === 'retry' ? 2 : 1, version: '1.2.3', app, platforms };
    const payload = Buffer.from(JSON.stringify(previous));
    const envelope = { payload: payload.toString('base64'), signature: crypto.sign(null, payload, privateKey).toString('base64') };
    const main = loadMain('apps/aichat-desktop/launcher/publish.cjs', [mode, dir, '2'], {
      env, summaries, events, fetch: async () => mode === 'initial' ? new Response('', { status: 404 }) : new Response(JSON.stringify(envelope)),
      overrides: {
        '../../../scripts/stable-release.cjs': { publish: async entries => { events.push('verified'); published.push(...entries); if (outcome === 'failed') throw Error('CDN mismatch'); } },
        '../../../scripts/lib/qiniu-release.cjs': { ...qiniu, verifyEntriesWithRetry: async entries => { events.push('verified'); published.push(...entries); } },
      },
    });
    if (outcome === 'failed') { await assert.rejects(main, /CDN mismatch/); assert.equal(summaries.length, 0); continue; }
    await main();
    assert.equal(summaries.length, 1, variant);
    assert.deepEqual(Array.from(summaries[0].entries, entry => entry.url).sort(), published.map(entry => entry.url).sort(), variant);
    assert.equal(events.at(-1), 'summary', variant);
    if (variant === 'code:retry') assert.match(`${summaries[0].title} ${summaries[0].note}`, /重用|复用/);
  }
});
