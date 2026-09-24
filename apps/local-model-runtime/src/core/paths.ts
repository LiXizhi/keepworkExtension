import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function findProjectRoot(start: string): string {
  let current = path.resolve(start);
  while (true) {
    if (existsSync(path.join(current, 'schemas', 'model.schema.json'))
      && existsSync(path.join(current, 'configs', 'models'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Unable to locate local-model project root from ${start}`);
}
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export const projectRoot = process.env.LOCAL_MODEL_ROOT
  ? path.resolve(process.env.LOCAL_MODEL_ROOT)
  : findProjectRoot(moduleDir);

export function fromProjectRoot(relativePath: string): string {
  const resolved = path.resolve(projectRoot, relativePath);
  const relative = path.relative(projectRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes local-model root: ${relativePath}`);
  }
  return resolved;
}
