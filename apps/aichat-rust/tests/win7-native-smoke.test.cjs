const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('native smoke tool requests serialize Join-Path values as plain nested JSON scalars', {
  skip: process.platform !== 'win32' ? 'Requires the actual Windows PowerShell Join-Path and .NET serializer.' : false,
}, t => {
  const source = fs.readFileSync(path.resolve(__dirname, '../scripts/win7-native-smoke.ps1'), 'utf8').replace(/\r\n?/g, '\n');
  const operations = source.match(/foreach \(\$operation in @\(\n([\s\S]*?)\n\s*\)\) \{/)?.[1];
  const request = source.match(/\$reply = Invoke-Owned[^\n]*?'POST' (@\{[^\n]+\}) \$token \$sessionHeaders/)?.[1];
  assert.ok(operations && request, 'execute the real smoke request constructors');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-smoke-json-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, 'requests.jsonl');
  const script = path.join(root, 'serialize-requests.ps1');
  fs.writeFileSync(script, `$ErrorActionPreference = 'Stop'\nSet-StrictMode -Version 2\n` +
    `Add-Type -AssemblyName System.Web.Extensions\n` +
    `$json = New-Object System.Web.Script.Serialization.JavaScriptSerializer\n` +
    `$utf8 = New-Object System.Text.UTF8Encoding -ArgumentList $false\n` +
    // Deliberately retain the actual cmdlet's adapted string at the input.
    // The production request boundary must serialize it as an ordinary cwd.
    `$workspace = Join-Path $env:KEEPWORK_SMOKE_BODY_CASE 'workspace with spaces'\n` +
    `$content = 'WIN7_NATIVE_FILE_ROUNDTRIP'\n` +
    `foreach ($operation in @(\n${operations}\n)) {\n` +
    `  $request = ${request}\n` +
    `  [IO.File]::AppendAllText($env:KEEPWORK_SMOKE_BODY_OUTPUT, $json.Serialize($request) + [char]10, $utf8)\n` +
    `}\n`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
  env.KEEPWORK_SMOKE_BODY_CASE = root;
  env.KEEPWORK_SMOKE_BODY_OUTPUT = output;
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
    { env, encoding: 'utf8', timeout: 30000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const requests = fs.readFileSync(output, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(value => value.id), [3, 4]);
  assert.deepEqual(requests.map(value => value.params.name), ['grep_files', 'run_terminal']);
  assert.equal(requests[0].params.arguments.pattern, 'WIN7_NATIVE_FILE_ROUNDTRIP');
  assert.equal(requests[1].params.arguments.cwd, path.join(root, 'workspace with spaces'));
  assert.equal(typeof requests[1].params.arguments.cwd, 'string');
  assert.equal(requests[1].params.arguments.timeoutMs, 5000);
});

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
