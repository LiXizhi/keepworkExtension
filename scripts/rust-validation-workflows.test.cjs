const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
// Git's Windows checkout may use CRLF. Validate the same workflow contract on
// every host instead of treating a checkout's line endings as a CI regression.
const workflow = name => fs.readFileSync(path.join(__dirname, '../.github/workflows', name), 'utf8').replace(/\r\n?/g, '\n');
const jobBody = (source, job) => {
  const start = source.search(new RegExp(`^  ${job}:$`, 'm'));
  assert.ok(start >= 0, `workflow must define the ${job} job`);
  const remainder = source.slice(start);
  const next = remainder.slice(1).search(/^  [a-z][a-z-]*:$/m);
  return next < 0 ? remainder : remainder.slice(0, next + 1);
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
  // Publication stays manual-dispatch on a tag; a PR or main push can never reach it.
  const publish = jobBody(desktop, 'publish');
  assert.match(publish, /^    if: startsWith\(github\.ref, 'refs\/tags\/v'\) \|\| /m);
  assert.match(publish, /contents: write/);
  // Anything that reads a secret or publishes must be gated off pull requests.
  for (const job of ['build', 'build-macos', 'publish']) {
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
  assert.match(release, /validate:\n    uses: \.\/\.github\/workflows\/rust-desktop-validation\.yml/);
  for (const job of ['build', 'build-macos']) assert.match(release, new RegExp('  ' + job + ':\\n    needs: validate'));
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
          const result = spawnSync(process.execPath, ['--require', preload, '--test', __filename], {
            encoding: 'utf8', timeout: 30000,
            env: { ...process.env, KEEPWORK_WORKFLOW_EOL_FIXTURE: eol },
          });
          assert.ifError(result.error);
          assert.equal(result.status, 0, result.stdout + result.stderr);
        });
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
