import type { ModelErrorBody } from '../core/types.js';

export interface WorkerInitializeRequest {
  type: 'initialize';
  modelPath: string;
  threads: number;
  provider: string;
  expectedDimension: number;
}

export interface WorkerInvokeRequest {
  type: 'invoke';
  id: string;
  operation: 'embedding' | 'compare';
  samples: ArrayBuffer;
  sampleRate: number;
  template?: ArrayBuffer;
}

export interface WorkerDisposeRequest {
  type: 'dispose';
}

export type WorkerRequest = WorkerInitializeRequest | WorkerInvokeRequest | WorkerDisposeRequest;

export interface WorkerReadyResponse {
  type: 'ready';
  dimension: number;
}

export interface WorkerResultResponse {
  type: 'result';
  id: string;
  processingMs: number;
  embedding?: ArrayBuffer;
  score?: number;
}

export interface WorkerErrorResponse {
  type: 'error';
  id?: string;
  error: ModelErrorBody;
}

export type WorkerResponse = WorkerReadyResponse | WorkerResultResponse | WorkerErrorResponse;
