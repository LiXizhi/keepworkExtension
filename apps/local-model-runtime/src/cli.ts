#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ModelRegistry } from './core/registry.js';
import { asLocalModelError, LocalModelError } from './core/errors.js';
import { startHttpService, DEFAULT_PORT } from './transports/http.js';
import { decodeAndPrepareAudio } from './capabilities/speaker/audio.js';
import { fromProjectRoot } from './core/paths.js';

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function probeStatus(): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`http://127.0.0.1:${DEFAULT_PORT}/v1/health`, { signal: controller.signal });
    output(await response.json());
    if (!response.ok) process.exitCode = 1;
  } catch (error) {
    throw new LocalModelError('SERVICE_UNAVAILABLE', `local-model is not reachable on 127.0.0.1:${DEFAULT_PORT}`, {
      status: 503,
      retryable: true,
      details: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timer);
  }
}

async function loadWav(registry: ModelRegistry, filePath: string, modelId?: string) {
  const audio = await readFile(resolve(filePath));
  const config = registry.getSpeakerConfig(modelId);
  return decodeAndPrepareAudio(audio, { encoding: 'wav' }, config);
}

async function readTemplate(filePath: string): Promise<Float32Array> {
  const parsed = JSON.parse(await readFile(resolve(filePath), 'utf8')) as unknown;
  const values = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { embedding?: unknown }).embedding)
      ? (parsed as { embedding: unknown[] }).embedding
      : null;
  if (!values || values.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new LocalModelError('TEMPLATE_INVALID', 'Template file must contain an embedding array', { status: 400 });
  }
  return Float32Array.from(values as number[]);
}

async function verifyModel(registry: ModelRegistry, modelId: string): Promise<void> {
  const config = registry.getSpeakerConfig(modelId);
  const embeddings: Float32Array[] = [];
  const processingMs: number[] = [];
  for (const fixture of config.selfTest.fixtures) {
    const prepared = await loadWav(registry, fromProjectRoot(fixture), modelId);
    const result = await registry.invokeSpeaker('embedding', prepared, new AbortController().signal, modelId);
    if (!('embedding' in result.output)) throw new Error('Unexpected compare output');
    embeddings.push(result.output.embedding);
    processingMs.push(result.output.processingMs);
  }
  const score = (pair: [number, number]) => {
    const left = embeddings[pair[0]];
    const right = embeddings[pair[1]];
    if (!left || !right) throw new Error('Self-test fixture index is invalid');
    let value = 0;
    for (let i = 0; i < left.length; i += 1) value += (left[i] ?? 0) * (right[i] ?? 0);
    return value;
  };
  const sameSpeakerScore = score(config.selfTest.sameSpeaker);
  const differentSpeakerScore = score(config.selfTest.differentSpeaker);
  if (!(sameSpeakerScore > differentSpeakerScore)) {
    throw new LocalModelError('MODEL_SELF_TEST_FAILED', 'Same-speaker score must exceed different-speaker score');
  }
  output({
    ok: true,
    modelId,
    dimension: embeddings[0]?.length,
    sameSpeakerScore,
    differentSpeakerScore,
    processingMs,
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [command, subcommand, value] = args;
  if (command === 'status') return probeStatus();
  const registry = await ModelRegistry.create();
  try {
    if (command === 'serve') {
      const port = Number(option(args, '--port') || DEFAULT_PORT);
      const service = await startHttpService(registry, { port });
      const stop = async () => {
        await service.close();
        process.exit(0);
      };
      process.once('SIGINT', () => { void stop(); });
      process.once('SIGTERM', () => { void stop(); });
      return await new Promise<void>(() => {});
    }
    if (command === 'models' && subcommand === 'list') return output({ models: registry.list() });
    if (command === 'models' && subcommand === 'inspect' && value) return output({ model: registry.getInfo(value) });
    if (command === 'models' && subcommand === 'verify' && value) return await verifyModel(registry, value);
    if (command === 'models' && subcommand === 'load' && value) return output({ model: await registry.load(value) });
    if (command === 'models' && subcommand === 'unload' && value) return output({ model: await registry.unload(value) });
    if (command === 'speaker' && subcommand === 'embedding') {
      const input = option(args, '--input');
      const modelId = option(args, '--model');
      if (!input) throw new LocalModelError('CLI_USAGE', '--input <wav> is required', { status: 400 });
      const prepared = await loadWav(registry, input, modelId);
      const result = await registry.invokeSpeaker('embedding', prepared, new AbortController().signal, modelId);
      if (!('embedding' in result.output)) throw new Error('Unexpected compare output');
      return output({
        modelId: result.model.id,
        modelVersion: result.model.version,
        dimension: result.output.embedding.length,
        formatVersion: result.model.output.formatVersion,
        processingMs: result.output.processingMs,
        embedding: Array.from(result.output.embedding),
      });
    }
    if (command === 'speaker' && subcommand === 'compare') {
      const input = option(args, '--input');
      const templatePath = option(args, '--template');
      const modelId = option(args, '--model');
      if (!input || !templatePath) throw new LocalModelError('CLI_USAGE', '--input <wav> and --template <json> are required', { status: 400 });
      const [prepared, template] = await Promise.all([loadWav(registry, input, modelId), readTemplate(templatePath)]);
      const result = await registry.invokeSpeaker('compare', { ...prepared, template }, new AbortController().signal, modelId);
      if (!('score' in result.output)) throw new Error('Unexpected embedding output');
      return output({
        modelId: result.model.id,
        modelVersion: result.model.version,
        formatVersion: result.model.output.formatVersion,
        processingMs: result.output.processingMs,
        score: result.output.score,
      });
    }
    throw new LocalModelError('CLI_USAGE', [
      'Usage:',
      '  local-model serve [--port 18089]',
      '  local-model status',
      '  local-model models list',
      '  local-model models inspect <id>',
      '  local-model models verify <id>',
      '  local-model models load <id>',
      '  local-model models unload <id>',
      '  local-model speaker embedding --input <wav> [--model <id>]',
      '  local-model speaker compare --input <wav> --template <json> [--model <id>]',
    ].join('\n'), { status: 400 });
  } finally {
    if (command !== 'serve') await registry.dispose();
  }
}

main().catch(error => {
  const local = asLocalModelError(error);
  process.stderr.write(`${JSON.stringify({ error: local.toBody() }, null, 2)}\n`);
  process.exitCode = 1;
});
