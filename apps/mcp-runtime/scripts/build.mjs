import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { creationSkillPlugin } from '../../../scripts/creation-skill-build.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.resolve(here, '..');
const outdir = path.join(runtimeRoot, 'dist');

await fs.rm(outdir, { recursive: true, force: true });
await fs.mkdir(outdir, { recursive: true });

await build({
  entryPoints: [path.join(runtimeRoot, 'src/cli.ts')],
  outfile: path.join(outdir, 'cli.cjs'),
  define: {
    'process.env.KEEPWORK_MCP_BUILD_VERSION': JSON.stringify(JSON.parse(await fs.readFile(path.join(runtimeRoot, 'package.json'), 'utf8')).version),
    'process.env.KEEPWORK_MCP_BUILD_COMMIT': JSON.stringify(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: runtimeRoot, encoding: 'utf8' }).trim()),
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['node-pty', 'playwright-core'],
  plugins: [creationSkillPlugin(outdir)],
  legalComments: 'none',
  logLevel: 'info',
});
