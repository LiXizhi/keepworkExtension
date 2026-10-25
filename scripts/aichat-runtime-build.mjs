import fs from 'node:fs';
import path from 'node:path';
import runtimeSync from './sync-aichat-runtime.cjs';

// Build-time only: installed applications consume the bundled CommonJS modules.
export function aichatRuntimePlugin({ source = runtimeSync.defaultSource, dest = runtimeSync.defaultDest, freshness, development = false } = {}) {
  source = path.resolve(source);
  dest = path.resolve(dest);
  let watchFiles = [];
  let canonicalDest;
  let useSource = false;
  return { name: 'aichat-runtime-sync', setup(build) {
    build.onStart(() => {
      useSource = development && fs.existsSync(source);
      // Development consumes ES modules directly and never replaces release provenance.
      watchFiles = useSource ? [] : runtimeSync.syncRuntime({ source, dest, freshness });
      canonicalDest = fs.existsSync(dest) ? fs.realpathSync(dest) : dest;
    });
    build.onResolve({ filter: /\.cjs$/ }, args => {
      if (!useSource || (!path.isAbsolute(args.path) && !args.path.startsWith('.'))) return;
      const target = path.resolve(args.resolveDir, args.path);
      if (path.dirname(target) !== dest && path.dirname(target) !== canonicalDest) return;
      return { path: path.join(source, path.basename(target).replace(/\.cjs$/, '.mjs')) };
    });
    build.onLoad({ filter: /\.cjs$/ }, args => {
      if (path.dirname(args.path) !== canonicalDest && path.dirname(args.path) !== dest) return;
      return { contents: fs.readFileSync(args.path, 'utf8'), loader: 'js',
        resolveDir: dest, watchFiles: [args.path, path.join(dest, 'manifest.json'), ...watchFiles], watchDirs: [dest, ...(fs.existsSync(source) ? [source] : [])] };
    });
  } };
}
