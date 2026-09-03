import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import pngjs from 'pngjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const helperRoot = path.resolve(here, '..');

const outdir = path.join(helperRoot, 'dist');
await fs.rm(outdir, { recursive: true, force: true });
await fs.mkdir(outdir, { recursive: true });

const mainSource = await fs.readFile(path.join(helperRoot, 'src/main.ts'), 'utf8');
const iconMatch = mainSource.match(/const TRAY_ICON = 'data:image\/png;base64,([^']+)'/);
if (!iconMatch) throw new Error('TRAY_ICON PNG was not found in src/main.ts');
const sourceIcon = pngjs.PNG.sync.read(Buffer.from(iconMatch[1], 'base64'));
const appIcon = new pngjs.PNG({ width: 256, height: 256 });
for (let y = 0; y < appIcon.height; y += 1) {
  for (let x = 0; x < appIcon.width; x += 1) {
    const sourceX = Math.min(sourceIcon.width - 1, Math.floor(x * sourceIcon.width / appIcon.width));
    const sourceY = Math.min(sourceIcon.height - 1, Math.floor(y * sourceIcon.height / appIcon.height));
    const sourceOffset = (sourceY * sourceIcon.width + sourceX) * 4;
    const targetOffset = (y * appIcon.width + x) * 4;
    sourceIcon.data.copy(appIcon.data, targetOffset, sourceOffset, sourceOffset + 4);
  }
}
await fs.writeFile(path.join(outdir, 'icon.png'), pngjs.PNG.sync.write(appIcon));

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
};

await build({
  ...common,
  entryPoints: [path.join(helperRoot, 'src/main.ts')],
  outfile: path.join(outdir, 'main.js'),
  external: ['electron', 'electron-updater'],
});

await build({
  ...common,
  entryPoints: [path.join(helperRoot, 'src/worker.ts')],
  outfile: path.join(outdir, 'worker.js'),
  external: ['node-pty'],
});
