#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const yauzl = require('yauzl');

function newestVsix(root) {
  const candidates = fs.readdirSync(root)
    .filter(name => name.endsWith('.vsix'))
    .map(name => ({ name, mtime: fs.statSync(path.join(root, name)).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime);
  if (!candidates.length) throw new Error('VSIX file not found');
  return path.join(root, candidates[0].name);
}

function assertEntry(name) {
  const normalized = name.replace(/\\/g, '/').toLowerCase();
  const forbidden = [
    /(^|\/)local-model-runtime(\/|$)/,
    /sherpa-onnx/,
    /\.onnx$/,
    /(^|\/)models\/.*\/(manifest|checksums)\.json$/,
    /speaker-eres2net/,
  ];
  if (forbidden.some(pattern => pattern.test(normalized))) {
    throw new Error(`VSIX contains forbidden local-model resource: ${name}`);
  }
}

function assertVsixBoundary(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (openError, zip) => {
      if (openError) return reject(openError);
      zip.once('error', reject);
      zip.once('end', resolve);
      zip.on('entry', entry => {
        try {
          assertEntry(entry.fileName);
          zip.readEntry();
        } catch (error) {
          zip.close();
          reject(error);
        }
      });
      zip.readEntry();
    });
  });
}

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const file = path.resolve(process.argv[2] || newestVsix(root));
  assertVsixBoundary(file).then(
    () => process.stdout.write(`VSIX contains no local-model resources: ${file}\n`),
    error => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}

module.exports = { assertEntry, assertVsixBoundary };
