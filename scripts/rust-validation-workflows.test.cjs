const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
// Git's Windows checkout may use CRLF. Validate the same workflow contract on
// every host instead of treating a checkout's line endings as a CI regression.
const workflow = name => fs.readFileSync(path.join(__dirname, '../.github/workflows', name), 'utf8').replace(/\r\n/g, '\n');
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
  assert.doesNotMatch(source, /matrix\.target|matrix\.runtime/, 'native artifact identity cannot be guessed from a moving runner label');
  for (const name of ['mcp-rust.yml', 'rust-desktop-validation.yml']) {
    const current = workflow(name);
    assert.match(current, /if: always\(\)\n\s+run:.*rust-validation-evidence\.cjs collect|if: always\(\)\n\s+run: \|[\s\S]*?rust-validation-evidence\.cjs collect/);
    assert.match(current, /if: always\(\)\n\s+uses: actions\/upload-artifact@v4/);
    assert.match(current, /retention-days: 30/);
  }
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
