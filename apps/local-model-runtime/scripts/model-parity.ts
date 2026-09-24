import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { decodeAndPrepareAudio } from '../src/capabilities/speaker/audio.js';
import { fromProjectRoot, projectRoot } from '../src/core/paths.js';
import { ModelRegistry } from '../src/core/registry.js';

function readNpyFloat32(buffer: Buffer): Float32Array {
  if (buffer.subarray(0, 6).toString('latin1') !== '\x93NUMPY') throw new Error('Invalid NPY magic');
  const major = buffer[6];
  const headerLength = major === 1 ? buffer.readUInt16LE(8) : buffer.readUInt32LE(8);
  const headerOffset = major === 1 ? 10 : 12;
  const header = buffer.subarray(headerOffset, headerOffset + headerLength).toString('latin1');
  if (!header.includes("'descr': '<f4'") || header.includes("'fortran_order': True")) {
    throw new Error('Reference embedding must be little-endian contiguous Float32 NPY');
  }
  const bytes = buffer.subarray(headerOffset + headerLength);
  if (bytes.byteLength % 4 !== 0) throw new Error('Reference embedding byte length is invalid');
  const values = new Float32Array(bytes.byteLength / 4);
  for (let index = 0; index < values.length; index += 1) values[index] = bytes.readFloatLE(index * 4);
  return values;
}

function cosine(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length) throw new Error('Embedding dimensions differ');
  let dot = 0;
  let leftSquared = 0;
  let rightSquared = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftSquared += a * a;
    rightSquared += b * b;
  }
  return dot / Math.sqrt(leftSquared * rightSquared);
}

async function main(): Promise<void> {
  const threshold = 0.99;
  const registry = await ModelRegistry.create();
  try {
    const config = registry.getSpeakerConfig();
    const comparisons = [];
    for (const fixture of config.selfTest.fixtures) {
      const stem = path.basename(fixture, '.wav');
      const [wav, referenceFile] = await Promise.all([
        readFile(fromProjectRoot(fixture)),
        readFile(path.join(projectRoot, 'tests', 'reference', `${stem}.npy`)),
      ]);
      const prepared = decodeAndPrepareAudio(wav, { encoding: 'wav' }, config);
      const result = await registry.invokeSpeaker('embedding', prepared, new AbortController().signal);
      if (!('embedding' in result.output)) throw new Error('Unexpected compare output');
      comparisons.push({ fixture, cosine: cosine(result.output.embedding, readNpyFloat32(referenceFile)) });
    }
    const report = {
      generatedAt: new Date().toISOString(),
      platform: `${process.platform}-${process.arch}`,
      modelId: config.identity.id,
      threshold,
      comparisons,
      minimumCosine: Math.min(...comparisons.map(item => item.cosine)),
    };
    const outputPath = path.join(projectRoot, 'reports', `parity-${process.platform}-${process.arch}.json`);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.minimumCosine < threshold) process.exitCode = 1;
  } finally {
    await registry.dispose();
  }
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
