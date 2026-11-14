const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('native smoke serializes real WMI scalars and preserves a failed manifest check', {
  skip: process.platform !== 'win32' ? 'Requires native Windows PowerShell and WMI; no legacy OS acceptance is inferred.' : false,
}, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-native-report-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'runtime with spaces');
  const output = path.join(root, 'new-report');
  fs.mkdirSync(runtime);
  fs.writeFileSync(path.join(runtime, 'runtime.json'), JSON.stringify({ variant: 'deliberately-invalid-fixture',
    buildTarget: 'x86_64-win7-windows-msvc', platform: 'windows', arch: 'x64', entry: 'bin/keepwork-mcp.exe' }));
  // A pwsh parent must not inject its PowerShell 7 modules into Windows
  // PowerShell. This only changes the test child's environment.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script = path.resolve(__dirname, '../scripts/win7-native-smoke.ps1');
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-RuntimeDirectory', runtime, '-OutputDirectory', output], { env, encoding: 'utf8', timeout: 30000 });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, 'an invalid runtime must never pass smoke');
  const reportFile = path.join(output, 'report.json');
  assert.ok(fs.existsSync(reportFile), result.stdout + result.stderr);
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  assert.equal(report.scope, 'mcp-native-basic-smoke');
  assert.equal(report.passed, false);
  assert.equal(report.nativeLegacyVerified, false);
  assert.equal(report.nativeWin7Verified, false);
  assert.equal(report.cefUiVerified, false);
  assert.match(report.error, /Supply a staged Win7\/Win8 x64 MCP runtime/);
  assert.deepEqual(report.cases, []);
  assert.match(report.system.version, /^\d+\.\d+\.\d+/);
  assert.ok(report.system.caption.length > 0);
  for (const key of ['caption', 'version', 'architecture', 'manufacturer', 'model', 'powershell', 'clr', 'osFamily']) {
    assert.equal(typeof report.system[key], 'string', key);
  }
  for (const key of ['servicePackMajor', 'productType']) assert.equal(typeof report.system[key], 'number', key);
  assert.equal(typeof report.startedAtUtc, 'string');
  assert.equal(typeof report.completedAtUtc, 'string');
  assert.doesNotMatch(result.stdout + result.stderr, /PSParameterizedProperty|circular reference/i);
});
