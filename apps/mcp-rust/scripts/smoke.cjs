#!/usr/bin/env node
/** An owned, bounded daemon smoke. Never sends shutdown to an unverified peer. */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { readBuildInfo } = require('../../../scripts/lib/rust-runtime-identity.cjs');

const appRoot = path.resolve(__dirname, '..');
const binaryName = process.platform === 'win32' ? 'keepwork-mcp.exe' : 'keepwork-mcp';
const defaultBinary = path.join(appRoot, 'target', 'release', binaryName);

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function fetchJson(url, init = {}, timeoutMs = 2000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(Error('Smoke HTTP request timed out')), timeoutMs);
  try {
    const response = await fetch(url, { ...init, redirect: 'error', signal: controller.signal });
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body || []) {
      size += chunk.length;
      if (size > 1024 * 1024) {
        controller.abort();
        const error = Error('Smoke HTTP response exceeded 1 MiB');
        error.code = 'SMOKE_RESPONSE_TOO_LARGE';
        throw error;
      }
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (!response.ok) throw Error('Smoke HTTP status ' + response.status);
    return { response, text, json: text ? JSON.parse(text) : null };
  } finally { clearTimeout(timer); }
}

async function within(promise, timeoutMs) {
  let timer;
  try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

function samePath(left, right) {
  if (typeof left !== 'string') return false;
  const normalize = value => path.resolve(value).replace(/^\\\\\?\\/, '');
  return process.platform === 'win32' ? normalize(left).toLowerCase() === normalize(right).toLowerCase() : normalize(left) === normalize(right);
}

async function runSmoke({ binary = defaultBinary, args = [], expectedBuildInfo, env = {}, port: requestedPort, startupTimeoutMs = 5000, requestTimeoutMs = 2000, shutdownTimeoutMs = 5000 } = {}) {
  binary = path.resolve(binary);
  if (!fs.existsSync(binary)) throw Error(`missing binary: ${binary} (run cargo build --release)`);
  const expected = expectedBuildInfo || readBuildInfo(binary);
  if (expected.product !== 'keepwork-mcp-runtime' || expected.engine !== 'rust' || !expected.version || !expected.commit) throw Error('Smoke requires a Rust runtime build identity');
  const port = requestedPort ?? await freePort();
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 8089) throw Error('Smoke requires an isolated port other than shared 8089');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-rust-smoke-'));
  const workspace = path.join(home, 'workspace');
  fs.mkdirSync(workspace);
  // Match Rust canonicalize on Windows too: the JS realpath implementation
  // can retain an 8.3 name such as RUNNER~1 while the native API expands it.
  const actualWorkspace = fs.realpathSync.native(workspace);
  const childEnv = { ...process.env, ...env, HOME: home, USERPROFILE: home, KEEPWORK_MCP_HOST_KIND: 'standalone' };
  // Observe the compiled identity, not enclosing desktop metadata overrides.
  for (const key of ['KEEPWORK_MCP_RUNTIME_VERSION', 'KEEPWORK_MCP_RUNTIME_COMMIT', 'KEEPWORK_MCP_RUNTIME_BUILT_AT', 'KEEPWORK_MCP_HOST_VERSION']) delete childEnv[key];
  const child = spawn(binary, [...args, '--port', String(port), '--root', actualWorkspace], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  const capture = chunk => { log = (log + chunk.toString()).slice(-65536); };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  let spawnError;
  const exited = new Promise(resolve => {
    child.once('error', error => { spawnError = error; resolve({ error }); });
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const closed = new Promise(resolve => child.once('close', () => resolve(true)));
  const running = () => !!child.pid && child.exitCode === null && child.signalCode === null;
  const base = `http://127.0.0.1:${port}`;
  const assertChild = () => {
    if (spawnError) throw spawnError;
    if (!running()) throw Error('Smoke child exited before the operation completed');
  };
  const ownedHealth = async timeoutMs => {
    assertChild();
    const health = (await fetchJson(base + '/health', {}, timeoutMs ?? requestTimeoutMs)).json;
    assertChild();
    if (health?.pid !== child.pid || health?.name !== 'keepwork-mcp' || health?.runtimeEngine !== 'rust' || health?.runtimeProduct !== 'keepwork-mcp-runtime' || health?.hostKind !== 'standalone' || !samePath(health?.workspaceRoot, actualWorkspace) || health?.runtimeVersion !== expected.version || health?.runtimeCommit !== expected.commit) {
      const error = Error('Smoke endpoint ownership or identity mismatch; no shutdown request was sent');
      error.code = 'SMOKE_OWNERSHIP_MISMATCH';
      throw error;
    }
    return health;
  };
  // Revalidate before every POST, including shutdown: once-owned is not proof
  // after a process or port replacement.
  const ownedPost = async (route, payload, headers = {}) => {
    const health = await ownedHealth();
    const authentication = {};
    if (health.requireAuth === true) {
      const file = path.join(home, '.keepwork-mcp', 'token');
      const info = fs.lstatSync(file);
      if (!info.isFile() || info.size < 1 || info.size > 4096) throw Error('Invalid isolated smoke authentication token file');
      const token = fs.readFileSync(file, 'utf8').trim();
      if (!token || /[\r\n]/.test(token)) throw Error('Invalid isolated smoke authentication token');
      authentication.authorization = 'Bearer ' + token;
    }
    return fetchJson(base + route, { method: 'POST', headers: { 'content-type': 'application/json', ...headers, ...authentication }, body: payload === undefined ? undefined : JSON.stringify(payload) }, requestTimeoutMs);
  };
  let failure;
  let result;
  try {
    if (!child.pid) {
      const initial = await within(exited, startupTimeoutMs);
      throw initial?.error || Error('Smoke child did not start');
    }
    const deadline = Date.now() + startupTimeoutMs;
    let health, lastError;
    while (!health && Date.now() < deadline) {
      assertChild();
      try {
        health = await Promise.race([
          ownedHealth(Math.max(1, Math.min(requestTimeoutMs, deadline - Date.now()))),
          exited.then(exit => { throw exit.error || Error('Smoke child exited during startup: ' + JSON.stringify(exit)); }),
        ]);
      } catch (error) {
        if (error.code === 'SMOKE_OWNERSHIP_MISMATCH' || error.code === 'SMOKE_RESPONSE_TOO_LARGE' || spawnError || !running()) throw error;
        lastError = error;
        await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(0, deadline - Date.now()))));
      }
    }
    if (!health) throw Error('Smoke startup timed out: ' + (lastError?.message || 'no health response'));
    const init = await ownedPost('/mcp', {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } },
    }, { accept: 'application/json, text/event-stream' });
    const session = init.response.headers.get('mcp-session-id');
    if (!session) throw Error('initialize did not create a session');
    const list = await ownedPost('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-session-id': session });
    const names = list.json?.result?.tools?.map(tool => tool.name);
    if (!names?.includes('mcp_status')) throw Error('tools/list missing mcp_status');
    const call = await ownedPost('/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'mcp_status', arguments: {} } }, { 'mcp-session-id': session });
    if (!String(call.json?.result?.content?.[0]?.text).includes('keepwork-mcp 0.1.2')) throw Error('mcp_status returned an unexpected body');
    await ownedPost('/admin/stop');
    const exit = await within(exited, shutdownTimeoutMs);
    if (!exit || exit.error || exit.code !== 0) throw Error('Smoke daemon did not exit cleanly: ' + JSON.stringify(exit));
    result = { health, port, binary, profile: home };
  } catch (error) { failure = error; }
  try {
    // Only the Child handle allocated above may be signalled. Reap it before
    // deleting its profile; never terminate a PID obtained from HTTP metadata.
    if (running()) child.kill('SIGTERM');
    if (!await within(exited, shutdownTimeoutMs) || running()) {
      if (running()) child.kill('SIGKILL');
      if (!await within(exited, shutdownTimeoutMs) || running()) throw Error('Owned smoke child did not exit; temporary profile retained at ' + home);
    }
    if (!await within(closed, shutdownTimeoutMs)) {
      child.stdout.destroy(); child.stderr.destroy();
      throw Error('Owned smoke child left stdio open; temporary profile retained at ' + home);
    }
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch (error) { failure = failure ? new AggregateError([failure, error], 'Smoke operation and owned cleanup failed') : error; }
  if (failure) { failure.profile = home; failure.childPid = child.pid; failure.daemonLog = log; throw failure; }
  return result;
}

module.exports = { runSmoke, fetchJson, freePort };
if (require.main === module) {
  if (process.argv.length > 3) { process.stderr.write('Usage: smoke.cjs [path-to-binary]\n'); process.exitCode = 1; }
  else runSmoke({ binary: process.argv[2] || defaultBinary }).then(result => {
    process.stdout.write('keepwork-mcp: OK\n');
    process.stdout.write(JSON.stringify({ runtimeVersion: result.health.runtimeVersion, runtimeCommit: result.health.runtimeCommit, pid: result.health.pid, port: result.port, profileRemoved: !fs.existsSync(result.profile) }) + '\n');
  }).catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
