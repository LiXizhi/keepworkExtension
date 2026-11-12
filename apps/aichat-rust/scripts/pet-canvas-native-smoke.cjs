// Real native window geometry, using only an isolated hidden blank WebView.
// Requires a desktop session and at least two connected displays. Exit 77 is
// an explicit environment skip; it is not a cross-monitor verification pass.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const baseline = process.argv.slice(2);
if (baseline.some(value => value !== '--baseline')) throw Error('Usage: node scripts/pet-canvas-native-smoke.cjs [--baseline]');
const built = spawnSync('cargo', ['build', '--manifest-path', 'src-tauri/Cargo.toml', '--features', 'dev-bins', '--bin', 'pet-canvas-smoke', '--offline'], {
  cwd: appRoot, stdio: 'inherit', timeout: 300000,
});
if (built.error) throw built.error;
if (built.status !== 0) process.exit(built.status || 1);
const binary = path.join(appRoot, 'src-tauri', 'target', 'debug', `pet-canvas-smoke${process.platform === 'win32' ? '.exe' : ''}`);
const checked = spawnSync(binary, baseline, { cwd: appRoot, stdio: 'inherit', timeout: 25000 });
if (checked.error) throw checked.error;
process.exit(checked.status ?? 1);
