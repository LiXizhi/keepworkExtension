#!/usr/bin/env node
// Explicit, offline maintenance only. Never deduplicate identities at startup.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { createHash, randomUUID } = require('node:crypto');

const hash = data => createHash('sha256').update(data).digest('hex');
const filePattern = /^[a-f0-9]{64}\.json$/;
const groupPattern = /^[a-f0-9]{64}$/;
const lockName = 'persona-maintenance.lock';
const knownFields = new Set(['owner', 'id', 'name', 'avatar', 'prompt', 'root', 'executor', 'model', 'pinned', 'order', 'messages', 'requests', 'schedules', 'summary', 'readAt', 'messaging', 'preference']);
const stateFields = new Set(['owner', 'messages', 'requests', 'schedules', 'summary', 'readAt']);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const stable = value => JSON.stringify(value, (_, v) => plain(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);

function realDirectory(dir) {
  const absolute = path.resolve(dir);
  if (!fs.lstatSync(absolute).isDirectory() || fs.realpathSync(absolute) !== absolute) throw Error('Profile/archive directory must be a real directory without symlinks');
  return absolute;
}
function readRegular(file) {
  if (!fs.lstatSync(file).isFile()) throw Error('Refusing a symlink or non-regular file');
  return fs.readFileSync(file);
}
function privateJson(file, value) {
  const temp = file + '.' + randomUUID() + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, file);
}
function readState(profileDir) {
  profileDir = realDirectory(profileDir);
  const dir = realDirectory(path.join(profileDir, 'personas-v1'));
  const rows = fs.readdirSync(dir).filter(name => filePattern.test(name)).sort().map(file => {
    const bytes = readRegular(path.join(dir, file));
    const row = JSON.parse(bytes);
    if (!plain(row) || !groupPattern.test(row.owner || '') || !/^[A-Za-z0-9_-]{1,160}$/.test(row.id || '') || file !== hash(row.owner + '\0' + row.id) + '.json') throw Error('Invalid persona record');
    return { file, bytes, row, sha256: hash(bytes), group: hash(row.owner) };
  });
  const messagingDir = path.join(profileDir, 'messaging-v1');
  const bindingFile = path.join(messagingDir, 'bindings.json');
  if (fs.existsSync(messagingDir)) realDirectory(messagingDir);
  const bindingBytes = fs.existsSync(bindingFile) ? readRegular(bindingFile) : null;
  const bindings = bindingBytes ? JSON.parse(bindingBytes) : [];
  if (!Array.isArray(bindings)) throw Error('Invalid messaging bindings');
  const referenced = new Set();
  for (const binding of bindings) {
    if (!plain(binding) || binding.peers !== undefined && !Array.isArray(binding.peers)) throw Error('Invalid messaging binding references');
    if (binding.agentOwner) {
      if (!binding.agentId) throw Error('Messaging binding has an unscoped owner');
      referenced.add(binding.agentOwner + '\0' + binding.agentId);
    }
    for (const peer of binding.peers || []) {
      if (!plain(peer) || !peer.owner || !peer.agentId) throw Error('Invalid messaging peer');
      referenced.add(peer.owner + '\0' + peer.agentId);
    }
  }
  return { profileDir, dir, rows, referenced, storeDigest: hash(stable([rows.map(r => [r.file, r.sha256]), bindingBytes ? hash(bindingBytes) : null])) };
}
function protection(row, referenced) {
  if (Object.keys(row).some(k => !knownFields.has(k))) return 'state-or-unknown-fields';
  if (!Array.isArray(row.messages) || row.messages.length || !Array.isArray(row.schedules) || row.schedules.length || !plain(row.requests) || Object.keys(row.requests).length || typeof row.summary !== 'string' || row.summary) return 'history-or-tasks';
  if (row.messaging != null && (!plain(row.messaging) || Object.keys(row.messaging).some(k => !['version', 'enabled', 'groups'].includes(k)) || row.messaging.version !== 1 || row.messaging.enabled !== false || !Array.isArray(row.messaging.groups) || row.messaging.groups.length)) return 'messaging-configuration';
  if (referenced.has(row.owner + '\0' + row.id)) return 'messaging-binding';
  return '';
}
function configuration(row) {
  const config = Object.fromEntries(Object.entries(row).filter(([k]) => !stateFields.has(k)));
  if (config.messaging == null || stable(config.messaging) === stable({ version: 1, enabled: false, groups: [] })) delete config.messaging;
  return stable(config);
}
function createPlan(profileDir, obsoleteOwnerGroups, protectedOwnerGroups) {
  if (![obsoleteOwnerGroups, protectedOwnerGroups].every(groups => Array.isArray(groups) && groups.every(group => typeof group === 'string' && groupPattern.test(group)))) throw Error('Explicit full identity-group fingerprints are required');
  const state = readState(profileDir);
  const obsolete = new Set(obsoleteOwnerGroups), protectedGroups = new Set(protectedOwnerGroups);
  const keep = [], eligible = [], peers = new Map();
  for (const item of state.rows) {
    const reason = protectedGroups.has(item.group) ? 'protected-identity' : !obsolete.has(item.group) ? 'identity-not-confirmed-obsolete' : protection(item.row, state.referenced);
    if (reason) {
      keep.push({ file: item.file, reason });
      const config = configuration(item.row), previous = peers.get(config);
      if (!previous || protectedGroups.has(item.group) && !protectedGroups.has(previous.group)) peers.set(config, item);
    }
    else eligible.push(item);
  }
  const candidates = [];
  for (const item of eligible) {
    const config = configuration(item.row), retained = peers.get(config);
    if (!retained) { peers.set(config, item); keep.push({ file: item.file, reason: 'retain-unique-configuration' }); continue; }
    candidates.push({ file: item.file, sha256: item.sha256, retainedFile: retained.file, retainedSha256: retained.sha256 });
  }
  return { version: 1, profileDir: state.profileDir, storeDigest: state.storeDigest, obsoleteOwnerGroups: [...obsolete].sort(), protectedOwnerGroups: [...protectedGroups].sort(), candidates, kept: keep };
}
function validatePlan(plan) {
  if (!plain(plan) || plan.version !== 1 || !Array.isArray(plan.candidates) || !Array.isArray(plan.kept)) throw Error('Invalid archive plan');
  for (const item of plan.candidates) {
    if (!plain(item) || !filePattern.test(item.file || '') || !filePattern.test(item.retainedFile || '') || !groupPattern.test(item.sha256 || '') || !groupPattern.test(item.retainedSha256 || '')) throw Error('Invalid archive filename or hash');
  }
  const current = createPlan(plan.profileDir, plan.obsoleteOwnerGroups, plan.protectedOwnerGroups);
  if (stable(current) !== stable(plan)) throw Error('Persona store, retained peer, bindings or plan changed; create a fresh plan');
  return current;
}
function applyPlan(plan) {
  validatePlan(plan);
  if (!plan.candidates.length) return { archiveDir: null, archived: 0, retained: plan.kept.length };
  const archives = path.join(plan.profileDir, 'persona-archives');
  fs.mkdirSync(archives, { mode: 0o700, recursive: true });
  realDirectory(archives);
  const archiveDir = path.join(archives, new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID());
  fs.mkdirSync(archiveDir, { mode: 0o700 });
  const files = path.join(archiveDir, 'files');
  fs.mkdirSync(files, { mode: 0o700 });
  // Back up every selected byte before unlinking any source. Even interrupted
  // operations can be restored from this intent manifest and actual files.
  const manifest = { ...plan, archived: 0 };
  privateJson(path.join(archiveDir, 'manifest.json'), manifest);
  for (const item of plan.candidates) {
    const bytes = readRegular(path.join(plan.profileDir, 'personas-v1', item.file));
    if (hash(bytes) !== item.sha256) throw Error('Source changed before backup; retained source is untouched');
    fs.writeFileSync(path.join(files, item.file), bytes, { mode: 0o600, flag: 'wx' });
  }
  validatePlan(plan);
  for (const item of plan.candidates) {
    const source = path.join(plan.profileDir, 'personas-v1', item.file);
    if (hash(readRegular(source)) !== item.sha256 || hash(readRegular(path.join(plan.profileDir, 'personas-v1', item.retainedFile))) !== item.retainedSha256 || hash(readRegular(path.join(files, item.file))) !== item.sha256) throw Error('Record changed during archive; recover using the archive manifest');
    fs.unlinkSync(source);
    manifest.archived++;
    privateJson(path.join(archiveDir, 'manifest.json'), manifest);
  }
  return { archiveDir, archived: manifest.archived, retained: plan.kept.length };
}
function restoreArchive(archiveDir) {
  archiveDir = realDirectory(archiveDir);
  const manifest = JSON.parse(readRegular(path.join(archiveDir, 'manifest.json')));
  if (manifest.version !== 1 || !Array.isArray(manifest.candidates)) throw Error('Invalid archive manifest');
  const dir = realDirectory(path.join(realDirectory(manifest.profileDir), 'personas-v1'));
  const files = realDirectory(path.join(archiveDir, 'files'));
  const rows = manifest.candidates.map(item => {
    if (!filePattern.test(item.file || '') || !groupPattern.test(item.sha256 || '')) throw Error('Invalid archive filename or hash');
    const target = path.join(dir, item.file);
    try {
      fs.lstatSync(target);
      if (hash(readRegular(target)) === item.sha256) return null;
      throw Error('Restore conflict: refusing to overwrite existing persona');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const bytes = readRegular(path.join(files, item.file));
    if (hash(bytes) !== item.sha256) throw Error('Archive hash mismatch');
    return { target, bytes };
  }).filter(Boolean);
  for (const { target, bytes } of rows) fs.writeFileSync(target, bytes, { mode: 0o600, flag: 'wx' });
  return { restored: rows.length };
}
async function withOfflineProfile(profileDir, operation) {
  profileDir = realDirectory(profileDir);
  const lock = path.join(profileDir, lockName), nonce = randomUUID();
  const contents = JSON.stringify({ pid: process.pid, nonce });
  if (fs.existsSync(lock)) {
    const staleBytes = readRegular(lock), stale = JSON.parse(staleBytes);
    if (!Number.isInteger(stale.pid) || stale.pid <= 0) throw Error('Invalid maintenance lock; inspect before recovery');
    try { process.kill(stale.pid, 0); throw Error('Persona maintenance is already running'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    if (!readRegular(lock).equals(staleBytes)) throw Error('Maintenance lock changed');
    fs.unlinkSync(lock);
  }
  fs.writeFileSync(lock, contents, { mode: 0o600, flag: 'wx' });
  const listeners = [];
  try {
    const ports = new Set([8089]);
    for (const name of ['instance.json', 'config.json']) {
      const file = path.join(profileDir, name);
      if (!fs.existsSync(file)) continue;
      const info = JSON.parse(readRegular(file));
      if (info.port !== undefined) {
        if (!Number.isInteger(info.port) || info.port < 1 || info.port > 65535) throw Error('Invalid stored MCP port');
        ports.add(info.port);
      }
      if (name === 'instance.json' && Number.isInteger(info.pid) && info.pid > 0) {
        try { process.kill(info.pid, 0); throw Error('MCP process is still running; stop the host and daemon first'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
    for (const port of ports) {
      const listener = net.createServer(socket => socket.destroy());
      await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(port, '127.0.0.1', resolve); });
      listeners.push(listener);
    }
    return await operation();
  } finally {
    for (const listener of listeners) await new Promise(resolve => listener.close(resolve));
    if (readRegular(lock).toString() === contents) fs.unlinkSync(lock);
  }
}
async function main(args) {
  const [command, input] = args;
  if (command === 'plan' && args.length === 3) {
    const selection = JSON.parse(readRegular(args[2]));
    process.stdout.write(JSON.stringify(createPlan(input, selection.obsoleteOwnerGroups, selection.protectedOwnerGroups), null, 2) + '\n');
  } else if (command === 'apply' && args.length === 2) {
    const plan = JSON.parse(readRegular(input));
    console.log(JSON.stringify(await withOfflineProfile(plan.profileDir, () => applyPlan(plan))));
  } else if (command === 'restore' && args.length === 2) {
    const archiveDir = realDirectory(input);
    const manifest = JSON.parse(readRegular(path.join(archiveDir, 'manifest.json')));
    console.log(JSON.stringify(await withOfflineProfile(manifest.profileDir, () => restoreArchive(archiveDir))));
  } else throw Error('Usage: archive-personas.cjs plan <.keepwork-mcp directory> <selection.json> | apply <plan.json> | restore <archive directory>');
}
module.exports = { createPlan, applyPlan, restoreArchive, withOfflineProfile };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
