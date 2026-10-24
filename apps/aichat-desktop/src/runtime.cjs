const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { startDevelopmentRuntime } = require('./development-runtime.cjs');
const { atomicJson, inside } = require('./files.cjs');
const semver = require('semver');
const BASE = 'https://cdn.keepwork.com/keepwork/mcp-stable/';
const PRODUCT = 'keepwork-mcp-node-runtime';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function validateManifest(m, platform, arch, options = {}) {
  const product = options.product || PRODUCT;
  const base = options.base || BASE;
  if (m?.schemaVersion !== 1 || m.product !== product || m.platform !== platform || m.arch !== arch
      || !semver.valid(m.version) || !/^[a-f0-9]{40}$/.test(m.commit || '')
      || !/^[a-f0-9]{64}$/.test(m.sha256 || '') || !Number.isSafeInteger(m.size) || m.size < 1 || m.size > 500_000_000
      || (options.updates !== false && m.url !== `${base}${m.version}/${platform}-${arch}.zip`)) throw new Error('Invalid stable runtime manifest');
  return m;
}
function validateRuntime(dir, platform, arch, version, options = {}) {
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8'));
  const product = options.product || PRODUCT;
  const entry = options.entry || 'app/cli.cjs';
  if (m.schemaVersion !== 1 || m.product !== product || m.platform !== platform || m.arch !== arch
      || !semver.valid(m.version) || (version && m.version !== version) || m.entry !== entry) throw new Error('Invalid runtime launch metadata');
  for (const rel of [platform === 'windows' ? 'node.exe' : 'bin/node', m.entry]) {
    const resolved = fs.realpathSync(path.join(dir, rel));
    if (!inside(fs.realpathSync(dir), resolved) || !fs.statSync(resolved).isFile()) throw new Error('Invalid runtime executable');
  }
  return m;
}
async function probe(port = 8089, matcher = body => body.name === 'keepwork-mcp' && body.fsApi === 'workspace', healthPath = '/health') {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${healthPath}`, { signal: AbortSignal.timeout(1500) });
    const body = await response.json();
    return { reachable: true, compatible: response.ok && matcher(body), ...body };
  } catch { return null; }
}
class RuntimeSupervisor {
  constructor(home, bundled, hostVersion, deps = {}, options = {}) {
    this.home = home; this.bundled = bundled; this.hostVersion = hostVersion;
    this.options = { product: PRODUCT, port: 8089, entry: 'app/cli.cjs', updates: true, ...options };
    this.platform = process.platform === 'win32' ? 'windows' : 'macos'; this.arch = process.arch;
    this.deps = { probe: () => probe(this.options.port, this.options.matcher, this.options.healthPath), spawn, kill: (pid, signal) => process.kill(pid, signal), ...deps }; this.state = { state: 'stopped', owner: 'desktop' };
    this.child = null; this.stopping = false;
    try { this.record = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8')); } catch { this.record = {}; }
    this.update = { stale: !!this.record.latest };
  }
  save() { atomicJson(path.join(this.home, 'state.json'), this.record); }
  async refresh() {
    const health = await this.deps.probe();
    this.state = { ...this.state,
      state: !health ? 'stopped' : !health.compatible ? 'conflict' : this.child?.pid === health.pid ? 'running' : 'attached',
      owner: health ? (this.child?.pid === health.pid ? 'desktop' : health.hostKind || 'external') : 'desktop',
      version: health?.runtimeVersion || health?.version, commit: health?.runtimeCommit,
      error: health?.compatible ? undefined : this.state.error,
    };
    return health;
  }
  restart(activatePending = false) {
    if (this.restarting) return this.restarting;
    this.restarting = (async () => {
      if (this.starting) await this.starting;
      const health = await this.refresh();
      if (health && (!this.child || health.pid !== this.child.pid)) {
        throw new Error(`MCP 由 ${this.state.owner} 管理，请在该应用中重启。桌面应用已重新检测连接。`);
      }
      await this.stop();
      await this.start({ activatePending, takeover: false });
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
  start(options = {}) {
    if (this.starting) return this.starting;
    const launch = { activatePending: !this.started, takeover: !this.started, ...options };
    this.started = true;
    this.starting = this.startRuntime(launch).finally(() => { this.starting = null; });
    return this.starting;
  }
  async replaceOlderRuntime(existing, localVersion) {
    const current = await this.deps.probe();
    if (!current) return null;
    if (!current.compatible || current.pid !== existing.pid
        || !semver.valid(current.runtimeVersion)
        || !semver.lt(current.runtimeVersion, localVersion)) return current;
    if (!Number.isSafeInteger(current.pid) || current.pid <= 0 || current.pid === process.pid) {
      throw new Error('旧版 Keepwork MCP 未提供有效 PID，无法安全替换');
    }
    try { this.deps.kill(current.pid, 'SIGKILL'); }
    catch (e) { if (e.code !== 'ESRCH') throw e; }
    for (let i = 0; i < 40; i++) {
      const health = await this.deps.probe();
      if (!health) return null;
      if (health.pid !== current.pid) return health;
      await delay(250);
    }
    throw new Error('旧版 Keepwork MCP 未能停止，未启动第二个服务');
  }
  async startRuntime({ activatePending = true, takeover = true } = {}) {
    this.stopping = false;
    if (this.options.development) return startDevelopmentRuntime(this);
    const candidates = [...new Set([activatePending && this.record.pending, this.record.current, this.record.previous].filter(Boolean)), null];
    const versions = new Map();
    for (const hash of candidates) {
      try {
        versions.set(hash, validateRuntime(hash ? this.directory(hash) : this.bundled,
          this.platform, this.arch, undefined, this.options).version);
      } catch { /* Invalid candidates are handled by the existing rollback path. */ }
    }
    candidates.sort((a, b) => versions.has(a) && versions.has(b)
      ? semver.rcompare(versions.get(a), versions.get(b)) : Number(versions.has(b)) - Number(versions.has(a)));
    let existing = await this.deps.probe();
    const localVersion = versions.get(candidates[0]);
    if (takeover && this.options.product === PRODUCT && existing?.compatible && localVersion
        && semver.valid(existing.runtimeVersion)
        && semver.lt(existing.runtimeVersion, localVersion)) {
      try {
        existing = await this.replaceOlderRuntime(existing, localVersion);
      } catch (e) {
        this.state = { state: 'error', owner: existing.hostKind || 'external', error: e.message };
        return;
      }
    }
    if (existing) {
      this.state = { state: existing.compatible ? 'attached' : 'conflict', owner: existing.hostKind || 'external',
        version: existing.runtimeVersion || existing.version, commit: existing.runtimeCommit, pending: !!this.record.pending };
      return;
    }
    for (const hash of candidates) {
      try {
        const dir = hash ? this.directory(hash) : this.bundled;
        const manifest = validateRuntime(dir, this.platform, this.arch, undefined, this.options);
        const child = this.deps.spawn(path.join(dir, this.platform === 'windows' ? 'node.exe' : 'bin/node'),
          [path.join(dir, manifest.entry), ...(manifest.args || ['--port', String(this.options.port)])], { cwd: dir, windowsHide: true, stdio: 'ignore',
            env: { ...process.env, KEEPWORK_MCP_HOST_KIND: 'electron-node-runtime', KEEPWORK_MCP_HOST_VERSION: this.hostVersion,
              KEEPWORK_MCP_RUNTIME_VERSION: manifest.version, KEEPWORK_MCP_RUNTIME_COMMIT: manifest.commit || '', ...(manifest.env || {}) } });
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
        if (health.pid && health.pid !== child.pid) {
          await this.stop(); this.stopping = false;
          this.state = { state: 'attached', owner: health.hostKind || 'external', pending: !!this.record.pending }; return;
        }
        if (this.options.product === PRODUCT && hash === this.record.pending &&
            (health.pid !== child.pid || health.runtimeVersion !== manifest.version || health.runtimeCommit !== manifest.commit)) {
          throw new Error('Runtime health identity mismatch');
        }
        const activated = hash && hash === this.record.pending;
        if (activated) delete this.record.rollbackError;
        if (hash && hash !== this.record.current) { this.record.previous = this.record.current; this.record.current = hash; }
        if (activatePending) { delete this.record.pending; delete this.record.pendingMetadata; } this.save();
        this.state = { state: 'running', owner: 'desktop', version: manifest.version, commit: manifest.commit };
        if (activated) this.setUpdate({ state: 'current', error: '', progress: 100 });
        child.once('exit', () => { if (!this.stopping) this.state = { ...this.state, state: 'error', error: 'MCP exited; restart the app to reconnect' }; });
        return;
      } catch (e) {
        await this.stop(); this.stopping = false;
        this.state = { state: 'error', owner: 'desktop', error: e.message };
        if (hash === this.record.pending) {
          this.record.failed = hash; this.record.rollbackError = e.message;
          delete this.record.pending; delete this.record.pendingMetadata; this.save();
          this.setUpdate({ state: 'error', error: `更新失败，已尝试恢复原版本：${e.message}` });
        }
      }
    }
  }
  installedMetadata() {
    const candidates = [this.record.current, null].map(hash => {
      try { return validateRuntime(hash ? this.directory(hash) : this.bundled, this.platform, this.arch, undefined, this.options); }
      catch { return null; }
    }).filter(Boolean);
    return candidates.sort((a, b) => semver.rcompare(a.version, b.version))[0] || null;
  }
  updateSnapshot() {
    return { state: this.record.pending ? 'ready' : 'idle', progress: 0, ...this.update,
      currentVersion: this.installedMetadata()?.version, runningVersion: this.state.version,
      owner: this.state.owner, latest: this.record.latest, pending: this.record.pendingMetadata,
      checkedAt: this.record.checkedAt };
  }
  setUpdate(value) { this.update = { ...this.update, ...value }; this.options.onUpdate?.(this.updateSnapshot()); }
  async check(download = true) {
    if (this.checking) return this.checking;
    this.checking = (async () => {
      try { const m = await this.checkMetadata(); if (download && m) await this.download(m); }
      catch (e) { this.setUpdate({ state: 'error', error: e.message, stale: true }); throw e; }
    })().finally(() => { this.checking = null; });
    return this.checking;
  }
  async checkMetadata() {
    if (this.options.updates === false) return;
    this.setUpdate({ state: 'checking', error: '' });
    const response = await fetch(`${BASE}${this.platform}-${this.arch}.json`, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Runtime update HTTP ${response.status}`);
    const m = validateManifest(await response.json(), this.platform, this.arch, this.options);
    this.record.latest = m; this.record.checkedAt = new Date().toISOString(); this.save();
    const installed = this.installedMetadata()?.version;
    this.setUpdate({ state: this.record.pending ? 'ready' : installed && !semver.gt(m.version, installed) ? 'current' : 'available', stale: false });
    return m;
  }
  async download(m = this.record.latest) {
    if (!m) m = await this.checkMetadata();
    if (!m) return;
    if (m.sha256 === this.record.current || m.sha256 === this.record.pending) return;
    if (m.sha256 === this.record.failed) { this.setUpdate({ state: 'error', error: this.record.rollbackError || '此更新启动失败，请等待新版' }); return; }
    const installed = this.installedMetadata()?.version;
    if (installed && !semver.gt(m.version, installed)) return;
    this.setUpdate({ state: 'downloading', progress: 0, error: '' });
    fs.mkdirSync(this.home, { recursive: true });
    const stage = fs.mkdtempSync(path.join(this.home, 'stage-'));
    try {
      const archive = path.join(stage, 'runtime.zip');
      const res = await fetch(m.url, { signal: AbortSignal.timeout(180000), redirect: 'error' });
      if (!res.ok || !res.body) throw new Error(`Runtime download HTTP ${res.status}`);
      const hash = crypto.createHash('sha256'); let size = 0;
      const fd = fs.openSync(archive, 'w');
      try { for await (const chunk of res.body) { size += chunk.length; if (size > m.size) throw new Error('Runtime size mismatch'); hash.update(chunk); fs.writeSync(fd, chunk); this.setUpdate({ progress: Math.floor(size / m.size * 100) }); } }
      finally { fs.closeSync(fd); }
      if (size !== m.size || hash.digest('hex') !== m.sha256) throw new Error('Runtime integrity mismatch');
      const unpacked = path.join(stage, 'unpacked');
      await require('extract-zip')(archive, { dir: unpacked });
      const launch = validateRuntime(unpacked, this.platform, this.arch, m.version, this.options);
      if (launch.commit !== m.commit) throw new Error('Runtime commit mismatch');
      const target = this.directory(m.sha256);
      if (!fs.existsSync(target)) fs.renameSync(unpacked, target);
      this.record.pending = m.sha256; this.record.pendingMetadata = m; this.save();
      this.state = { ...this.state, pending: true, pendingVersion: m.version };
      this.setUpdate({ state: 'ready', progress: 100 });
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  }
}
module.exports = { RuntimeSupervisor, validateManifest, validateRuntime, probe, BASE };
