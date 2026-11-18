// Manual differential observation only; never a release acceptance receipt.
// Consume the Rust diagnostic's manifest so scripts, arguments, input bytes,
// and deadlines cannot silently drift between the two native PTY adapters.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const cap = 65536;
const cleanupMs = 2000;
const phaseEnv = 'KEEPWORK_PTY_DIAGNOSTIC_BREADCRUMB';
const output = path.resolve(process.argv[2] || '.test-runtime/pty-diagnostic');
const manifest = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'));
const writeJson = (name, value) => fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function worker(testCase, fixture) {
  const start = performance.now();
  const elapsed = () => Math.round((performance.now() - start) * 1000) / 1000;
  const cwd = path.join(fixture, 'workspace', '中文 folder');
  const phaseFile = path.join(fixture, 'phases.txt');
  fs.mkdirSync(cwd, { recursive: true });
  const tracePath = path.join(output, `node-${testCase.name}.raw`);
  fs.writeFileSync(tracePath, Buffer.alloc(0));
  writeJson(`node-${testCase.name}.pending.json`, { diagnosticOnly: true, case: testCase, stage: 'before-spawn', workerPid: process.pid });
  const result = {
    diagnosticOnly: true, acceptance: false, engine: 'node-pty',
    case: testCase, nodeArch: process.arch, nodeVersion: process.version,
    parentPrecondition: { ignoreCtrlC: 'unknown: JS does not set the native inherited flag', allocatedConsole: false },
    profileEnvironment: 'unchanged; -NoProfile; private disposable-runner cwd',
    byteFidelity: testCase.plain ? 'raw stdout/stderr bytes, merged arrival order' : 'node-pty Windows exposes UTF-8 decoded strings; base64 is UTF-8 reencoding',
    chunks: [], phaseObservations: [], input: null, childExit: null,
  };
  let total = 0;
  const buffers = [];
  let captured = 0;
  let terminal;
  let child;
  let closed = false;
  let exitObserved = false;
  let lastPhase = '';
  function receive(value) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
    if (result.firstByteMs === undefined) result.firstByteMs = elapsed();
    total += bytes.length;
    const keep = bytes.subarray(0, cap - captured);
    if (keep.length) { buffers.push(keep); captured += keep.length; fs.appendFileSync(tracePath, keep); }
    if (result.chunks.length < 2048) result.chunks.push({ elapsedMs: elapsed(), bytes: bytes.length });
  }
  try {
    const env = { ...process.env, TERM: 'xterm-256color', [phaseEnv]: phaseFile };
    if (testCase.plain) {
      child = spawn(manifest.shell, testCase.args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      child.stdout.on('data', receive);
      child.stderr.on('data', receive);
      child.on('error', error => { result.spawnError = error.message; });
      child.on('exit', (code, signal) => {
        exitObserved = true;
        result.childExit = { code, signal, elapsedMs: elapsed() };
      });
      child.on('close', () => { closed = true; });
      result.childPid = child.pid;
    } else {
      const pty = require('node-pty');
      result.nodePtyVersion = require('node-pty/package.json').version;
      result.backend = { useConpty: true, useConptyDll: false, conptyInheritCursor: false };
      terminal = pty.spawn(manifest.shell, testCase.args, {
        cwd, env, name: 'xterm-256color', rows: 24, cols: 80,
        useConpty: true, useConptyDll: false, conptyInheritCursor: false,
      });
      result.childPid = terminal.pid;
      terminal.onData(receive);
      terminal.onExit(event => {
        exitObserved = true;
        closed = true;
        result.childExit = { ...event, elapsedMs: elapsed() };
      });
    }
    result.spawnedMs = elapsed();
    let sent = false;
    while (elapsed() < testCase.budgetMs && !result.spawnError) {
      if (!sent && testCase.inputAfterMs !== null && elapsed() >= testCase.inputAfterMs) {
        sent = true;
        result.input = { requestedMs: elapsed(), dataBase64: Buffer.from(testCase.input, 'utf8').toString('base64'), completed: false };
        try {
          terminal.write(testCase.input);
          result.input.completed = true;
          result.input.completedMs = elapsed();
          result.input.note = 'write accepted by node-pty; actual pipe completion is not exposed';
        } catch (error) { result.input.error = error.message; }
      }
      const phases = fs.existsSync(phaseFile) ? fs.readFileSync(phaseFile, 'utf8') : '';
      if (phases !== lastPhase) {
        result.phaseObservations.push({ elapsedMs: elapsed(), text: phases });
        lastPhase = phases;
      }
      if (testCase.plain && exitObserved) break;
      await delay(20);
    }
  } catch (error) {
    result.spawnError = error.stack || error.message;
  } finally {
    result.observationMs = elapsed();
    result.deadlineReached = result.observationMs >= testCase.budgetMs;
    result.childExitBeforeCleanup = result.childExit;
    // Only the process freshly spawned by this worker is eligible for kill.
    // node-pty kill also closes this worker's own ConPTY input/master handles.
    result.cleanup = { requestedMs: elapsed(), completed: false };
    try {
      if (terminal) {
        terminal.kill();
        result.cleanup.masterCloseRequested = true;
        result.cleanup.note = 'cleanup requested through the owned node-pty API; no raw PID kill';
      }
      if (child && !exitObserved) result.cleanup.ownedChildKillRequested = child.kill();
      const cleanupDeadline = performance.now() + cleanupMs;
      while (!closed && performance.now() < cleanupDeadline) await delay(20);
      result.cleanup.completed = closed;
      result.cleanup.finishedMs = elapsed();
    } catch (error) { result.cleanup.error = error.stack || error.message; }
    const bytes = Buffer.concat(buffers);
    result.output = bytes.toString('utf8');
    result.outputBase64 = bytes.toString('base64');
    result.outputBytes = total;
    result.outputTruncated = total > captured;
    result.promptObserved = result.output.includes('PS ') && result.output.includes('中文 folder>');
    result.phaseFile = fs.existsSync(phaseFile) ? fs.readFileSync(phaseFile, 'utf8') : null;
    writeJson(`node-${testCase.name}.json`, result);
    process.stdout.write(JSON.stringify(result) + '\n');
  }
}

async function coordinator() {
  const cases = [];
  for (const testCase of manifest.cases) {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-node-pty-diag-'));
    const logPath = path.join(output, `node-${testCase.name}.log`);
    const log = fs.openSync(logPath, 'w');
    const start = performance.now();
    const child = spawn(process.execPath, [__filename, output, '--case', testCase.name, fixture], { stdio: ['ignore', log, log], windowsHide: true });
    const state = await new Promise(resolve => {
      let done = false;
      let watchdogTerminated = false;
      const finish = value => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
      const timer = setTimeout(() => {
        watchdogTerminated = true;
        child.kill();
        setTimeout(() => finish({ watchdogTerminated: true, exitCode: null, exitUnconfirmed: true }), 1000);
      }, testCase.budgetMs + cleanupMs + 2000);
      child.on('error', error => finish({ spawnError: error.message }));
      child.on('exit', (exitCode, signal) => finish({ exitCode, signal, watchdogTerminated }));
    });
    fs.closeSync(log);
    const resultPath = path.join(output, `node-${testCase.name}.json`);
    const result = fs.existsSync(resultPath)
      ? JSON.parse(fs.readFileSync(resultPath, 'utf8'))
      : { diagnosticOnly: true, case: testCase, resultMissing: true };
    if (result.resultMissing) {
      const tracePath = path.join(output, `node-${testCase.name}.raw`);
      const trace = fs.existsSync(tracePath) ? fs.readFileSync(tracePath) : Buffer.alloc(0);
      result.pendingOutput = trace.toString('utf8');
      result.pendingOutputBase64 = trace.toString('base64');
      const phaseFile = path.join(fixture, 'phases.txt');
      result.pendingPhases = fs.existsSync(phaseFile) ? fs.readFileSync(phaseFile, 'utf8') : null;
    }
    result.worker = { ...state, elapsedMs: Math.round(performance.now() - start) };
    try {
      fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3 });
      result.fixtureRemoved = true;
    } catch (error) { result.fixtureRemoved = false; result.fixtureCleanupError = error.message; }
    writeJson(`node-${testCase.name}.json`, result);
    cases.push(result);
  }
  writeJson('node-report.json', { diagnosticOnly: true, acceptance: false, cases });
  process.stdout.write(`Diagnostic observations saved to ${output}; these do not satisfy release acceptance.\n`);
}

if (process.platform !== 'win32') throw new Error('This manual diagnostic requires a native Windows runner');
if (manifest.diagnosticOnly !== true || manifest.acceptance !== false) throw new Error('Expected the Rust diagnostic-only case manifest');
if (process.argv[3] === '--case') {
  const testCase = manifest.cases.find(item => item.name === process.argv[4]);
  if (!testCase) throw new Error('Unknown diagnostic case');
  worker(testCase, process.argv[5]).then(() => process.exit(0), error => { console.error(error); process.exit(1); });
} else {
  coordinator().catch(error => { console.error(error); process.exitCode = 1; });
}
