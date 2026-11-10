#!/usr/bin/env node
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const port = Number(process.env.KEEPWORK_MCP_PORT || 8089);
const baseUrl = `http://127.0.0.1:${port}`;

function readToken() {
  const tokenFile = path.join(os.homedir(), '.keepwork-mcp', 'token');
  return fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
}

async function stopRunningDaemon() {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return;
    const health = await res.json().catch(() => ({}));
    if (health.name !== 'keepwork-mcp') {
      console.warn(`[dev-server] Warning: port ${port} is occupied by another service:`, health);
      return;
    }
    console.log(`[dev-server] Stopping existing ${health.runtimeEngine || 'mcp'} daemon on port ${port} (pid ${health.pid})...`);
    const token = readToken();
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    await fetch(`${baseUrl}/admin/stop`, { method: 'POST', headers, signal: AbortSignal.timeout(1000) }).catch(() => {});

    // Poll until port is released
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 100));
      try {
        await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(200) });
      } catch {
        console.log(`[dev-server] Previous daemon stopped.`);
        return;
      }
    }
  } catch {
    // Port not responding, nothing to stop
  }
}

async function main() {
  await stopRunningDaemon();

  const manifestPath = path.resolve(__dirname, '..', 'crates', 'keepwork-mcp', 'Cargo.toml');
  const args = ['run', '--manifest-path', manifestPath, '--', '--port', String(port), ...process.argv.slice(2)];

  console.log(`[dev-server] Starting Rust MCP server: cargo ${args.join(' ')}`);
  const child = spawn('cargo', args, {
    stdio: 'inherit',
    env: { ...process.env, RUST_LOG: process.env.RUST_LOG || 'info' }
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (child.exitCode === null) {
        child.kill(signal);
      }
    });
  }

  child.on('exit', (code) => {
    process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error('[dev-server] Failed to start:', err);
  process.exit(1);
});
