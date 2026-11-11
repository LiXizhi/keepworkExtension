#!/usr/bin/env node
/**
 * Smoke test for the Rust daemon: start it on a free loopback port with an
 * isolated HOME, complete an MCP handshake, then stop it through /admin/stop.
 * Usage: node apps/mcp-rust/scripts/smoke.cjs [path-to-binary]
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const binaryName = process.platform === 'win32' ? 'keepwork-mcp.exe' : 'keepwork-mcp';
const binary = path.resolve(process.argv[2] || path.join(appRoot, 'target', 'release', binaryName));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  return { response, text, json: text ? JSON.parse(text) : null };
}

async function main() {
  if (!fs.existsSync(binary)) throw new Error(`missing binary: ${binary} (run cargo build --release)`);
  const port = await freePort();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-rust-smoke-'));
  const child = spawn(binary, ['--port', String(port)], {
    env: { ...process.env, HOME: home, USERPROFILE: home, KEEPWORK_MCP_HOST_KIND: 'standalone' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));

  try {
    const base = `http://127.0.0.1:${port}`;
    let health = null;
    for (let attempt = 0; attempt < 100 && !health; attempt += 1) {
      try {
        health = (await fetchJson(`${base}/health`)).json;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    if (!health) throw new Error(`daemon never became healthy:\n${log}`);
    if (health.name !== 'keepwork-mcp' || health.hostKind !== 'standalone' || health.runtimeEngine !== 'rust') {
      throw new Error(`unexpected health payload: ${JSON.stringify(health)}`);
    }

    const init = await fetchJson(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } },
      }),
    });
    const session = init.response.headers.get('mcp-session-id');
    if (!session) throw new Error(`initialize did not create a session: ${init.text}`);

    const list = await fetchJson(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'mcp-session-id': session },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    const names = list.json.result.tools.map((tool) => tool.name);
    if (!names.includes('mcp_status')) throw new Error(`tools/list missing mcp_status: ${names.join(',')}`);

    const call = await fetchJson(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'mcp-session-id': session },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'mcp_status', arguments: {} } }),
    });
    if (!String(call.json.result.content[0].text).includes('keepwork-mcp 0.1.2')) {
      throw new Error('mcp_status returned an unexpected body');
    }

    await fetchJson(`${base}/admin/stop`, { method: 'POST' });
    const code = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve('timeout'), 5000))]);
    if (code !== 0) throw new Error(`daemon did not exit cleanly: ${code}`);
    process.stdout.write('keepwork-mcp: OK\n');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
