#!/usr/bin/env node
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const runtimeRoot = path.resolve(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForHealth(baseUrl, child) {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`runtime exited before health check: ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return response.json();
      lastError = new Error(`health returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError || new Error('runtime health check timed out');
}

async function main() {
  const runtimePath = path.resolve(process.argv[2] || path.join(runtimeRoot, 'staging', `${process.platform === 'win32' ? 'windows' : 'macos'}-${process.arch}`));
  const nodePath = process.platform === 'win32' ? path.join(runtimePath, 'node.exe') : path.join(runtimePath, 'bin', 'node');
  const entry = path.join(runtimePath, 'app', 'cli.cjs');
  if (!fs.statSync(nodePath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`runtime node executable not found: ${nodePath}`);
  }
  if (!fs.statSync(entry, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`runtime entry not found: ${entry}`);
  }
  const port = await freePort();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-mcp-runtime-smoke-'));
  const child = spawn(nodePath, [entry, '--port', String(port), '--root', root], {
    env: { ...process.env, KEEPWORK_MCP_REQUIRE_AUTH: '0', KEEPWORK_MCP_HOST_KIND: 'standalone' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let spawnError;
  child.once('error', (error) => { spawnError = error; });
  const closed = new Promise((resolve) => child.once('close', resolve));
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const health = await waitForHealth(baseUrl, child);
    if (health.name !== 'keepwork-mcp' || health.hostKind !== 'standalone') {
      throw new Error(`unexpected health response: ${JSON.stringify(health)}`);
    }
    const createResponse = await fetch(`${baseUrl}/terminal/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: root, cols: 80, rows: 24 }),
    });
    const session = await createResponse.json();
    if (!createResponse.ok || !session.id) throw new Error(`PTY smoke test failed: ${JSON.stringify(session)}`);
    await fetch(`${baseUrl}/terminal/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' });
    await fetch(`${baseUrl}/admin/stop`, { method: 'POST' });
    process.stdout.write(`runtime smoke test passed: ${runtimePath}\n`);
  } finally {
    if (child.exitCode === null) child.kill();
    const forceKill = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { await closed; } finally { clearTimeout(forceKill); }
    // Windows can briefly retain file handles while a PTY process exits.
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    if (child.exitCode && output) process.stderr.write(output);
    if (spawnError) throw spawnError;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
