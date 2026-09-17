import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.resolve(here, '..');
const outdir = path.join(runtimeRoot, 'dist');

await fs.rm(outdir, { recursive: true, force: true });
await fs.mkdir(outdir, { recursive: true });

await build({
  entryPoints: [path.join(runtimeRoot, 'src/cli.ts')],
  outfile: path.join(outdir, 'cli.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['node-pty', 'playwright-core'],
  legalComments: 'none',
  logLevel: 'info',
});
