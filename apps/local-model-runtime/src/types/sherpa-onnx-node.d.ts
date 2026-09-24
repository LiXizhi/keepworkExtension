declare module 'sherpa-onnx-node' {
  export interface SpeakerEmbeddingStream {
    acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void;
    inputFinished(): void;
  }

  export class SpeakerEmbeddingExtractor {
    constructor(config: { model: string; numThreads: number; debug: boolean; provider: string });
    readonly dim: number;
    createStream(): SpeakerEmbeddingStream;
    isReady(stream: SpeakerEmbeddingStream): boolean;
    compute(stream: SpeakerEmbeddingStream, enableExternalBuffer?: boolean): Float32Array;
  }

  const sherpaOnnx: {
    SpeakerEmbeddingExtractor: typeof SpeakerEmbeddingExtractor;
  };
  export default sherpaOnnx;
}
