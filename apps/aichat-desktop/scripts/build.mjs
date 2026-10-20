import { build } from 'esbuild';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const root = fileURLToPath(new URL('../', import.meta.url));
await fs.mkdir(`${root}/dist`, { recursive: true });
await build({ entryPoints: [`${root}/src/main.ts`], outfile: `${root}/dist/main.cjs`, bundle: true,
  platform: 'node', format: 'cjs', target: 'node22', sourcemap: true, external: ['electron', 'electron-updater', 'node-pty', 'extract-zip'] });
await fs.copyFile(`${root}/src/preload.cjs`, `${root}/dist/preload.cjs`);
await fs.copyFile(`${root}/assets/keepwork.png`, `${root}/dist/keepwork.png`);
await fs.copyFile(`${root}/assets/keepwork-mac.png`, `${root}/dist/keepwork-mac.png`);
await createRequire(import.meta.url)('./dev-electron.cjs').prepare();

for (const file of ['updates.html', 'updates.css', 'updates.js', 'updates-preload.cjs']) await fs.copyFile(`${root}/src/${file}`, `${root}/dist/${file}`);
