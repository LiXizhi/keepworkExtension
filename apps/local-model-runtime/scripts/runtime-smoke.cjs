#!/usr/bin/env node
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');

function stagedRuntimePath() {
  const platform = process.platform === 'win32' ? 'windows' : 'macos';
  return path.join(projectRoot, 'runtime-staging', `${platform}-${process.arch}`);
}

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
      const response = await fetch(`${baseUrl}/v1/health`);
      if (response.ok) return response.json();
      lastError = new Error(`health returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError || new Error('runtime health check timed out');
}

async function verifyEmbedding(baseUrl, runtimePath) {
  const fixtureDir = path.join(runtimePath, 'app', 'tests', 'fixtures');
  const fixtureName = fs.readdirSync(fixtureDir).find(name => name.toLowerCase().endsWith('.wav'));
  const fixture = path.join(fixtureDir, fixtureName || 'missing.wav');
  if (!fs.statSync(fixture, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`runtime speaker fixture not found: ${fixture}`);
  }
  const form = new FormData();
  form.append('metadata', JSON.stringify({ encoding: 'wav' }));
  form.append('audio', new Blob([fs.readFileSync(fixture)], { type: 'audio/wav' }), 'speaker-a.wav');
  const response = await fetch(`${baseUrl}/v1/speaker/embedding`, {
    method: 'POST',
    headers: { Origin: 'http://localhost:3000', 'X-Request-Id': 'packaged-runtime-smoke' },
    body: form,
  });
  if (!response.ok) throw new Error(`runtime embedding returned HTTP ${response.status}: ${await response.text()}`);
  const body = await response.json();
  if (body.dimension !== 512 || body.embedding?.length !== 512 || body.normalized !== true) {
    throw new Error(`unexpected runtime embedding response: ${JSON.stringify(body)}`);
  }
}

async function main() {
  const runtimePath = path.resolve(process.argv[2] || stagedRuntimePath());
  const nodePath = process.platform === 'win32' ? path.join(runtimePath, 'node.exe') : path.join(runtimePath, 'bin', 'node');
  const entry = path.join(runtimePath, 'app', 'dist', 'src', 'cli.js');
  if (!fs.statSync(nodePath, { throwIfNoEntry: false })?.isFile()) throw new Error(`runtime node executable not found: ${nodePath}`);
  if (!fs.statSync(entry, { throwIfNoEntry: false })?.isFile()) throw new Error(`runtime entry not found: ${entry}`);
  if (process.platform !== 'win32') fs.chmodSync(nodePath, 0o755);
  const port = await freePort();
  const child = spawn(nodePath, [entry, 'serve', '--port', String(port)], {
    env: { ...process.env, LOCAL_MODEL_ROOT: path.join(runtimePath, 'app') },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const health = await waitForHealth(baseUrl, child);
    if (health.service !== 'keepwork-local-model' || health.protocolVersion !== '1.0.0') {
      throw new Error(`unexpected health response: ${JSON.stringify(health)}`);
    }
    await verifyEmbedding(baseUrl, runtimePath);
    process.stdout.write(`runtime smoke test passed: ${runtimePath}\n`);
  } finally {
    if (child.exitCode === null) child.kill();
    if (child.exitCode && output) process.stderr.write(output);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
