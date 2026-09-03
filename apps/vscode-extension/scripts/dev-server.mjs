import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { context } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(here, '..');
const port = 8089;
const baseUrl = `http://127.0.0.1:${port}`;
const cliPath = path.join(extensionRoot, 'dist/cli.js');
let serverProcess;
let buildContext;
let restarting = Promise.resolve();

function readToken() {
  const tokenFile = path.join(homedir(), '.keepwork-mcp', 'token');
  return fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
}

async function stopRunningDaemon() {
  try {
    const health = await fetch(`${baseUrl}/health`);
    const status = await health.json();
    if (status.name !== 'keepwork-mcp') {
      throw new Error(`port ${port} is occupied by another service`);
    }
    const token = readToken();
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const response = await fetch(`${baseUrl}/admin/stop`, { method: 'POST', headers });
    if (!response.ok) throw new Error(`unable to stop the existing daemon (HTTP ${response.status})`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  } catch (error) {
    if (error?.cause?.code === 'ECONNREFUSED') return;
    throw error;
  }
}

function stopChild(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill('SIGTERM');
  });
}

async function restartServer() {
  await stopChild(serverProcess);
  serverProcess = spawn(process.execPath, [cliPath, '--port', String(port)], {
    cwd: extensionRoot,
    stdio: 'inherit',
  });
  serverProcess.once('exit', (code) => {
    if (code && code !== 0) console.error(`[dev-server] MCP server exited with code ${code}`);
  });
}

async function shutdown(code = 0) {
  await buildContext?.dispose();
  await stopChild(serverProcess);
  process.exit(code);
}

async function main() {
  await stopRunningDaemon();
  fs.rmSync(path.dirname(cliPath), { recursive: true, force: true });

  buildContext = await context({
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    sourcemap: true,
    legalComments: 'none',
    logLevel: 'info',
    entryPoints: [path.join(extensionRoot, 'src/cli.ts')],
    outfile: cliPath,
    external: ['node-pty'],
    plugins: [{
      name: 'restart-keepwork-mcp',
      setup(build) {
        build.onEnd((result) => {
          if (result.errors.length) return;
          restarting = restarting.then(restartServer).catch((error) => {
            console.error(`[dev-server] ${error.message}`);
          });
        });
      },
    }],
  });
  await buildContext.watch();
  process.stdout.write('Watching shared MCP and VS Code CLI sources\n');
}

process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });

main().catch((error) => {
  console.error(`[dev-server] ${error.message}`);
  void shutdown(1);
});
