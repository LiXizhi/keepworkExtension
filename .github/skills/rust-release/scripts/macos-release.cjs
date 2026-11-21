const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateBinary } = require('../../../../scripts/lib/rust-runtime-identity.cjs');

const SIGNING_IDENTITY = 'Developer ID Application: Shenzhen Paracraft Technology Co., Ltd. (5QLPT4C3EB)';
const TEAM = '5QLPT4C3EB';
const COMMIT_KEY = 'KeepworkReleaseCommit';
const SLICES = [
  { arch: 'arm64', machine: 'arm64', triple: 'aarch64-apple-darwin' },
  { arch: 'x64', machine: 'x86_64', triple: 'x86_64-apple-darwin' },
];

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`${command} failed (${result.signal || result.status}): ${result.stderr.trim() || result.stdout.trim()}`);
  return result;
}

function verifySignature(file, { runtime = false, architectures = [undefined] } = {}) {
  run('/usr/bin/codesign', ['--verify', '--strict', '--all-architectures', file]);
  for (const arch of architectures) {
    const args = arch ? ['--architecture', arch] : [];
    const details = run('/usr/bin/codesign', ['-d', '--verbose=4', ...args, file]).stderr.split(/\r?\n/);
    if (!details.includes(`Authority=${SIGNING_IDENTITY}`) || !details.includes(`TeamIdentifier=${TEAM}`)
      || !details.some(line => /^Timestamp=.+/.test(line))
      || (runtime && !details.some(line => /^[Cc]odeDirectory.*flags=0x[\da-f]+\([^)]*\bruntime\b/.test(line)))) {
      throw Error(`Missing Paracraft Developer ID, secure timestamp or Hardened Runtime: ${path.basename(file)}`);
    }
  }
}

function verifyArchitectures(file, expected) {
  const actual = run('/usr/bin/lipo', ['-archs', file]).stdout.trim().split(/\s+/).sort();
  if (actual.join(' ') !== [...expected].sort().join(' ')) throw Error(`Unexpected macOS architectures: ${actual.join(' ')}`);
}

function verifyMacDmg(dmg, { version, commit }) {
  if (process.platform !== 'darwin') throw Error('Verify the formal macOS DMG on the release Mac');
  run('/usr/bin/hdiutil', ['verify', dmg]);
  verifySignature(dmg);
  run('/usr/bin/xcrun', ['stapler', 'validate', dmg]);
  run('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', dmg]);
  const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-release-mount-'));
  let attached = false;
  try {
    run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg]);
    attached = true;
    const app = path.join(mount, 'Keepwork.app');
    const contents = path.join(app, 'Contents');
    const architectures = SLICES.map(slice => slice.machine);
    verifySignature(app, { runtime: true, architectures });
    const plist = key => run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', path.join(contents, 'Info.plist')]).stdout.trim();
    if (plist('CFBundleIdentifier') !== 'com.keepwork.aichat-desktop' || plist('CFBundleShortVersionString') !== version
      || plist(COMMIT_KEY) !== commit || plist('CFBundleExecutable') !== 'Keepwork') {
      throw Error('Signed Keepwork.app does not match the desktop release tag');
    }
    verifyArchitectures(path.join(contents, 'MacOS', 'Keepwork'), architectures);
    const runtimes = path.join(contents, 'Resources', 'resources', 'mcp-runtime');
    let reference;
    for (const slice of SLICES) {
      const root = path.join(runtimes, slice.arch);
      const manifest = JSON.parse(fs.readFileSync(path.join(root, 'runtime.json'), 'utf8'));
      if (manifest.engine !== 'rust' || manifest.platform !== 'macos' || manifest.arch !== slice.arch || manifest.commit !== commit
        || !/^\d+\.\d+\.\d+$/.test(manifest.version) || !/^[a-f0-9]{64}$/.test(manifest.sourceHash)
        || (reference && (reference.sourceHash !== manifest.sourceHash || reference.version !== manifest.version))) {
        throw Error('Signed bundled MCP does not match the desktop release source');
      }
      const binary = path.join(root, 'bin', 'keepwork-mcp');
      verifySignature(binary, { runtime: true, architectures: [slice.machine] });
      verifyArchitectures(binary, [slice.machine]);
      validateBinary(binary, slice, { version: manifest.version, sourceHash: manifest.sourceHash, commit });
      reference = manifest;
    }
  } finally {
    if (attached) run('/usr/bin/hdiutil', ['detach', mount]);
    fs.rmdirSync(mount);
  }
}

module.exports = { SIGNING_IDENTITY, COMMIT_KEY, SLICES, verifyMacDmg };
