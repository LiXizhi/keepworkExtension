import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { decodeAndPrepareAudio } from '../src/capabilities/speaker/audio.js';
import { fromProjectRoot, projectRoot } from '../src/core/paths.js';
import { ModelRegistry } from '../src/core/registry.js';

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

async function main(): Promise<void> {
  const iterations = Number(argument('--iterations', '50'));
  const soakMinutes = Number(argument('--soak-minutes', '0'));
  if (!Number.isInteger(iterations) || iterations < 1 || !Number.isFinite(soakMinutes) || soakMinutes < 0) {
    throw new Error('iterations must be a positive integer and soak-minutes must be non-negative');
  }
  const outputPath = path.resolve(argument(
    '--output',
    path.join(projectRoot, 'reports', `benchmark-${process.platform}-${process.arch}.json`),
  ));
  const registry = await ModelRegistry.create();
  const startedRss = process.memoryUsage().rss;
  try {
    const config = registry.getSpeakerConfig();
    const wav = await readFile(fromProjectRoot(config.selfTest.fixtures[0] ?? ''));
    const prepared = decodeAndPrepareAudio(wav, { encoding: 'wav' }, config);
    const input = { samples: prepared.samples.slice(0, 24000), sampleRate: 16000 };
    const initStarted = performance.now();
    await registry.load(config.identity.id);
    const initializationMs = performance.now() - initStarted;
    for (let index = 0; index < 3; index += 1) {
      await registry.invokeSpeaker('embedding', input, new AbortController().signal);
    }
    const inferenceMs: number[] = [];
    const endToEndMs: number[] = [];
    for (let index = 0; index < iterations; index += 1) {
      const started = performance.now();
      const result = await registry.invokeSpeaker('embedding', input, new AbortController().signal);
      endToEndMs.push(performance.now() - started);
      if (!('embedding' in result.output)) throw new Error('Unexpected compare output');
      inferenceMs.push(result.output.processingMs);
    }

    let soakRequests = 0;
    let soakStartRss = process.memoryUsage().rss;
    let soakPeakRss = soakStartRss;
    const soakStarted = performance.now();
    const soakDeadline = soakStarted + soakMinutes * 60_000;
    while (performance.now() < soakDeadline) {
      await registry.invokeSpeaker('embedding', input, new AbortController().signal);
      soakRequests += 1;
      soakPeakRss = Math.max(soakPeakRss, process.memoryUsage().rss);
    }
    const report = {
      generatedAt: new Date().toISOString(),
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
      modelId: config.identity.id,
      modelVersion: config.identity.version,
      windowMs: 1500,
      iterations,
      initializationMs,
      inferenceMs: {
        average: inferenceMs.reduce((sum, value) => sum + value, 0) / inferenceMs.length,
        p50: percentile(inferenceMs, 0.5),
        p95: percentile(inferenceMs, 0.95),
        maximum: Math.max(...inferenceMs),
      },
      endToEndMs: {
        average: endToEndMs.reduce((sum, value) => sum + value, 0) / endToEndMs.length,
        p95: percentile(endToEndMs, 0.95),
      },
      memory: {
        startedRss,
        afterBenchmarkRss: process.memoryUsage().rss,
        soakStartRss,
        soakPeakRss,
        soakEndRss: process.memoryUsage().rss,
      },
      soak: {
        requestedMinutes: soakMinutes,
        elapsedMs: performance.now() - soakStarted,
        requests: soakRequests,
      },
      gates: {
        p95Below500Ms: percentile(inferenceMs, 0.95) < 500,
        averageBelowWindow: inferenceMs.reduce((sum, value) => sum + value, 0) / inferenceMs.length < 1500,
        thirtyMinuteSoakCompleted: soakMinutes >= 30,
      },
    };
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await registry.dispose();
  }
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
