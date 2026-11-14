#!/usr/bin/env node
// Windows 7/8 edition builds run on a current Windows host with VS C++ tools. Cross-builds must supply their own
// MSVC-compatible compiler/linker and SDK; this script never installs toolchains.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const config = require('../win7-toolchain.json');

function buildCommand({ check = false } = {}) {
  return ['+' + config.toolchain, check ? 'check' : 'build', '--locked', '--release',
    '--manifest-path', path.join(root, 'Cargo.toml'), '--target', config.target,
    '-Z', 'build-std=std,panic_abort', '--features', 'win7-compat', '--bin', 'keepwork-mcp'];
}

function buildEnvironment(environment = process.env) {
  const flags = environment.CARGO_ENCODED_RUSTFLAGS
    ? environment.CARGO_ENCODED_RUSTFLAGS.split('\x1f')
    : (environment.RUSTFLAGS || '').split(/\s+/).filter(Boolean);
  // Avoid requiring the newest VC redistributable on the legacy machine.
  // This is independent of the binary import audit, which remains mandatory.
  flags.push('-C', 'target-feature=+crt-static', '-C', 'link-arg=/SUBSYSTEM:CONSOLE,6.01');
  return { ...environment, CARGO_ENCODED_RUSTFLAGS: flags.join('\x1f') };
}

function main(args = process.argv.slice(2)) {
  if (args.some(arg => arg !== '--check')) throw new Error('Usage: build-win7.cjs [--check]');
  const command = buildCommand({ check: args.includes('--check') });
  // Build with the native standard library for *-win7-windows-msvc. Spoofing a
  // normal Windows target's cfg cannot remove its unsupported std imports.
  execFileSync('cargo', command, { cwd: root, env: buildEnvironment(), stdio: 'inherit' });
  if (!args.includes('--check')) {
    const targetDir = process.env.CARGO_TARGET_DIR
      ? path.resolve(root, process.env.CARGO_TARGET_DIR) : path.join(root, 'target');
    const binary = path.join(targetDir, config.target, 'release', 'keepwork-mcp.exe');
    if (!fs.statSync(binary).isFile()) throw new Error('Win7 build did not produce keepwork-mcp.exe');
    require('../../../scripts/lib/windows7-pe.cjs').auditPe(fs.readFileSync(binary), { arch: 'x64' });
    process.stdout.write(binary + '\n');
  }
}

if (require.main === module) {
  try { main(); } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
module.exports = { buildCommand, buildEnvironment, main, config };
