import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, context } from 'esbuild';
import { creationSkillPlugin } from '../../../scripts/creation-skill-build.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(here, '..');
const outdir = path.join(extensionRoot, 'dist');
const watchMode = process.argv.includes('--watch');

const common = {
  define: {
    'process.env.KEEPWORK_MCP_BUILD_VERSION': JSON.stringify(JSON.parse(await fs.readFile(path.join(extensionRoot, 'package.json'), 'utf8')).version),
    'process.env.KEEPWORK_MCP_BUILD_COMMIT': JSON.stringify(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: extensionRoot, encoding: 'utf8' }).trim()),
  },
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
    external: ['vscode', 'node-pty', 'playwright-core'],
  },
  {
    ...common,
    entryPoints: [path.join(extensionRoot, 'src/cli.ts')],
    outfile: path.join(outdir, 'cli.js'),
    plugins: [creationSkillPlugin(outdir)],
    external: ['node-pty', 'playwright-core'],
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
