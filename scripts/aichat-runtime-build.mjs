import fs from 'node:fs';
import path from 'node:path';
import runtimeSync from './sync-aichat-runtime.cjs';

// Build-time only: installed applications consume the bundled CommonJS modules.
export function aichatRuntimePlugin({ source = runtimeSync.defaultSource, dest = runtimeSync.defaultDest, freshness } = {}) {
  source = path.resolve(source);
  dest = path.resolve(dest);
  let watchFiles = [];
  let canonicalDest;
  return { name: 'aichat-runtime-sync', setup(build) {
    build.onStart(() => { watchFiles = runtimeSync.syncRuntime({ source, dest, freshness }); canonicalDest = fs.realpathSync(dest); });
    build.onLoad({ filter: /\.cjs$/ }, args => {
      if (path.dirname(args.path) !== canonicalDest && path.dirname(args.path) !== dest) return;
      return { contents: fs.readFileSync(args.path, 'utf8'), loader: 'js',
        resolveDir: dest, watchFiles: [args.path, path.join(dest, 'manifest.json'), ...watchFiles], watchDirs: [dest, ...(fs.existsSync(source) ? [source] : [])] };
    });
  } };
}
