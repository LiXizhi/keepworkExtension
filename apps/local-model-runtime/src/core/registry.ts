import type { ModelInfo, ModelOutput, SpeakerInput } from './types.js';
import { loadModelConfigs } from './config.js';
import { LocalModelError } from './errors.js';
import { SpeakerWorkerAdapter } from '../runtimes/speakerWorkerAdapter.js';

export class ModelRegistry {
  private readonly models = new Map<string, SpeakerWorkerAdapter>();

  static async create(): Promise<ModelRegistry> {
    const registry = new ModelRegistry();
    const loaded = await loadModelConfigs();
    for (const item of loaded) {
      if (item.config.runtime.adapter !== 'sherpa-speaker-embedding') {
        throw new LocalModelError('ADAPTER_NOT_REGISTERED', `Adapter is not registered: ${item.config.runtime.adapter}`);
      }
      const adapter = new SpeakerWorkerAdapter(item);
      await adapter.inspectIntegrity();
      registry.models.set(item.config.identity.id, adapter);
    }
    for (const adapter of registry.models.values()) {
      if (adapter.config.runtime.load === 'preload' && adapter.info().trusted) void adapter.load();
    }
    return registry;
  }

  list(): ModelInfo[] {
    return [...this.models.values()].map(adapter => adapter.info());
  }

  getInfo(modelId: string): ModelInfo {
    return this.require(modelId).info();
  }

  getDefaultSpeakerModel(): SpeakerWorkerAdapter {
    const found = [...this.models.values()].find(adapter => adapter.config.identity.capability === 'speaker-embedding');
    if (!found) throw new LocalModelError('CAPABILITY_UNAVAILABLE', 'No speaker embedding model is configured', { status: 503 });
    return found;
  }

  async load(modelId: string): Promise<ModelInfo> {
    return this.require(modelId).load();
  }

  async unload(modelId: string): Promise<ModelInfo> {
    const adapter = this.require(modelId);
    await adapter.dispose();
    return adapter.info();
  }

  async invokeSpeaker(
    operation: 'embedding' | 'compare',
    input: SpeakerInput,
    signal: AbortSignal,
    modelId?: string,
  ): Promise<{ model: ModelInfo; output: ModelOutput }> {
    const adapter = modelId ? this.require(modelId) : this.getDefaultSpeakerModel();
    if (adapter.config.identity.capability !== 'speaker-embedding') {
      throw new LocalModelError('CAPABILITY_MISMATCH', `Model ${adapter.config.identity.id} is not a speaker model`, { status: 400 });
    }
    const output = await adapter.invoke(operation, input, signal);
    return { model: adapter.info(), output };
  }

  getSpeakerConfig(modelId?: string) {
    return (modelId ? this.require(modelId) : this.getDefaultSpeakerModel()).config;
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.models.values()].map(adapter => adapter.dispose()));
  }

  private require(modelId: string): SpeakerWorkerAdapter {
    const model = this.models.get(modelId);
    if (!model) throw new LocalModelError('MODEL_NOT_FOUND', `Unknown model: ${modelId}`, { status: 404 });
    return model;
  }
}
