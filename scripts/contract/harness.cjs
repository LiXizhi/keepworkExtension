#!/usr/bin/env node
/**
 * Contract harness: start either engine on loopback and talk to it like a client.
 *
 *   KEEPWORK_MCP_TEST_BIN=<path to keepwork-mcp>   Rust daemon under test
 *   apps/mcp-runtime/dist/cli.cjs                  Node reference daemon (optional)
 *
 * Every test gets its own HOME so tokens/instance files never touch the user's
 * profile, and each server runs on a free port so both engines can run at once.
 */
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const binaryName = process.platform === 'win32' ? 'keepwork-mcp.exe' : 'keepwork-mcp';
const defaultRustBin = path.join(repoRoot, 'apps', 'mcp-rust', 'target', 'release', binaryName);
const nodeEntry = path.join(repoRoot, 'apps', 'mcp-runtime', 'dist', 'cli.cjs');

function rustBinary() {
  const candidate = process.env.KEEPWORK_MCP_TEST_BIN || defaultRustBin;
  if (!fs.existsSync(candidate)) {
    throw new Error(`Rust daemon not built: ${candidate}. Run: cargo build --release --manifest-path apps/mcp-rust/Cargo.toml`);
  }
  return candidate;
}

function hasNodeReference() {
  return fs.existsSync(nodeEntry);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function isolatedHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kp-contract-'));
}

async function waitForHealth(port, timeoutMs = 10_000, signal) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      const timeout = AbortSignal.timeout(Math.min(1000, deadline - Date.now()));
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (response.ok) return await response.json();
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`daemon on :${port} did not become healthy: ${lastError || 'timeout'}`);
}

function spawnDaemon(command, args, { home, port, env }) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      KEEPWORK_MCP_PORT: String(port),
      KEEPWORK_MCP_HOST_KIND: 'standalone',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Give only this test-owned daemon a process group for bounded fallback
    // cleanup. Windows uses taskkill /T on this exact child's PID instead.
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => {
    child.once('error', (error) => resolve({ error }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const closed = new Promise((resolve) => child.once('close', () => resolve(true)));
  return { child, exited, closed, output: () => output };
}

async function within(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function running(child) {
  return child.pid && child.exitCode === null && child.signalCode === null;
}

async function killOwnedTree(child) {
  if (process.platform === 'win32') {
    await new Promise((resolve, reject) => {
      execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true, timeout: 5000,
      }, error => error && running(child) ? reject(error) : resolve());
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

async function stopDaemon(daemon, { home, port, ownsEndpoint, removeHome }) {
  const { child } = daemon;
  try {
    if (running(child) && ownsEndpoint) {
      // SIGTERM force-kills on Windows and bypasses Rust's native CLI cleanup.
      // The admin route closes/reaps owned consumers on both engines first.
      try {
        const token = fs.readFileSync(path.join(home, '.keepwork-mcp', 'token'), 'utf8').trim();
        const response = await fetch(`http://127.0.0.1:${port}/admin/stop`, {
          method: 'POST', headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(2000),
        });
        await response.arrayBuffer();
        if (response.ok) await within(daemon.exited, 5000);
      } catch { /* Failed startup or an unresponsive peer: terminate our tree. */ }
    }
    if (running(child)) await killOwnedTree(child);
    if (!await within(daemon.exited, 5000)) throw new Error(`test daemon ${child.pid} did not exit`);
    if (!await within(daemon.closed, 1000)) {
      child.stdout.destroy();
      child.stderr.destroy();
      throw new Error(`test daemon ${child.pid} left stdio open`);
    }
  } finally {
    if (removeHome) await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

async function startDaemon(engine, command, extraArgs, env, { home: providedHome, port: providedPort } = {}) {
  const port = providedPort ?? await freePort();
  // A caller-provided fixture profile survives stop/restart. Its caller owns
  // final deletion; the harness only deletes HOME directories it allocated.
  const home = providedHome ?? isolatedHome();
  const daemon = spawnDaemon(command, [...extraArgs, '--port', String(port)], { home, port, env });
  let ownsEndpoint = false, stopping;
  const stop = () => stopping ||= stopDaemon(daemon, { home, port, ownsEndpoint, removeHome: providedHome === undefined });
  const controller = new AbortController();
  let health;
  try {
    health = await Promise.race([
      waitForHealth(port, 10_000, controller.signal),
      daemon.exited.then(result => { throw result.error || new Error(`test daemon exited before health: ${JSON.stringify(result)}`); }),
    ]);
    // Never send /admin/stop to a different daemon that won a free-port race.
    if (health.pid !== daemon.child.pid) throw new Error(`port ${port} belongs to another daemon`);
    ownsEndpoint = true;
  } catch (error) {
    try { await stop(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'test daemon startup and cleanup failed'); }
    throw error;
  } finally {
    controller.abort();
  }
  return {
    engine, port, home, health,
    base: `http://127.0.0.1:${port}`,
    output: daemon.output,
    stop,
  };
}

async function startRust({ requireAuth = false, env = {}, home, port } = {}) {
  return startDaemon('rust', rustBinary(), requireAuth ? ['--require-auth'] : [], env, { home, port });
}

async function startNode() {
  if (!hasNodeReference()) return null;
  return startDaemon('node', process.execPath, [nodeEntry], {});
}

async function mcpInitialize(base, { streamed = false } = {}) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: streamed ? { experimental: { 'keepwork/streamedResponses': { version: 1 } } } : {},
        clientInfo: { name: 'contract', version: '1' },
      },
    }),
  });
  const text = await response.text();
  const session = response.headers.get('mcp-session-id');
  return { response, text, session };
}

async function mcpRequest(base, session, payload) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': session,
    },
    body: JSON.stringify(payload),
  });
  return { response, text: await response.text() };
}

function parseSse(text) {
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => {
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))
        .join('\n');
      return { event: /event: (\S+)/.exec(frame)?.[1], data: JSON.parse(data) };
    });
}

module.exports = {
  repoRoot,
  rustBinary,
  hasNodeReference,
  freePort,
  isolatedHome,
  waitForHealth,
  startRust,
  startNode,
  mcpInitialize,
  mcpRequest,
  parseSse,
};
