import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import YAML from 'yaml';
import type { ModelConfig } from './types.js';
import { LocalModelError } from './errors.js';
import { projectRoot } from './paths.js';

export interface LoadedModelConfig {
  config: ModelConfig;
  source: string;
  filePath: string;
}

export async function loadModelConfigs(): Promise<LoadedModelConfig[]> {
  const schemaPath = path.join(projectRoot, 'schemas', 'model.schema.json');
  const configDir = path.join(projectRoot, 'configs', 'models');
  const schema = JSON.parse(await readFile(schemaPath, 'utf8')) as object;
  const Ajv2020Constructor = Ajv2020 as unknown as new (options: object) => {
    compile<T>(inputSchema: object): ValidateFunction<T>;
  };
  const ajv = new Ajv2020Constructor({ allErrors: true, strict: true });
  const validate = ajv.compile<ModelConfig>(schema);
  const names = (await readdir(configDir)).filter(name => /\.ya?ml$/i.test(name)).sort();
  const loaded: LoadedModelConfig[] = [];
  const ids = new Set<string>();

  for (const name of names) {
    const filePath = path.join(configDir, name);
    const source = await readFile(filePath, 'utf8');
    const parsed: unknown = YAML.parse(source);
    if (!validate(parsed)) {
      throw new LocalModelError('MODEL_CONFIG_INVALID', `Invalid model configuration: ${name}`, {
        details: validate.errors,
      });
    }
    const config = parsed as ModelConfig;
    if (ids.has(config.identity.id)) {
      throw new LocalModelError('MODEL_CONFIG_DUPLICATE', `Duplicate model id: ${config.identity.id}`);
    }
    if (config.input.minDurationMs > config.input.maxDurationMs) {
      throw new LocalModelError('MODEL_CONFIG_INVALID', `${name}: minDurationMs exceeds maxDurationMs`);
    }
    ids.add(config.identity.id);
    loaded.push({ config, source, filePath });
  }
  return loaded;
}
