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
const outdir = path.join(runtimeRoot, 'dist');

const development = process.argv.includes('--development');
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
