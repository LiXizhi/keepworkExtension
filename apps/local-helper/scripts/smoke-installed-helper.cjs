#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const timeoutMs = 60_000;
const originHeaders = { Origin: 'http://localhost:3000' };

async function waitForJson(url, validate) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers: originHeaders });
      if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
      const body = await response.json();
      validate(body);
      return body;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  throw lastError || new Error(`${url} timed out`);
}

async function main() {
  const fixture = path.resolve(process.argv[2] || '');
  if (!fs.statSync(fixture, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`speaker fixture not found: ${fixture}`);
  }
  await waitForJson('http://127.0.0.1:8089/health', body => {
    if (!body.ok || body.name !== 'keepwork-mcp' || body.hostKind !== 'local-helper') {
      throw new Error(`unexpected MCP health: ${JSON.stringify(body)}`);
    }
  });
  const health = await waitForJson('http://127.0.0.1:18089/v1/health', body => {
    if (body.service !== 'keepwork-local-model' || body.status !== 'ok' || body.protocolVersion !== '1.0.0') {
      throw new Error(`unexpected local-model health: ${JSON.stringify(body)}`);
    }
    const model = body.models?.find(item => item.id === 'speaker-eres2net-base-zh-16k');
    if (!model?.installed || !model?.trusted) throw new Error(`local-model is not trusted: ${JSON.stringify(body)}`);
  });
  const models = await waitForJson('http://127.0.0.1:18089/v1/models', body => {
    const model = body.models?.find(item => item.id === 'speaker-eres2net-base-zh-16k');
    if (!model?.installed || !model?.trusted) throw new Error(`speaker model is unavailable: ${JSON.stringify(body)}`);
  });
  const form = new FormData();
  form.append('metadata', JSON.stringify({ encoding: 'wav' }));
  form.append('audio', new Blob([fs.readFileSync(fixture)], { type: 'audio/wav' }), 'speaker-smoke.wav');
  const embeddingResponse = await fetch('http://127.0.0.1:18089/v1/speaker/embedding', {
    method: 'POST',
    headers: { ...originHeaders, 'X-Request-Id': 'installed-helper-smoke' },
    body: form,
  });
  if (!embeddingResponse.ok) {
    throw new Error(`embedding returned HTTP ${embeddingResponse.status}: ${await embeddingResponse.text()}`);
  }
  const embedding = await embeddingResponse.json();
  if (embedding.dimension !== 512 || embedding.embedding?.length !== 512 || embedding.normalized !== true) {
    throw new Error(`unexpected embedding response: ${JSON.stringify(embedding)}`);
  }
  process.stdout.write(`installed helper smoke passed: MCP ${health.service ? 'ok' : 'ok'}, ${models.models.length} model(s), 512 dimensions\n`);
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
