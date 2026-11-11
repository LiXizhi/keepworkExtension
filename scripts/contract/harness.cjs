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
const { spawn } = require('node:child_process');
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

async function waitForHealth(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
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
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  return { child, exited, output: () => output };
}

async function startRust({ requireAuth = false, env = {} } = {}) {
  const port = await freePort();
  const home = isolatedHome();
  const args = ['--port', String(port)];
  if (requireAuth) args.push('--require-auth');
  const daemon = spawnDaemon(rustBinary(), args, { home, port, env });
  const health = await waitForHealth(port);
  return {
    engine: 'rust',
    port,
    home,
    base: `http://127.0.0.1:${port}`,
    health,
    output: daemon.output,
    async stop() {
      daemon.child.kill('SIGTERM');
      const result = await Promise.race([
        daemon.exited,
        new Promise((resolve) => setTimeout(() => resolve({ code: 'timeout' }), 5000)),
      ]);
      if (result.code === 'timeout') daemon.child.kill('SIGKILL');
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

async function startNode() {
  if (!hasNodeReference()) return null;
  const port = await freePort();
  const home = isolatedHome();
  const daemon = spawnDaemon(process.execPath, [nodeEntry, '--port', String(port)], { home, port });
  const health = await waitForHealth(port);
  return {
    engine: 'node',
    port,
    home,
    base: `http://127.0.0.1:${port}`,
    health,
    output: daemon.output,
    async stop() {
      daemon.child.kill('SIGTERM');
      await Promise.race([
        daemon.exited,
        new Promise((resolve) => setTimeout(() => { daemon.child.kill('SIGKILL'); resolve(); }, 5000)),
      ]);
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
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
