import { createRequire } from 'node:module';
import path from 'node:path';
const { stagePetCompanion } = createRequire(import.meta.url)('./pet-companion-stage.cjs');
export function petCompanionPlugin(outdir, options = {}) {
  return { name: 'pet-companion', setup(build) { build.onEnd(result => { if (!result.errors.length) stagePetCompanion(path.join(outdir, 'pet-companion'), options); }); } };
}
