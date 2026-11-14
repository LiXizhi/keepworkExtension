#!/usr/bin/env node
'use strict';
// Builds only the old-system native launcher. It never compiles or stages Tauri.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { keyHeader } = require('./cef-release.cjs');
const { packageWin7, sourceIsDirty } = require('./package-win7.cjs');
const root = path.resolve(__dirname, '..');

function buildWin7({ mcpDirectory, output, privateKeyFile, makensis, cefDirectory }, { exec = execFileSync, platform = process.platform } = {}) {
  assert.equal(platform, 'win32', 'Build the Win7 edition launcher on Windows with MSVC');
  assert.ok(!fs.existsSync(output), 'Win7 build output must be a new directory');
  const privateKey = fs.readFileSync(privateKeyFile);
  fs.mkdirSync(output, { recursive: true });
  const header = path.join(path.resolve(output), 'release-key.hpp'); fs.writeFileSync(header, keyHeader(privateKey));
  const build = path.join(path.resolve(output), 'bootstrap-build');
  exec('cmake', ['-S', path.join(root, 'windows'), '-B', build, '-A', 'x64',
    '-DKEEPWORK_WIN7_EDITION=ON', '-DKEEPWORK_PUBLIC_KEY_HEADER=' + header], { stdio: 'inherit' });
  exec('cmake', ['--build', build, '--config', 'Release'], { stdio: 'inherit' });
  exec('ctest', ['--test-dir', build, '-C', 'Release', '--output-on-failure'], { stdio: 'inherit' });
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
  const commit = exec('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  return packageWin7({ bootstrap: path.join(build, 'Release', 'Keepwork.exe'),
    licenses: path.join(build, 'Release', 'licenses'), mcpDirectory, output: path.join(output, 'release'),
    privateKey, version, commit, makensis, cefDirectory, sourceDirty: sourceIsDirty(exec) }, { exec });
}
function readArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    assert.ok(['--mcp', '--out', '--key', '--makensis', '--cef'].includes(args[index]) && args[index + 1]
      && !values[args[index]], 'Usage: build-win7.cjs --mcp DIRECTORY --out NEW_DIRECTORY --key PRIVATE.pem [--makensis FILE]');
    values[args[index]] = args[index + 1];
  }
  assert.ok(values['--mcp'] && values['--out'] && values['--key'], '--mcp, --out and --key are required');
  return { mcpDirectory: values['--mcp'], output: values['--out'], privateKeyFile: values['--key'], makensis: values['--makensis'], cefDirectory: values['--cef'] };
}
if (require.main === module) {
  try {
    const result = buildWin7(readArgs(process.argv.slice(2)));
    console.log(JSON.stringify({ installer: result.installer, version: result.version,
      mcpVersion: result.manifest.version, nativeWin7Verified: false }, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { buildWin7, readArgs };
