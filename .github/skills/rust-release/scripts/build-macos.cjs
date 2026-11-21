#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readArgs, sha256 } = require('./download-artifacts.cjs');
const { SIGNING_IDENTITY, COMMIT_KEY, SLICES, verifyMacDmg } = require('./macos-release.cjs');

const root = path.resolve(__dirname, '../../../..');
const app = path.join(root, 'apps/aichat-rust');

function main() {
  const { tag, output } = readArgs(process.argv.slice(2), ['tag', 'output']);
  if (process.platform !== 'darwin' || !/^v\d+\.\d+\.\d+$/.test(tag) || !output) {
    throw Error('On the release Mac, use --tag vX.Y.Z --output NEW_DIRECTORY');
  }
  const version = require(path.join(app, 'package.json')).version;
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const commit = git('rev-parse', 'HEAD');
  if (tag !== `v${version}` || git('rev-parse', '--verify', `refs/tags/${tag}^{commit}`) !== commit
    || git('status', '--porcelain')) throw Error('Require a clean checkout of the exact desktop release tag');

  const identities = execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  if (!identities.includes(`"${SIGNING_IDENTITY}"`)) throw Error('Paracraft Developer ID signing identity is unavailable');
  const dest = path.resolve(output);
  const fileName = `Keepwork_${version}_universal.dmg`;
  const dmg = path.join(dest, fileName);
  fs.mkdirSync(dest);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-mac-bundle-'));
  try {
    const checked = (file, args, options) => execFileSync(file, args, { stdio: 'inherit', ...options });
    const plist = path.join(temporary, 'Info.plist');
    fs.copyFileSync(path.join(app, 'src-tauri/Info.plist'), plist);
    checked('/usr/bin/plutil', ['-insert', COMMIT_KEY, '-string', commit, plist]);
    const config = JSON.stringify({ bundle: { macOS: { infoPlist: plist } } });
    checked(process.execPath, ['scripts/bundle-mcp-rust.cjs', '--target', 'universal-apple-darwin'], { cwd: app });
    for (const { arch } of SLICES) {
      const binary = path.join(app, 'src-tauri/resources/mcp-runtime', arch, 'bin/keepwork-mcp');
      checked('/usr/bin/codesign', ['--force', '--sign', SIGNING_IDENTITY, '--timestamp', '--options', 'runtime',
        '--identifier', 'com.keepwork.aichat-desktop.mcp', binary]);
    }
    const signingEnv = { ...process.env, APPLE_SIGNING_IDENTITY: SIGNING_IDENTITY };
    for (const key of ['APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID',
      'APPLE_API_KEY', 'APPLE_API_ISSUER', 'APPLE_API_KEY_PATH']) delete signingEnv[key];
    checked('pnpm', ['exec', 'tauri', 'build', '--ci', '--target', 'universal-apple-darwin', '--bundles', 'app,dmg',
      '--config', config, '--', '--locked'], { cwd: app, env: signingEnv });
    if (git('rev-parse', 'HEAD') !== commit || git('status', '--porcelain')) throw Error('Release source changed during build');
    fs.copyFileSync(path.join(app, 'src-tauri/target/universal-apple-darwin/release/bundle/dmg', fileName), dmg);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  const submittedSha256 = sha256(dmg);
  const notarization = JSON.parse(execFileSync('/usr/bin/xcrun', ['notarytool', 'submit', dmg,
    '--keychain-profile', 'KeepworkNotary', '--wait', '--output-format', 'json'], { encoding: 'utf8' }));
  console.log(JSON.stringify({ notarizationId: notarization.id, status: notarization.status }));
  if (notarization.status !== 'Accepted' || !notarization.id) throw Error('Apple has not accepted the macOS DMG');
  execFileSync('/usr/bin/xcrun', ['stapler', 'staple', dmg], { stdio: 'inherit' });
  verifyMacDmg(dmg, { version, commit });
  const receipt = { schemaVersion: 1, tag, version, commit, notarizationId: notarization.id, submittedSha256,
    fileName, size: fs.statSync(dmg).size, sha256: sha256(dmg) };
  fs.writeFileSync(path.join(dest, 'macos-release-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(receipt, null, 2));
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
