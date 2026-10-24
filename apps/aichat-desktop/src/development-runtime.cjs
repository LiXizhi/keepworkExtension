// Opt-in development startup only. Packaged applications never enable this path.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function stopExisting() {
  const tokenFile = path.join(os.homedir(), '.keepwork-mcp', 'token');
  const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
  const response = await fetch('http://127.0.0.1:8089/admin/stop', {
    method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Cannot stop existing Keepwork MCP (HTTP ${response.status})`);
}
async function startDevelopmentRuntime(supervisor) {
  const s = supervisor;
  const { node, entry } = s.options.development;
  const pause = s.deps.delay || delay;
  try {
    for (const file of [node, entry]) {
      if (!path.isAbsolute(file) || !fs.statSync(file).isFile()) throw new Error('Development MCP executable is missing');
    }
    let existing = await s.deps.probe();
    if (existing) {
      if (!existing.compatible) throw new Error('Port 8089 is occupied by another service');
      // Recheck identity before stopping; never terminate an unrelated service or PID.
      const current = await s.deps.probe();
      if (current && (!current.compatible || current.pid !== existing.pid)) throw new Error('MCP changed during development startup; retry');
      if (current) await (s.deps.stopExisting || stopExisting)();
      for (let i = 0; i < 40; i++) {
        existing = await s.deps.probe();
        if (!existing) break;
        if (existing.pid !== current?.pid) throw new Error('Another MCP started during development startup');
        await pause(250);
      }
      if (existing) throw new Error('Existing MCP did not stop');
    }
    const env = { ...process.env, KEEPWORK_MCP_HOST_KIND: 'electron-node-runtime', KEEPWORK_MCP_HOST_VERSION: s.hostVersion };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.KEEPWORK_MCP_RUNTIME_VERSION;
    delete env.KEEPWORK_MCP_RUNTIME_COMMIT;
    const child = s.deps.spawn(node, [entry, '--port', '8089'], { cwd: path.dirname(entry), windowsHide: true, stdio: 'inherit', env });
    s.child = child;
    let failed;
    child.on('error', error => { failed = error; });
    for (let i = 0; i < 40; i++) {
      if (failed) throw failed;
      const health = await s.deps.probe();
      if (health) {
        if (!health.compatible || health.pid !== child.pid) throw new Error('Fresh MCP PID mismatch; refusing stale runtime');
        s.state = { state: 'running', owner: 'desktop', version: health.runtimeVersion, commit: health.runtimeCommit };
        child.once('exit', () => { if (!s.stopping) s.state = { state: 'error', owner: 'desktop', error: 'Development MCP exited; restart the task' }; });
        return;
      }
      if (child.exitCode !== null) throw new Error('Development MCP exited before readiness');
      await pause(250);
    }
    throw new Error('Development MCP readiness timeout');
  } catch (error) {
    await s.stop();
    s.state = { state: 'error', owner: 'desktop', error: error.message };
    throw error;
  }
}
module.exports = { startDevelopmentRuntime };
