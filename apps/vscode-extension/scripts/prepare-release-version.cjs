const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeVersion } = require('../../../scripts/lib/qiniu-release.cjs');

const products = ['vscode-extension', 'mcp-runtime'].map(name => path.resolve(__dirname, '../..', name));
const versions = products.map(dir => {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  return normalizeVersion(manifest.version).split('.').map(Number);
});
versions.sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2]);
const [major, minor, patch] = versions[0];
const nextVersion = [major, minor, patch + 1].join('.');
const originals = new Map();
for (const dir of products) {
  for (const name of ['package.json', 'package-lock.json']) {
    const file = path.join(dir, name);
    originals.set(file, fs.readFileSync(file));
  }
}
try {
  for (const cwd of products) {
    const npmExec = process.env.npm_execpath;
    if (npmExec) {
      execFileSync(process.execPath, [
        npmExec, 'version', nextVersion, '--no-git-tag-version', '--ignore-scripts',
      ], { cwd, stdio: 'inherit' });
    } else {
      execFileSync('npm', ['version', nextVersion, '--no-git-tag-version', '--ignore-scripts'], { cwd, stdio: 'inherit' });
    }
  }
} catch (error) {
  for (const [file, contents] of originals) fs.writeFileSync(file, contents);
  throw error;
}
