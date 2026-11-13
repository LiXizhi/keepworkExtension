// Cross-platform, reproducible build for Rust/Node comparisons. The ordinary
// product build retains its canonical freshness checks and historical default.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const repoRoot = path.resolve(__dirname, '..');
const result = spawnSync(process.execPath, [path.join(repoRoot, 'apps/mcp-runtime/scripts/build.mjs')], {
  cwd: repoRoot,
  env: { ...process.env, KEEPWORK_AICHAT_RUNTIME_MODE: 'packaged' },
  stdio: 'inherit', shell: false,
});
if (result.error) process.stderr.write(result.error.message + '\n');
process.exitCode = result.status === 0 ? 0 : (Number.isInteger(result.status) && result.status > 0 && result.status <= 255 ? result.status : 1);
