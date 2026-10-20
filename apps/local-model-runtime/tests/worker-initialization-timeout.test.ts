import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MIN_WORKER_INITIALIZATION_TIMEOUT_MS,
  workerInitializationTimeoutMs,
} from '../src/runtimes/speakerWorkerAdapter.js';

test('worker initialization has a safe cold-start floor without changing inference timeout', () => {
  assert.equal(workerInitializationTimeoutMs(2_000), MIN_WORKER_INITIALIZATION_TIMEOUT_MS);
  assert.equal(workerInitializationTimeoutMs(20_000), 20_000);
});
