const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { atomicJson, inside } = require('./files.cjs');
const semver = require('semver');
const BASE = 'https://cdn.keepwork.com/keepwork/mcp-stable/';
const PRODUCT = 'keepwork-mcp-node-runtime';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function validateManifest(m, platform, arch) {
  if (m?.schemaVersion !== 1 || m.product !== PRODUCT || m.platform !== platform || m.arch !== arch
      || !semver.valid(m.version) || !/^[a-f0-9]{40}$/.test(m.commit || '')
      || !/^[a-f0-9]{64}$/.test(m.sha256 || '') || !Number.isSafeInteger(m.size) || m.size < 1 || m.size > 500_000_000
      || m.url !== `${BASE}${m.version}/${platform}-${arch}.zip`) throw new Error('Invalid stable runtime manifest');
  return m;
}
function validateRuntime(dir, platform, arch, version) {
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8'));
  if (m.schemaVersion !== 1 || m.product !== PRODUCT || m.platform !== platform || m.arch !== arch
      || !semver.valid(m.version) || (version && m.version !== version) || m.entry !== 'app/cli.cjs') throw new Error('Invalid runtime launch metadata');
  for (const rel of [platform === 'windows' ? 'node.exe' : 'bin/node', m.entry]) {
    const resolved = fs.realpathSync(path.join(dir, rel));
    if (!inside(fs.realpathSync(dir), resolved) || !fs.statSync(resolved).isFile()) throw new Error('Invalid runtime executable');
  }
  return m;
}
async function probe(port = 8089) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    const body = await response.json();
    return { reachable: true, compatible: response.ok && body.name === 'keepwork-mcp' && body.fsApi === 'workspace', ...body };
  } catch { return null; }
}
class RuntimeSupervisor {
  constructor(home, bundled, hostVersion, deps = {}) {
    this.home = home; this.bundled = bundled; this.hostVersion = hostVersion;
    this.platform = process.platform === 'win32' ? 'windows' : 'macos'; this.arch = process.arch;
    this.deps = { probe, spawn, ...deps }; this.state = { state: 'stopped', owner: 'desktop' };
    this.child = null; this.stopping = false;
    try { this.record = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8')); } catch { this.record = {}; }
  }
  save() { atomicJson(path.join(this.home, 'state.json'), this.record); }
  async refresh() {
    const health = await this.deps.probe();
    this.state = { ...this.state,
      state: !health ? 'stopped' : !health.compatible ? 'conflict' : this.child?.pid === health.pid ? 'running' : 'attached',
      owner: health ? (this.child?.pid === health.pid ? 'desktop' : health.hostKind || 'external') : 'desktop',
      version: health?.runtimeVersion, commit: health?.runtimeCommit,
      error: health?.compatible ? undefined : this.state.error,
    };
    return health;
  }
  restart() {
    if (this.restarting) return this.restarting;
    this.restarting = (async () => {
      if (this.starting) await this.starting;
      const health = await this.refresh();
      if (health && (!this.child || health.pid !== this.child.pid)) {
        throw new Error(`MCP 由 ${this.state.owner} 管理，请在该应用中重启。桌面应用已重新检测连接。`);
      }
      await this.stop();
      await this.start();
      if (!['running', 'attached'].includes(this.state.state)) throw new Error(this.state.error || 'MCP 启动失败');
      return this.state;
    })().finally(() => { this.restarting = null; });
    return this.restarting;
  }
  directory(hash) {
    if (!/^[a-f0-9]{64}$/.test(hash || '')) throw new Error('Invalid runtime identity');
    return path.join(this.home, hash);
  }
  async stop() {
    this.stopping = true;
    const child = this.child; this.child = null;
    if (child && child.exitCode === null && child.signalCode == null) {
      const ended = once(child, 'exit').catch(() => {});
      child.kill(); await Promise.race([ended, delay(5000)]);
      if (child.exitCode === null && child.signalCode == null) {
        child.kill('SIGKILL');
        await Promise.race([ended, delay(5000)]);
        if (child.exitCode === null && child.signalCode == null) { this.child = child; throw new Error('MCP 未能停止，请稍后重试'); }
      }
    }
    this.state = { ...this.state, state: 'stopped' };
  }
  start() {
    if (this.starting) return this.starting;
    this.starting = this.startRuntime().finally(() => { this.starting = null; });
    return this.starting;
  }
  async startRuntime() {
    this.stopping = false;
    const existing = await this.deps.probe();
    if (existing) {
      this.state = { state: existing.compatible ? 'attached' : 'conflict', owner: existing.hostKind || 'external',
        version: existing.runtimeVersion, commit: existing.runtimeCommit, pending: !!this.record.pending };
      return;
    }
    const candidates = [...new Set([this.record.pending, this.record.current, this.record.previous].filter(Boolean)), null];
    for (const hash of candidates) {
      try {
        const dir = hash ? this.directory(hash) : this.bundled;
        const manifest = validateRuntime(dir, this.platform, this.arch);
        const child = this.deps.spawn(path.join(dir, this.platform === 'windows' ? 'node.exe' : 'bin/node'),
          [path.join(dir, 'app/cli.cjs'), '--port', '8089'], { cwd: dir, windowsHide: true, stdio: 'ignore',
            env: { ...process.env, KEEPWORK_MCP_HOST_KIND: 'electron-node-runtime', KEEPWORK_MCP_HOST_VERSION: this.hostVersion,
              KEEPWORK_MCP_RUNTIME_VERSION: manifest.version, KEEPWORK_MCP_RUNTIME_COMMIT: manifest.commit || '' } });
        this.child = child;
        let failed; child.on('error', e => { failed = e; });
        let health;
        for (let i = 0; i < 40; i++) {
          if (failed) throw failed;
          health = await this.deps.probe();
          if (health?.compatible) break;
          if (child.exitCode !== null) throw new Error('Runtime exited before readiness');
          await delay(250);
        }
        if (!health?.compatible) throw new Error('Runtime health check failed');
        if (health.pid !== child.pid) {
          await this.stop(); this.stopping = false;
          this.state = { state: 'attached', owner: health.hostKind || 'external', pending: !!this.record.pending }; return;
        }
        if (hash && hash !== this.record.current) { this.record.previous = this.record.current; this.record.current = hash; }
        delete this.record.pending; this.save();
        this.state = { state: 'running', owner: 'desktop', version: manifest.version, commit: manifest.commit };
        child.once('exit', () => { if (!this.stopping) this.state = { ...this.state, state: 'error', error: 'MCP exited; restart the app to reconnect' }; });
        return;
      } catch (e) {
        await this.stop(); this.stopping = false;
        this.state = { state: 'error', owner: 'desktop', error: e.message };
        if (hash === this.record.pending) { delete this.record.pending; this.save(); }
      }
    }
  }
  async check() {
    if (this.checking) return this.checking;
    this.checking = this.download().finally(() => { this.checking = null; });
    return this.checking;
  }
  async download() {
    const response = await fetch(`${BASE}${this.platform}-${this.arch}.json`, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Runtime update HTTP ${response.status}`);
    const m = validateManifest(await response.json(), this.platform, this.arch);
    if (m.sha256 === this.record.current || m.sha256 === this.record.pending) return;
    if (semver.valid(this.state.version) && !semver.gt(m.version, this.state.version)) return;
    fs.mkdirSync(this.home, { recursive: true });
    const stage = fs.mkdtempSync(path.join(this.home, 'stage-'));
    try {
      const archive = path.join(stage, 'runtime.zip');
      const res = await fetch(m.url, { signal: AbortSignal.timeout(180000), redirect: 'error' });
      if (!res.ok || !res.body) throw new Error(`Runtime download HTTP ${res.status}`);
      const hash = crypto.createHash('sha256'); let size = 0;
      const fd = fs.openSync(archive, 'w');
      try { for await (const chunk of res.body) { size += chunk.length; if (size > m.size) throw new Error('Runtime size mismatch'); hash.update(chunk); fs.writeSync(fd, chunk); } }
      finally { fs.closeSync(fd); }
      if (size !== m.size || hash.digest('hex') !== m.sha256) throw new Error('Runtime integrity mismatch');
      const unpacked = path.join(stage, 'unpacked');
      await require('extract-zip')(archive, { dir: unpacked });
      const launch = validateRuntime(unpacked, this.platform, this.arch, m.version);
      if (launch.commit !== m.commit) throw new Error('Runtime commit mismatch');
      const target = this.directory(m.sha256);
      if (!fs.existsSync(target)) fs.renameSync(unpacked, target);
      this.record.pending = m.sha256; this.save();
      this.state = { ...this.state, pending: true, pendingVersion: m.version };
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  }
}
module.exports = { RuntimeSupervisor, validateManifest, validateRuntime, probe, BASE };
