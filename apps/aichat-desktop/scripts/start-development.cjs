const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');

function buildDevelopment(exec = execFileSync) {
  // Both builds must succeed before startup can replace a running MCP daemon.
  exec(process.execPath, [path.resolve(root, '../mcp-runtime/scripts/build.mjs'), '--development'], { cwd: root, stdio: 'inherit' });
  exec(process.execPath, [path.join(__dirname, 'build.mjs')], { cwd: root, stdio: 'inherit' });
}
function main() {
  buildDevelopment();
  const child = spawn(process.execPath, [path.join(__dirname, 'dev-electron.cjs')], {
    cwd: root, stdio: 'inherit', env: { ...process.env, AICHAT_DESKTOP_FRESH_MCP_NODE: process.execPath },
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}
module.exports = { buildDevelopment };
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
