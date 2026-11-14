#!/usr/bin/env node
// Independent Windows 7/8 artifacts. This packager never writes a feed or uploads.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const identity = require('../../../scripts/lib/rust-runtime-identity.cjs');
const config = require('../win7-toolchain.json');
const root = path.resolve(__dirname, '..');
const repo = path.resolve(root, '../..');
const BASE = 'https://cdn.keepwork.com/keepwork/mcp-win7-win8-rs';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function packageWin7Runtime({ binary, output, expected }) {
  const audit = require('../../../scripts/lib/windows7-pe.cjs');
  const info = identity.validateBinary(binary, { triple: config.target }, expected);
  if (info.variant !== config.variant || JSON.stringify(info.minWindows) !== JSON.stringify(config.minWindows)) {
    throw new Error('Binary is not a Windows 7/8 compatibility runtime');
  }
  const binaryBytes = fs.readFileSync(binary);
  audit.auditPe(binaryBytes, { arch: 'x64' });
  if (!/^[a-f0-9]{40}$/.test(info.commit) || !/^[a-f0-9]{64}$/.test(info.sourceHash)) {
    throw new Error('Missing compiled Windows 7/8 provenance');
  }
  output = path.resolve(output);
  if (fs.existsSync(output)) throw new Error('Windows 7/8 output directory must be new');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-win7-package-'));
  const fileName = 'windows-x64.zip';
  const entry = 'bin/keepwork-mcp.exe';
  const buildTime = info.builtAt === undefined ? {} : { builtAt: info.builtAt, builtAtSource: info.builtAtSource };
  const shared = {
    schemaVersion: 2, product: info.product, engine: 'rust', variant: config.variant, version: info.version,
    ...buildTime, commit: info.commit, sourceHash: info.sourceHash, platform: 'windows', arch: 'x64',
    buildTarget: config.target, minWindows: config.minWindows,
  };
  try {
    fs.mkdirSync(path.join(temporary, 'bin'));
    fs.writeFileSync(path.join(temporary, entry), binaryBytes);
    fs.copyFileSync(path.join(repo, 'LICENSE'), path.join(temporary, 'LICENSE'));
    const runtime = { ...shared, entry, args: ['--port', '8089'], env: {},
      health: { url: 'http://127.0.0.1:8089/health', match: {
        name: 'keepwork-mcp', runtimeEngine: 'rust', runtimeVariant: config.variant,
      } } };
    fs.writeFileSync(path.join(temporary, 'runtime.json'), JSON.stringify(runtime, null, 2) + '\n');
    audit.auditDirectory(temporary, { arch: 'x64' });
    const files = ['LICENSE', entry, 'runtime.json'].map(name => {
      const bytes = fs.readFileSync(path.join(temporary, name));
      return { path: name, size: bytes.length, sha256: digest(bytes) };
    });
    fs.mkdirSync(output, { recursive: true });
    const archive = path.join(output, fileName);
    if (process.platform === 'win32') {
      execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
        "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:KP_WIN7_ARCHIVE_SOURCE, $env:KP_WIN7_ARCHIVE_OUTPUT)"],
      { env: { ...process.env, KP_WIN7_ARCHIVE_SOURCE: temporary, KP_WIN7_ARCHIVE_OUTPUT: archive }, stdio: 'pipe' });
    } else {
      execFileSync('zip', ['-q', '-r', archive, '.'], { cwd: temporary, stdio: 'pipe' });
    }
    const bytes = fs.readFileSync(archive);
    const manifest = { ...shared, fileName, entry, files,
      unpackedSize: files.reduce((sum, file) => sum + file.size, 0),
      url: `${BASE}/${info.version}/${fileName}`, size: bytes.length, sha256: digest(bytes) };
    fs.writeFileSync(path.join(output, 'windows-x64.json'), JSON.stringify(manifest, null, 2) + '\n');
    return { archive, manifest };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function main(args = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!['--binary', '--out'].includes(args[index]) || !args[index + 1]) {
      throw new Error('Usage: package-win7-runtime.cjs --binary <exe> --out <new-directory>');
    }
    options[args[index].slice(2)] = args[index + 1];
  }
  if (!options.binary || !options.out) throw new Error('--binary and --out are required');
  const version = /^version\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(path.join(root, 'crates/keepwork-mcp/Cargo.toml'), 'utf8'))?.[1];
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  const result = packageWin7Runtime({ binary: path.resolve(options.binary), output: options.out,
    expected: { version, commit, sourceHash: identity.sourceFingerprint(root) } });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
if (require.main === module) {
  try { main(); } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
module.exports = { packageWin7Runtime, main, BASE };
