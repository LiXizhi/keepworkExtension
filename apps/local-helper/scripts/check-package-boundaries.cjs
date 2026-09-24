const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helperRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(helperRoot, '../..');
const modelRoot = path.join(repoRoot, 'apps/local-model-runtime');
const rootPackage = require(path.join(repoRoot, 'package.json'));
const extensionRoot = path.join(repoRoot, 'apps/vscode-extension');
const extensionPackage = require(path.join(extensionRoot, 'package.json'));
const helperPackage = require(path.join(helperRoot, 'package.json'));
const builderConfig = require(path.join(helperRoot, 'electron-builder.config.cjs'));

assert.equal(rootPackage.private, true, 'repository package must remain private');
assert.equal(rootPackage.main, undefined, 'repository package must not be an application manifest');
assert.equal(rootPackage.contributes, undefined, 'VS Code contributions belong to the VS Code app');
assert.equal(extensionPackage.main, './dist/extension.js', 'VS Code entry must remain app-local');
assert.equal(extensionPackage.bin?.['keepwork-mcp'], './dist/cli.js', 'VS Code CLI must remain app-local');
assert.equal(path.dirname(extensionRoot), path.dirname(helperRoot), 'applications must be siblings under apps');
assert.equal(helperPackage.dependencies?.vscode, undefined, 'helper must not depend on vscode');
assert.equal(helperPackage.devDependencies?.vscode, undefined, 'helper must not depend on vscode');
assert.equal(extensionPackage.dependencies?.['sherpa-onnx-node'], undefined, 'VSIX must not contain local-model native dependencies');
assert.ok(fs.existsSync(path.join(modelRoot, 'models')), 'local-model assets must remain in their app package');
assert.equal(fs.existsSync(path.join(extensionRoot, 'models')), false, 'VSIX app must not contain local-model assets');

const includedRoots = builderConfig.files.filter((entry) => !entry.startsWith('!'));
assert.deepEqual(includedRoots, ['dist/**/*', 'package.json'], 'helper package file roots changed');

for (const output of ['dist/main.js', 'dist/worker.js']) {
  const source = fs.readFileSync(path.join(helperRoot, output), 'utf8');
  assert.doesNotMatch(source, /(?:src|out)[\\/]vscode|out[\\/]extension\.js|require\(["']vscode["']\)/, `${output} contains VS Code extension code`);
}

for (const output of ['dist/extension.js', 'dist/cli.js']) {
  assert.ok(fs.existsSync(path.join(extensionRoot, output)), `${output} was not built`);
  const source = fs.readFileSync(path.join(extensionRoot, output), 'utf8');
  assert.doesNotMatch(source, /sherpa-onnx-node|keepwork-local-model-node-runtime/, `${output} contains local-model code`);
}

process.stdout.write('VSIX and Windows helper package boundaries are valid\n');
