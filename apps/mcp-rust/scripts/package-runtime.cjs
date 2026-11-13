#!/usr/bin/env node
// Produce reviewable Rust v2 feed artifacts locally; this script never uploads.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const identity = require('../../../scripts/lib/rust-runtime-identity.cjs');
const root = path.resolve(__dirname, '..');
const repo = path.resolve(root, '../..');
const targets = {
  'aarch64-apple-darwin': ['macos', 'arm64'], 'x86_64-apple-darwin': ['macos', 'x64'],
  'aarch64-pc-windows-msvc': ['windows', 'arm64'], 'x86_64-pc-windows-msvc': ['windows', 'x64'],
  'aarch64-unknown-linux-gnu': ['linux', 'arm64'], 'x86_64-unknown-linux-gnu': ['linux', 'x64'],
};

function packageRuntime({ binary, target, output, baseUrl = 'https://cdn.keepwork.com/keepwork/mcp-stable-rs', expected }) {
  if (!targets[target]) throw new Error('Unsupported Rust runtime target');
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Artifact base requires a credential-free HTTPS URL');
  const [platform, arch] = targets[target];
  const info = identity.validateBinary(binary, { triple: target }, expected);
  const buildTime = info.builtAt === undefined ? {} : { builtAt: info.builtAt, builtAtSource: info.builtAtSource };
  if (!/^[a-f0-9]{40}$/.test(info.commit) || !/^[a-f0-9]{64}$/.test(info.sourceHash)) throw new Error('Missing compiled provenance');
  output = path.resolve(output);
  const temporary = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kp-rust-package-'));
  const fileName = `${platform}-${arch}.zip`;
  try {
    const entry = `bin/keepwork-mcp${platform === 'windows' ? '.exe' : ''}`;
    fs.mkdirSync(path.join(temporary, 'bin'));
    fs.copyFileSync(binary, path.join(temporary, entry));
    fs.chmodSync(path.join(temporary, entry), 0o755);
    fs.copyFileSync(path.join(repo, 'LICENSE'), path.join(temporary, 'LICENSE'));
    const runtime = { schemaVersion: 2, product: info.product, engine: 'rust', version: info.version, ...buildTime,
      commit: info.commit, sourceHash: info.sourceHash, platform, arch, entry, args: ['--port', '8089'], env: {},
      health: { url: 'http://127.0.0.1:8089/health', match: { name: 'keepwork-mcp' } } };
    fs.writeFileSync(path.join(temporary, 'runtime.json'), JSON.stringify(runtime, null, 2) + '\n');
    fs.mkdirSync(output, { recursive: true });
    const archive = path.join(output, fileName);
    // The staging directory has fixed, validated names. No URL or path becomes shell code.
    if (fs.existsSync(archive)) throw new Error('Output archive already exists; use a new evidence directory');
    if (process.platform === 'win32') {
      execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
        "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:KP_RUST_ARCHIVE_SOURCE, $env:KP_RUST_ARCHIVE_OUTPUT)"],
      { env: { ...process.env, KP_RUST_ARCHIVE_SOURCE: temporary, KP_RUST_ARCHIVE_OUTPUT: archive }, stdio: 'pipe' });
    } else execFileSync('zip', ['-q', '-r', archive, '.'], { cwd: temporary, stdio: 'pipe' });
    const bytes = fs.readFileSync(archive);
    const manifest = { schemaVersion: 2, product: info.product, engine: 'rust', version: info.version, ...buildTime,
      commit: info.commit, platform, arch, sourceHash: info.sourceHash,
      url: `${baseUrl.replace(/\/$/, '')}/${info.version}/${fileName}`, fileName,
      size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    fs.writeFileSync(path.join(output, `${platform}-${arch}.json`), JSON.stringify(manifest, null, 2) + '\n');
    return { archive, manifest };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

function main(args = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!['--target', '--binary', '--out', '--base-url'].includes(key) || !args[index + 1]) throw new Error('Use --target <triple> --binary <file> --out <directory> [--base-url <HTTPS URL>]');
    options[key.slice(2)] = args[index + 1];
  }
  if (!options.target || !options.binary || !options.out) throw new Error('--target, --binary and --out are required');
  const version = /^version\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(path.join(root, 'crates/keepwork-mcp/Cargo.toml'), 'utf8'))?.[1];
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  const result = packageRuntime({ binary: path.resolve(options.binary), target: options.target, output: options.out,
    baseUrl: options['base-url'], expected: { version, commit, sourceHash: identity.sourceFingerprint(root) } });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
if (require.main === module) { try { main(); } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; } }
module.exports = { packageRuntime, main };
