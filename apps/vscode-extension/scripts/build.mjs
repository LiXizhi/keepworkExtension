import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, context } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(here, '..');
const outdir = path.join(extensionRoot, 'dist');
const watchMode = process.argv.includes('--watch');

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
};

const builds = [
  {
    ...common,
    entryPoints: [path.join(extensionRoot, 'src/extension.ts')],
    outfile: path.join(outdir, 'extension.js'),
    external: ['vscode', 'node-pty'],
  },
  {
    ...common,
    entryPoints: [path.join(extensionRoot, 'src/cli.ts')],
    outfile: path.join(outdir, 'cli.js'),
    external: ['node-pty'],
  },
];

await fs.rm(outdir, { recursive: true, force: true });
await fs.mkdir(outdir, { recursive: true });

if (watchMode) {
  const contexts = await Promise.all(builds.map((options) => context(options)));
  await Promise.all(contexts.map((buildContext) => buildContext.watch()));
  process.stdout.write('Watching VS Code extension sources\n');
  await new Promise(() => {});
} else {
  await Promise.all(builds.map((options) => build(options)));
}
