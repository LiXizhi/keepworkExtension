import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

async function syncSkill(outdir, name = 'paracraft-create') {
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../skills', name);
  const root = await fs.realpath(path.resolve(outdir));
  const parent = path.join(root, 'skills');
  const target = path.join(parent, name);
  const canonical = await fs.realpath(source);
  if ([path.relative(target, canonical), path.relative(canonical, target)].some(relative =>
    relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)))) {
    throw new Error('Skill output overlaps canonical source');
  }
  await fs.mkdir(parent, { recursive: true });
  if ((await fs.lstat(parent)).isSymbolicLink()) throw new Error('Skill output parent must not be a link');
  // Delete only this generated subtree, after checking physical confinement.
  if (path.relative(root, target) !== path.join('skills', name)) throw new Error('Skill output escaped build directory');
  const info = await fs.lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (info?.isSymbolicLink()) throw new Error('Skill output must not be a link');
  await fs.rm(target, { recursive: true, force: true });
  await fs.cp(source, target, { recursive: true });
}
// Both products bundle the same canonical skill; no dependency on checkout paths at runtime.
export function creationSkillPlugin(outdir) {
  return { name: 'paracraft-creation-skill', setup(build) {
    build.onEnd(async result => {
      if (!result.errors.length) {
        await syncSkill(outdir);
        await syncSkill(outdir, 'agent-cli-verify');
      }
    });
  } };
}
