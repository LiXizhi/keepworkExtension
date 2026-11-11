import { petCompanionPlugin } from '../../../scripts/pet-companion-build.mjs';
import { aichatRuntimePlugin } from '../../../scripts/aichat-runtime-build.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { creationSkillPlugin } from '../../../scripts/creation-skill-build.mjs';
import { runtimeBuildInfoPlugin } from '../../../scripts/runtime-build-info.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.resolve(here, '..');
const development = process.argv.includes('--development');
const outdirIndex = process.argv.indexOf('--outdir');
if (outdirIndex >= 0 && (!development || !process.argv[outdirIndex + 1] || process.argv[outdirIndex + 1].startsWith('--'))) {
  throw new Error('--outdir requires --development and an explicit output directory');
}
const outdir = outdirIndex >= 0 ? path.resolve(process.argv[outdirIndex + 1]) : path.join(runtimeRoot, 'dist');
// Custom output is only for a newly allocated development generation. Never
// recursively clean a caller-selected existing directory.
if (outdirIndex >= 0 && await fs.stat(outdir).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) {
  throw new Error('--outdir must name a new directory');
}
try {
  await fs.rm(outdir, { recursive: true, force: true });
} catch (error) {
  // An earlier Windows dev daemon can still have dist as its working directory.
  // Clean its contents without removing that directory. Child errors still propagate.
  if (!development || error.code !== 'EBUSY' || error.syscall !== 'rmdir' ||
      error.path !== outdir || !(await fs.lstat(outdir)).isDirectory()) throw error;
  for (const name of await fs.readdir(outdir)) {
    await fs.rm(path.join(outdir, name), { recursive: true, force: true });
  }
}
await fs.mkdir(outdir, { recursive: true });

await build({
  entryPoints: [path.join(runtimeRoot, 'src/cli.ts')],
  outfile: path.join(outdir, 'cli.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['node-pty', 'playwright-core'],
  plugins: [aichatRuntimePlugin({ development }), runtimeBuildInfoPlugin(runtimeRoot), creationSkillPlugin(outdir), petCompanionPlugin(outdir, { includeRuntime: false })],
  legalComments: 'none',
  logLevel: 'info',
});
