#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const adb = (...args) => execFileSync('adb', args, { encoding: 'utf8' }).trim();
const fixture = process.argv[2];
if (!fixture || !fs.statSync(fixture, { throwIfNoEntry: false })?.isFile()) throw new Error('WAV fixture path is required');

async function waitJson(url, validate, attempts = 60) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      const body = await response.json();
      if (response.ok && validate(body)) return body;
      last = new Error(`Unexpected response: ${JSON.stringify(body)}`);
    } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw last || new Error(`Timed out waiting for ${url}`);
}

async function main() {
  adb('forward', 'tcp:8089', 'tcp:8089');
  adb('forward', 'tcp:18089', 'tcp:18089');
  const mcp = await waitJson('http://127.0.0.1:8089/health', value => value.ok && value.name === 'keepwork-mcp');
  assert.equal(mcp.hostKind, 'android-helper');
  assert.deepEqual(mcp.capabilities, ['mcp', 'local-model']);
  const health = await waitJson('http://127.0.0.1:18089/v1/health', value => value.service === 'keepwork-local-model' && value.protocolVersion === '1.0.0');
  const model = health.models.find(item => item.id === 'speaker-eres2net-base-zh-16k');
  assert.equal(model.installed, true);
  assert.equal(model.trusted, true);

  const form = new FormData();
  form.append('metadata', JSON.stringify({ encoding: 'wav', modelId: 'speaker-eres2net-base-zh-16k' }));
  form.append('audio', new Blob([fs.readFileSync(fixture)], { type: 'audio/wav' }), 'fixture.wav');
  const response = await fetch('http://127.0.0.1:18089/v1/speaker/embedding', { method: 'POST', body: form });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.dimension, 512);
  assert.equal(result.embedding.length, 512);
  assert.ok(result.embedding.every(Number.isFinite));
  const norm = Math.sqrt(result.embedding.reduce((sum, value) => sum + value * value, 0));
  assert.ok(Math.abs(norm - 1) < 0.001, `embedding norm was ${norm}`);
  process.stdout.write(`${JSON.stringify({ mcp: mcp.hostVersion, model: result.modelVersion, dimension: result.dimension, norm })}\n`);
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
