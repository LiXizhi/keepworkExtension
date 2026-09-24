export type ModelState =
  | 'not-installed'
  | 'unloaded'
  | 'loading'
  | 'ready'
  | 'unloading'
  | 'error';

export type AudioEncoding = 'pcm_f32le' | 'pcm_s16le' | 'wav';

export interface ModelConfig {
  schemaVersion: 1;
  identity: {
    id: string;
    version: string;
    capability: string;
    description: string;
    license: string;
    source?: string;
  };
  artifact: {
    path: string;
    bytes: number;
    sha256: string;
    manifest: string;
    publicKey: string;
    platforms: string[];
  };
  runtime: {
    adapter: string;
    provider: 'cpu';
    threads: number;
    load: 'on-demand' | 'preload';
  };
  input: {
    encodings: AudioEncoding[];
    sampleRate: number;
    channels: number;
    minDurationMs: number;
    maxDurationMs: number;
    valueRange: [number, number];
  };
  preprocess: {
    resample: boolean;
    mono: boolean;
    normalize: boolean;
    owner: 'runtime' | 'adapter';
  };
  operations: Array<'embedding' | 'compare'>;
  output: {
    type: 'float32';
    dimension: number;
    normalized: boolean;
    formatVersion: number;
  };
  resources: {
    maxConcurrency: number;
    maxQueue: number;
    timeoutMs: number;
    idleUnloadMs: number;
  };
  transports: {
    cli: boolean;
    http: boolean;
    websocket: boolean;
    streaming: boolean;
  };
  privacy: {
    logInput: boolean;
    logOutput: boolean;
    logMetrics: boolean;
  };
  selfTest: {
    fixtures: string[];
    expectedDimension: number;
    sameSpeaker: [number, number];
    differentSpeaker: [number, number];
  };
}

export interface ModelInfo {
  id: string;
  version: string;
  capability: string;
  state: ModelState;
  installed: boolean;
  trusted: boolean;
  operations: string[];
  transports: ModelConfig['transports'];
  input: ModelConfig['input'];
  output: ModelConfig['output'];
  error?: ModelErrorBody;
}

export interface ModelHealth {
  state: ModelState;
  loadedAt?: number;
  lastUsedAt?: number;
  queueDepth: number;
  activeRequests: number;
  error?: ModelErrorBody;
}

export interface SpeakerInput {
  samples: Float32Array;
  sampleRate: number;
  template?: Float32Array;
}

export interface SpeakerEmbeddingOutput {
  embedding: Float32Array;
  processingMs: number;
}

export interface SpeakerCompareOutput {
  score: number;
  processingMs: number;
}

export type ModelInput = SpeakerInput;
export type ModelOutput = SpeakerEmbeddingOutput | SpeakerCompareOutput;

export interface ModelAdapter {
  load(): Promise<ModelInfo>;
  invoke(operation: string, input: ModelInput, signal: AbortSignal): Promise<ModelOutput>;
  health(): ModelHealth;
  dispose(): Promise<void>;
}

export interface ModelErrorBody {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
}

export interface SignedManifest {
  schemaVersion: 1;
  modelId: string;
  modelVersion: string;
  artifact: {
    path: string;
    bytes: number;
    sha256: string;
  };
  packageFiles: Record<string, string>;
  configSha256: string;
  createdAt: string;
  signature: {
    algorithm: 'Ed25519';
    keyId: string;
    value: string;
  };
}
