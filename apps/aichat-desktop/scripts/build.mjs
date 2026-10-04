import { build } from 'esbuild';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
await fs.mkdir(`${root}/dist`, { recursive: true });
await build({ entryPoints: [`${root}/src/main.ts`], outfile: `${root}/dist/main.cjs`, bundle: true,
  platform: 'node', format: 'cjs', target: 'node22', sourcemap: true, external: ['electron', 'electron-updater', 'node-pty', 'extract-zip'] });
await fs.copyFile(`${root}/src/preload.cjs`, `${root}/dist/preload.cjs`);
await fs.copyFile(`${root}/assets/keepwork.png`, `${root}/dist/keepwork.png`);
