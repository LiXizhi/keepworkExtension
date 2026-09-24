import { parentPort } from 'node:worker_threads';
import sherpaOnnx from 'sherpa-onnx-node';
import type { SpeakerEmbeddingExtractor } from 'sherpa-onnx-node';
import type { WorkerRequest, WorkerResponse } from './protocol.js';

if (!parentPort) throw new Error('speakerWorker must run inside a Worker Thread');
const port = parentPort;

let extractor: SpeakerEmbeddingExtractor | null = null;
let expectedDimension = 0;

function errorBody(error: unknown, code = 'MODEL_INFERENCE_FAILED') {
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  };
}

function normalize(values: Float32Array): Float32Array {
  let squared = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) throw new Error('Model returned a non-finite embedding');
    squared += value * value;
  }
  const norm = Math.sqrt(squared);
  if (!(norm > 0)) throw new Error('Model returned a zero embedding');
  const output = new Float32Array(values.length);
  for (let i = 0; i < values.length; i += 1) output[i] = (values[i] ?? 0) / norm;
  return output;
}

function cosine(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length || left.length !== expectedDimension) {
    throw new Error(`Template dimension must be ${expectedDimension}`);
  }
  const normalized = normalize(right);
  let score = 0;
  for (let i = 0; i < left.length; i += 1) score += (left[i] ?? 0) * (normalized[i] ?? 0);
  return Math.max(-1, Math.min(1, score));
}

port.on('message', (message: WorkerRequest) => {
  if (message.type === 'initialize') {
    try {
      expectedDimension = message.expectedDimension;
      extractor = new sherpaOnnx.SpeakerEmbeddingExtractor({
        model: message.modelPath,
        numThreads: message.threads,
        provider: message.provider,
        debug: false,
      });
      if (extractor.dim !== expectedDimension) {
        throw new Error(`Model dimension ${extractor.dim} does not match configured ${expectedDimension}`);
      }
      port.postMessage({ type: 'ready', dimension: extractor.dim } satisfies WorkerResponse);
    } catch (error) {
      port.postMessage({ type: 'error', error: errorBody(error, 'MODEL_LOAD_FAILED') } satisfies WorkerResponse);
    }
    return;
  }
  if (message.type === 'dispose') {
    extractor = null;
    port.close();
    return;
  }
  if (!extractor) {
    port.postMessage({
      type: 'error',
      id: message.id,
      error: { code: 'MODEL_NOT_READY', message: 'Speaker model is not loaded', retryable: true },
    } satisfies WorkerResponse);
    return;
  }
  const started = performance.now();
  try {
    const samples = new Float32Array(message.samples);
    const stream = extractor.createStream();
    stream.acceptWaveform({ sampleRate: message.sampleRate, samples });
    stream.inputFinished();
    if (!extractor.isReady(stream)) throw new Error('Audio is too short for speaker embedding extraction');
    const embedding = normalize(extractor.compute(stream, false));
    if (message.operation === 'embedding') {
      const output = embedding.buffer as ArrayBuffer;
      port.postMessage({
        type: 'result', id: message.id, processingMs: performance.now() - started, embedding: output,
      } satisfies WorkerResponse, [output]);
      return;
    }
    if (!message.template) throw new Error('A speaker template is required for compare');
    const score = cosine(embedding, new Float32Array(message.template));
    port.postMessage({
      type: 'result', id: message.id, processingMs: performance.now() - started, score,
    } satisfies WorkerResponse);
  } catch (error) {
    port.postMessage({ type: 'error', id: message.id, error: errorBody(error) } satisfies WorkerResponse);
  }
});
