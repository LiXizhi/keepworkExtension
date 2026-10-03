import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../skills/paracraft-create');
// Both products bundle the same canonical skill; no dependency on checkout paths at runtime.
export function creationSkillPlugin(outdir) {
  return { name: 'paracraft-creation-skill', setup(build) {
    build.onEnd(async result => {
      if (!result.errors.length) {
        await fs.cp(source, path.join(outdir, 'skills/paracraft-create'), { recursive: true });
      }
    });
  } };
}
