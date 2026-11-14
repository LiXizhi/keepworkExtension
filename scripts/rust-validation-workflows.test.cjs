const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
// Git's Windows checkout may use CRLF. Validate the same workflow contract on
// every host instead of treating a checkout's line endings as a CI regression.
const workflow = name => fs.readFileSync(path.join(__dirname, '../.github/workflows', name), 'utf8').replace(/\r\n?/g, '\n');
const jobBody = (source, job) => {
  const start = source.search(new RegExp(`^  ${job}:$`, 'm'));
  assert.ok(start >= 0, `workflow must define the ${job} job`);
  const remainder = source.slice(start);
  const next = remainder.slice(1).search(/^  [a-z][a-z0-9-]*:$/m);
  return next < 0 ? remainder : remainder.slice(0, next + 1);
};
const jobSelected = (source, job, context) => {
  const expression = jobBody(source, job).match(/^    if: (.+)$/m)?.[1];
  assert.ok(expression, `the ${job} job must have an explicit event/edition gate`);
  // Evaluate the workflow's actual gate for the contexts below. Restrict this
  // tiny expression subset before execution instead of depending on line order.
  const operators = expression.replace(/'[^']*'/g, '')
    .replace(/github\.(?:event_name|ref)|inputs\.edition|startsWith/g, '');
  assert.match(operators, /^[\s(),!&|=]*$/, 'unsupported workflow gate expression');
  const evaluate = new Function('github', 'inputs', 'startsWith', `return Boolean(${expression});`);
  return evaluate(context.github, context.inputs, (value, prefix) => String(value).startsWith(prefix));
};

test('PRs validate both Rust products without entering installer or publication jobs', () => {
  const desktop = workflow('aichat-rust-windows-release.yml');
  const mcp = workflow('mcp-rust.yml');
  assert.match(mcp, /^  pull_request:/m);
  assert.match(mcp, /contents: read/);
  assert.doesNotMatch(mcp, /contents: write|secrets\.|gh release|npm publish|vsce publish/);
  for (const source of [desktop, mcp]) {
    assert.match(source, /^  pull_request:/m);
    assert.match(source, /"src\/\*\*"/);
    assert.match(source, /"scripts\/\*\*"/);
  }
  assert.match(desktop, /^permissions:\n  contents: read$/m);
  assert.match(desktop, /uses: \.\/\.github\/workflows\/rust-desktop-validation\.yml/);
  for (const job of ['build', 'build-macos']) {
    const body = jobBody(desktop, job);
    assert.match(body, /needs: validate/);
    assert.match(body, /if: github\.event_name != 'pull_request'/);
  }
  // Tagged builds only prepare downloadable assets; the local publisher owns CDN writes.
  const prepare = jobBody(desktop, 'prepare-release');
  assert.match(prepare, /^    if: .*startsWith\(github\.ref, 'refs\/tags\/v'\)/m);
  assert.match(prepare, /needs: \[build, build-macos\]/);
  assert.match(prepare, /actions\/upload-artifact@v4/);
  assert.match(prepare, /name: aichat-rust-release-packages/);
  assert.doesNotMatch(desktop, /^  publish:|contents: write|KP_QINIU|gh release|--draft=false|--latest/m);
  // Signing credentials are still unavailable to pull requests.
  for (const job of ['build', 'build-macos', 'prepare-release']) {
    const body = jobBody(desktop, job);
    if (/secrets\.|gh release/.test(body)) {
      assert.match(body, /if: (github\.event_name != 'pull_request'|startsWith\(github\.ref, 'refs\/tags\/)/, job);
    }
  }
});

test('release and PR builds share real host Windows tests instead of inheriting macOS skips', () => {
  const validation = workflow('rust-desktop-validation.yml');
  assert.match(validation, /workflow_call:/);
  assert.match(validation, /os: \[macos-latest, windows-latest\]/);
  assert.match(validation, /cargo test --locked --manifest-path apps\/aichat-rust\/src-tauri\/Cargo\.toml --features dev-bins/);
  assert.match(validation, /--test-reporter=tap apps\/aichat-rust\/tests\/\*\.test\.cjs/);
  assert.match(validation, /scripts\/smoke\.cjs/);
  assert.match(validation, /npm ci --prefix apps\/mcp-runtime/);
  assert.doesNotMatch(validation, /secrets\.|gh release|contents: write/);
  const release = workflow('aichat-rust-windows-release.yml');
  assert.match(jobBody(release, 'validate'), /uses: \.\/\.github\/workflows\/rust-desktop-validation\.yml/);
  for (const job of ['build', 'build-macos']) assert.match(release, new RegExp('  ' + job + ':\\n    needs: validate'));
});

test('default and all editions include legacy while explicit modern, legacy and PR scopes stay bounded', () => {
  const source = workflow('aichat-rust-windows-release.yml');
  const jobs = ['validate', 'build-win7-win8', 'build', 'build-macos', 'prepare-release'];
  const scenarios = [
    ['all branch dispatch', 'workflow_dispatch', 'all', 'refs/heads/main', ['validate', 'build-win7-win8', 'build', 'build-macos']],
    ['all tagged dispatch', 'workflow_dispatch', 'all', 'refs/tags/v0.2.128', jobs],
    ['default tagged dispatch', 'workflow_dispatch', '', 'refs/tags/v0.2.128', jobs],
    ['ordinary modern branch dispatch', 'workflow_dispatch', 'modern', 'refs/heads/main', ['validate', 'build', 'build-macos']],
    ['caller without an edition follows the default all scope', 'workflow_dispatch', '', 'refs/heads/main', ['validate', 'build-win7-win8', 'build', 'build-macos']],
    ['modern tagged dispatch', 'workflow_dispatch', 'modern', 'refs/tags/v0.2.126', ['validate', 'build', 'build-macos', 'prepare-release']],
    ['historical modern tag dispatch', 'workflow_dispatch', 'modern', 'refs/tags/aichat-rust-v0.2.126', ['validate', 'build', 'build-macos', 'prepare-release']],
    ['legacy branch dispatch', 'workflow_dispatch', 'win7-win8', 'refs/heads/main', ['build-win7-win8']],
    ['legacy dispatch from a modern release tag', 'workflow_dispatch', 'win7-win8', 'refs/tags/v0.2.126', ['build-win7-win8']],
    ['ordinary pull request', 'pull_request', '', 'refs/pull/1/merge', ['validate']],
    ['pull request cannot select all signing jobs', 'pull_request', 'all', 'refs/pull/1/merge', ['validate']],
    ['pull request cannot select modern signing jobs', 'pull_request', 'modern', 'refs/pull/1/merge', ['validate']],
    ['pull request cannot select legacy secrets', 'pull_request', 'win7-win8', 'refs/pull/1/merge', ['validate']],
    ['pull request with a tag ref cannot prepare or build legacy assets', 'pull_request', 'all', 'refs/tags/v0.2.128', ['validate']],
  ];
  for (const [label, event, edition, ref, expected] of scenarios) {
    const context = { github: { event_name: event, ref }, inputs: { edition } };
    assert.deepEqual(jobs.filter(job => jobSelected(source, job, context)), expected, label);
  }
});

test('the legacy workflow has only a reusable trigger and is selected through the single desktop entry', () => {
  const source = workflow('aichat-rust-windows-release.yml');
  const choices = source.slice(0, source.indexOf('  pull_request:'));
  assert.match(choices, /edition:[\s\S]*?default: all[\s\S]*?- all\n\s+- modern\n\s+- win7-win8/);
  assert.match(choices, /legacy-signing:[\s\S]*?default: preview/,
    'build-only dispatches retain preview signing; actual publication explicitly chooses production');
  assert.match(jobBody(source, 'build-win7-win8'), /uses: \.\/\.github\/workflows\/aichat-rust-win7\.yml/);
  const reusable = workflow('aichat-rust-win7.yml');
  const triggers = reusable.slice(0, reusable.indexOf('permissions:'));
  assert.match(triggers, /^  workflow_call:/m);
  assert.doesNotMatch(triggers, /^  (?:workflow_dispatch|push|pull_request):/m);
  assert.match(reusable, /contents: read/);
  assert.doesNotMatch(reusable, /contents: write|gh release|--publish true|KP_QINIU/);
});

test('legacy packaging pins the Windows 2022 host, v143 compiler and Windows SDK for both native builds', () => {
  const source = workflow('aichat-rust-win7.yml');
  assert.match(jobBody(source, 'build'), /runs-on: windows-2022\b/);
  const toolchain = source.match(/      - uses: ilammy\/msvc-dev-cmd@v1\n        with:\n((?:          .+\n)+)/)?.[1];
  assert.ok(toolchain, 'the legacy job must configure its own native toolchain');
  assert.match(toolchain, /vsversion: ['"]?2022['"]?/);
  assert.match(toolchain, /toolset: ['"]?14\.44['"]?/);
  assert.match(toolchain, /sdk: ['"]?10\.0\.22621\.0['"]?/);
  const cefConfigure = source.split('\n').find(line => line.trim().startsWith('cmake -S apps/aichat-rust/windows/cef-host '));
  assert.ok(cefConfigure, 'the actual legacy CEF configure call must be present');
  assert.match(cefConfigure, /-G ['"]Visual Studio 17 2022['"]/);
  assert.match(cefConfigure, /-T ['"]v143,version=14\.44['"]/);
  assert.match(cefConfigure, /-DCMAKE_SYSTEM_VERSION=10\.0\.22621\.0\b/);
});

test('launcher-only diagnosis audits actual executable bytes and retains failed-build evidence without publishing', () => {
  const source = workflow('win7-redist-diagnostic.yml');
  const launcher = jobBody(source, 'launcher');
  assert.match(launcher, /runs-on: windows-2022\b/);
  assert.match(launcher, /-G ['"]Visual Studio 17 2022['"]/);
  assert.match(launcher, /-T ['"]v143,version=14\.44['"]/);
  assert.match(launcher, /-DCMAKE_SYSTEM_VERSION=10\.0\.22621\.0\b/);
  assert.match(launcher, /Get-Content launcher-diagnostic\/_deps\/miniz-build\/miniz\.vcxproj -Raw/);
  assert.match(launcher, /ctest --test-dir launcher-diagnostic -C Release --output-on-failure/);
  assert.match(launcher, /node scripts\/lib\/windows7-pe\.cjs launcher-diagnostic\/Release --output launcher-diagnostic\/pe-report\.json/);
  assert.doesNotMatch(launcher, /windows7-pe\.cjs\s+['"]?[^'"\s]*\.exe(?:['"]?\s|$)/i,
    'the audit CLI receives the Release directory so every executable is checked');
  const artifact = launcher.slice(launcher.indexOf('uses: actions/upload-artifact@v4'));
  assert.match(artifact, /if: always\(\)/);
  for (const file of ['Release/*.exe', 'Release/*.map', 'CMakeCache.txt', 'pe-report.json']) {
    assert.ok(artifact.includes('launcher-diagnostic/' + file), 'retain ' + file);
  }
  assert.doesNotMatch(source, /contents: write|secrets\.|gh release|--publish true|KP_QINIU/);
});

test('the launcher build explicitly selects the compatible toolchain instead of inheriting the host default', t => {
  const { buildWin7 } = require('../apps/aichat-rust/scripts/build-win7.cjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-win7-configure-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const keyFile = path.join(directory, 'fixture-private.pem');
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const stopped = new Error('fixture stops before compilation, packaging or signing');
  const calls = [];
  assert.throws(() => buildWin7({ mcpDirectory: path.join(directory, 'unused-runtime'),
    output: path.join(directory, 'new-build'), privateKeyFile: keyFile }, {
    platform: 'win32',
    exec(command, args) { calls.push({ command, args }); throw stopped; },
  }), error => error === stopped);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'cmake');
  const { args } = calls[0];
  for (const [flag, value] of [['-G', 'Visual Studio 17 2022'], ['-A', 'x64'], ['-T', 'v143,version=14.44']]) {
    assert.equal(args[args.indexOf(flag) + 1], value, flag);
  }
  assert.ok(args.includes('-DCMAKE_SYSTEM_VERSION=10.0.22621.0'));
  assert.ok(args.includes('-DKEEPWORK_WIN7_EDITION=ON'));
});

test('the actual legacy CMake guard rejects unsupported newer STL toolsets before dependency setup', t => {
  const source = fs.readFileSync(path.join(__dirname, '../apps/aichat-rust/windows/CMakeLists.txt'), 'utf8').replace(/\r\n?/g, '\n');
  const guard = source.match(/  if\(KEEPWORK_WIN7_EDITION AND MSVC_VERSION GREATER_EQUAL 1950\)\n[\s\S]*?  endif\(\)/)?.[0];
  assert.ok(guard, 'the legacy configuration must reject MSVC 14.50 and newer');
  assert.ok(source.indexOf(guard) < source.indexOf('FetchContent_MakeAvailable('), 'fail before fetching/building dependencies');
  for (const definition of ['WINVER=0x0601', '_WIN32_WINNT=0x0601']) {
    assert.ok(source.indexOf(definition) >= 0 && source.indexOf(definition) < source.indexOf('FetchContent_MakeAvailable('),
      'dependency targets must inherit ' + definition);
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-win7-toolset-guard-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const [legacy, compiler, accepted] of [[true, 1944, true], [true, 1950, false], [true, 1951, false], [false, 1951, true]]) {
    const script = path.join(directory, `guard-${legacy}-${compiler}.cmake`);
    fs.writeFileSync(script, `set(KEEPWORK_WIN7_EDITION ${legacy ? 'ON' : 'OFF'})\nset(MSVC_VERSION ${compiler})\n${guard}\n`);
    const result = spawnSync('cmake', ['-P', script], { encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.status === 0, accepted, `legacy=${legacy}, compiler=${compiler}: ${result.stdout}${result.stderr}`);
    if (!accepted) assert.match((result.stdout + result.stderr).replace(/\s+/g, ' '), /MSVC 14\.50\+ no longer targets these systems/);
  }
});

test('wire contract CI builds and requires Node reference and retains failed command receipts', () => {
  const source = workflow('mcp-rust.yml');
  assert.match(source, /KEEPWORK_MCP_REQUIRE_NODE_REFERENCE: '1'/);
  const reference = source.indexOf('node scripts/build-node-reference.cjs');
  const contracts = source.indexOf('scripts/contract/*.test.cjs');
  assert.ok(reference >= 0 && contracts > reference, 'Node reference must be built before comparisons');
  assert.match(source, /readBuildInfo\(process\.argv\[1\]\)\.target/);
  assert.match(source, /package-runtime\.cjs --target "\$runtime_target"/);
  assert.match(source, /archives=\(\.test-runtime\/mcp-rust\/package\/\*\.zip\)/);
  assert.match(source, /test "\$runtime_target" = "\$runtime_triple"/,
    'every requested architecture must match the actual embedded binary identity');
  assert.match(source, /--report-name "report-\$runtime_target\.json"/,
    'the two Mac archives must not share one ambiguous acceptance report');
  for (const name of ['mcp-rust.yml', 'rust-desktop-validation.yml']) {
    const current = workflow(name);
    assert.match(current, /if: always\(\)\n\s+run:.*rust-validation-evidence\.cjs collect|if: always\(\)\n\s+run: \|[\s\S]*?rust-validation-evidence\.cjs collect/);
    assert.match(current, /if: always\(\)\n\s+uses: actions\/upload-artifact@v4/);
    assert.match(current, /retention-days: 30/);
  }
});

test('Rust MCP delivery has only Windows x64, native Windows ARM64 and a dual-slice Mac group', () => {
  const source = workflow('mcp-rust.yml');
  const groups = [...source.matchAll(/^            group: ([^\n]+)$/gm)].map(match => match[1]);
  assert.deepEqual(groups, ['windows-x64', 'windows-arm64', 'macos-universal']);
  assert.doesNotMatch(source, /ubuntu-latest|linux-(?:x64|arm64)|unknown-linux/);
  assert.match(source, /group: windows-arm64\n\s+os: windows-11-arm\n\s+node-arch: arm64\n\s+native: aarch64-pc-windows-msvc/);
  assert.match(source, /group: macos-universal[\s\S]*?build-targets: aarch64-apple-darwin x86_64-apple-darwin/);
  assert.match(source, /for runtime_triple in \$RUST_BUILD_TARGETS; do/);
  assert.match(source, /--id "source-checks-package-\$receipt_suffix"/,
    'different architectures need different durable check IDs');
  assert.match(source, /name: mcp-rust-validation-\$\{\{ matrix\.group \}\}/);
  assert.doesNotMatch(source, /Expected exactly one runtime archive/);
  const publisher = workflow('mcp-rust-publish.yml');
  const choices = publisher.match(/options: \[([^\]]+)\]/)?.[1].split(',').map(value => value.trim());
  assert.deepEqual(choices, ['macos-arm64', 'macos-x64', 'windows-x64', 'windows-arm64']);
});

test('root full validation includes both Rust products and exposes explicit packaged/canonical modes', () => {
  const pkg = require('../package.json');
  assert.match(pkg.scripts['check:all'], /npm run check:rust:all/);
  assert.match(pkg.scripts['check:rust:all'], /check:rust.*check:rust:desktop.*test:contract/);
  assert.match(pkg.scripts['check:aichat-runtime:packaged'], /--mode packaged/);
  assert.match(pkg.scripts['check:aichat-runtime:canonical'], /--mode canonical/);
  assert.match(pkg.scripts['test:contract'], /scripts\/build-node-reference\.cjs/);
  const reference = fs.readFileSync(path.join(__dirname, 'build-node-reference.cjs'), 'utf8');
  assert.match(reference, /KEEPWORK_AICHAT_RUNTIME_MODE: 'packaged'/);
  assert.match(reference, /shell: false/);
});

if (!process.env.KEEPWORK_WORKFLOW_EOL_FIXTURE) {
  test('workflow contracts pass with both LF and Windows CRLF checkouts', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-workflow-eol-'));
    try {
      const preload = path.join(directory, 'checkout.cjs');
      fs.writeFileSync(preload, String.raw`
        const fs = require('node:fs');
        const read = fs.readFileSync;
        fs.readFileSync = function(file, ...args) {
          const source = read.call(this, file, ...args);
          if (typeof source !== 'string' || !/[\\/]\.github[\\/]workflows[\\/].*\.yml$/.test(String(file))) return source;
          return source.replace(/\r?\n/g, process.env.KEEPWORK_WORKFLOW_EOL_FIXTURE === 'CRLF' ? '\r\n' : '\n');
        };
      `);
      for (const eol of ['LF', 'CRLF']) {
        await t.test(eol, () => {
          const environment = { ...process.env, KEEPWORK_WORKFLOW_EOL_FIXTURE: eol };
          // A test worker exports this flag; inheriting it makes a nested
          // `node --test` exit successfully without executing its test file.
          delete environment.NODE_TEST_CONTEXT;
          const result = spawnSync(process.execPath, ['--require', preload, '--test', '--test-reporter=tap', __filename], {
            encoding: 'utf8', timeout: 30000,
            env: environment,
          });
          assert.ifError(result.error);
          assert.equal(result.status, 0, result.stdout + result.stderr);
          assert.match(result.stdout, /^# tests [1-9]\d*$/m, 'the nested checkout must actually execute the contract suite');
        });
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
