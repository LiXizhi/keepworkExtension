const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

if (process.platform !== 'darwin') {
  process.stdout.write('[smoke] startup-smoke: SKIP (real AppKit/WKWebView fixture requires macOS)\n');
  process.exit(0);
}

const appRoot = path.resolve(__dirname, '..');
const manifest = path.join(appRoot, 'src-tauri/Cargo.toml');
if (!process.argv.includes('--no-build')) {
  execFileSync('cargo', ['build', '--offline', '--manifest-path', manifest,
    '--features', 'dev-bins', '--bin', 'startup-smoke'], {
    cwd: appRoot, stdio: 'inherit', timeout: 300000, killSignal: 'SIGKILL',
  });
}
const target = process.env.CARGO_TARGET_DIR
  ? path.resolve(appRoot, process.env.CARGO_TARGET_DIR)
  : path.join(appRoot, 'src-tauri/target');
const suppliedExecutable = process.argv.find(arg => arg.startsWith('--executable='))?.slice('--executable='.length);
const executable = suppliedExecutable || path.join(target, 'debug/startup-smoke');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-native-startup-run-'));
try {
  const output = execFileSync(executable, [`--profile-dir=${path.join(scratch, 'profile')}`], {
    cwd: appRoot, encoding: 'utf8', timeout: 90000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024,
  });
  process.stdout.write(output);
  assert.match(output, /startup-smoke: OK/);
  assert.equal(fs.existsSync(path.join(scratch, 'profile')), false, 'the native process must release its isolated profile');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
