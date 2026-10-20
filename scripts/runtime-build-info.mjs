import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const metadataModule = fileURLToPath(new URL('../src/core/runtimeBuildInfo.ts', import.meta.url));

// onLoad runs for each rebuild too, so watch mode never keeps its initial date/version.
export function runtimeBuildInfoPlugin(appRoot) {
  return {
    name: 'keepwork-runtime-build-info',
    setup(build) {
      build.onLoad({ filter: /[/\\]runtimeBuildInfo\.ts$/ }, async ({ path: file }) => {
        if (file !== metadataModule) return;
        const manifest = path.join(appRoot, 'package.json');
        const { version } = JSON.parse(await fs.readFile(manifest, 'utf8'));
        const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: appRoot, encoding: 'utf8' }).trim();
        return {
          contents: `export const runtimeBuildInfo = ${JSON.stringify({ version, commit, builtAt: new Date().toISOString() })};`,
          loader: 'js',
          watchFiles: [metadataModule, manifest],
        };
      });
    },
  };
}
