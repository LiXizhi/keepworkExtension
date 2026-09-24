const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const sharedRoot = path.join(repoRoot, 'src');
const appsRoot = path.join(repoRoot, 'apps');
const vscodeRoot = path.join(appsRoot, 'vscode-extension');
const helperRoot = path.join(appsRoot, 'local-helper');
const modelRoot = path.join(appsRoot, 'local-model-runtime');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function walk(dir, suffix) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(target, suffix);
    return !suffix || target.endsWith(suffix) ? [target] : [];
  });
}

function relativeImports(file) {
  const source = fs.readFileSync(file, 'utf8');
  const imports = [];
  const pattern = /(?:from\s+|require\s*\()(['"])(\.\.?\/[^'"]+)\1/g;
  for (const match of source.matchAll(pattern)) imports.push(path.resolve(path.dirname(file), match[2]));
  return imports;
}

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

const rootPackage = readJson(path.join(repoRoot, 'package.json'));
const vscodePackage = readJson(path.join(vscodeRoot, 'package.json'));
const helperPackage = readJson(path.join(helperRoot, 'package.json'));
const modelPackage = readJson(path.join(modelRoot, 'package.json'));

assert.equal(rootPackage.private, true, 'the repository package must remain private');
for (const field of ['main', 'bin', 'contributes', 'activationEvents']) {
  assert.equal(rootPackage[field], undefined, `root package.json must not define product field ${field}`);
}
assert.equal(vscodePackage.main, './dist/extension.js', 'VS Code entry must be app-local');
assert.equal(helperPackage.main, 'dist/main.js', 'helper entry must be app-local');
assert.equal(modelPackage.bin?.['local-model'], 'dist/src/cli.js', 'local-model CLI must remain app-local');
assert.equal(vscodePackage.dependencies?.['sherpa-onnx-node'], undefined, 'VSIX must not depend on local-model native code');

assert.deepEqual(fs.readdirSync(sharedRoot).sort(), ['core', 'mcp'], 'root src may contain only shared core and mcp');
for (const oldPath of ['.vscodeignore', 'src/extension.ts', 'src/cli.ts', 'src/vscode']) {
  assert.equal(fs.existsSync(path.join(repoRoot, oldPath)), false, `${oldPath} belongs to an application`);
}
for (const requiredPath of ['.vscode', '.vscodeignore', 'src/extension.ts', 'src/cli.ts', 'src/vscode']) {
  assert.equal(fs.existsSync(path.join(vscodeRoot, requiredPath)), true, `missing VS Code app path ${requiredPath}`);
}

const applicationRoots = [vscodeRoot, helperRoot, modelRoot];
for (const applicationRoot of applicationRoots) {
  for (const file of walk(path.join(applicationRoot, 'src'), '.ts')) {
    for (const imported of relativeImports(file)) {
      for (const otherRoot of applicationRoots.filter(candidate => candidate !== applicationRoot)) {
        assert.equal(isInside(imported, otherRoot), false, `${path.relative(repoRoot, file)} imports another application`);
      }
    }
  }
}

for (const file of walk(sharedRoot, '.ts')) {
  for (const imported of relativeImports(file)) {
    assert.equal(isInside(imported, appsRoot), false, `${path.relative(repoRoot, file)} imports application code`);
  }
}

process.stdout.write('repository application layout is valid\n');
