const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const MCP_RUNTIME_SOURCE_PATHS = [
  'src/core',
  'src/mcp',
  'apps/mcp-runtime/src',
  'apps/mcp-runtime/package.json',
  'apps/mcp-runtime/package-lock.json',
  'apps/mcp-runtime/tsconfig.json',
  'apps/mcp-runtime/scripts/build.mjs',
  'apps/mcp-runtime/scripts/stage-runtime.cjs',
  'scripts/creation-skill-build.mjs',
  'skills/paracraft-create',
  'skills/agent-cli-verify',
];

function hasRuntimeSourceChanges(repoRoot, sourceCommit) {
  const diff = spawnSync('git', ['diff', '--quiet', sourceCommit, '--', ...MCP_RUNTIME_SOURCE_PATHS], {
    cwd: repoRoot,
    stdio: 'ignore',
  });
  if (diff.error) throw diff.error;
  if (diff.status === 1) return true;
  if (diff.status !== 0) throw new Error(`Unable to compare MCP runtime source with ${sourceCommit}`);

  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', ...MCP_RUNTIME_SOURCE_PATHS], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return Boolean(untracked.trim());
}

function validateMcpRuntime(runtimeDir, expected) {
  if (!runtimeDir) throw new Error('AICHAT_MCP_RUNTIME_DIR must point to the tested native MCP runtime');
  const root = path.resolve(runtimeDir);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'runtime.json'), 'utf8'));
  const runtimePackage = JSON.parse(fs.readFileSync(path.join(root, 'app', 'package.json'), 'utf8'));
  if (manifest.platform !== expected.platform || manifest.arch !== expected.arch
      || manifest.product !== 'keepwork-mcp-node-runtime' || manifest.entry !== 'app/cli.cjs') {
    throw new Error('Bundled MCP runtime target mismatch');
  }
  if (runtimePackage.name !== 'keepwork-mcp-runtime' || runtimePackage.version !== manifest.version
      || !/^[a-f0-9]{40}$/.test(runtimePackage.commit || '')) {
    throw new Error('Bundled MCP runtime source metadata is missing or inconsistent');
  }
  const sourceChanged = expected.hasSourceChangesSince
    ? expected.hasSourceChangesSince(runtimePackage.commit)
    : expected.commit && runtimePackage.commit !== expected.commit;
  if (sourceChanged) {
    const platformArg = expected.platform === 'windows' ? 'win32' : 'darwin';
    throw new Error(`Bundled MCP runtime is stale (built from ${runtimePackage.commit}; MCP runtime source has changed). Rebuild it with npm run stage --prefix apps/mcp-runtime -- --platform ${platformArg} --arch ${expected.arch}.`);
  }
  return manifest;
}

module.exports = { hasRuntimeSourceChanges, validateMcpRuntime };
