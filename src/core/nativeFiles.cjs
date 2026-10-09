const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const LIMIT = 16_000_000;
function inside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}
class NativeFiles {
  constructor(file) {
    this.file = file;
    try { this.grants = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.grants = []; }
    if (!Array.isArray(this.grants)) this.grants = [];
    this.grants = this.grants.filter(g => typeof g.id === 'string' && path.isAbsolute(g.path || ''));
  }
  roots() { return this.grants.map(g => ({ ...g })); }
  // Native dialog or explicit fixed MyBrain preparation only; no arbitrary renderer path.
  grant(selected) {
    const real = fs.realpathSync(selected);
    if (!fs.statSync(real).isDirectory()) throw new Error('Select a directory');
    let grant = this.grants.find(g => g.path === real);
    if (!grant) {
      grant = { id: randomUUID(), path: real, name: path.basename(real) || real };
      this.grants.push(grant); atomicJson(this.file, this.grants);
    }
    return { ...grant };
  }
  revoke(id) { this.grants = this.grants.filter(g => g.id !== id); atomicJson(this.file, this.grants); }
  resolve(id, rel = '', { parentOnly = false } = {}) {
    const grant = this.grants.find(g => g.id === id);
    if (!grant) throw new Error('Folder is not granted; select it using Open Folder');
    if (typeof rel !== 'string' || rel.includes('\0') || rel.includes(':') || path.isAbsolute(rel)
        || rel.replace(/\\/g, '/').split('/').includes('..')) throw new Error('Invalid relative path');
    // A moved/replaced root must never acquire a new target silently.
    if (fs.realpathSync(grant.path) !== grant.path) throw new Error('Folder changed; select it again');
    const target = path.resolve(grant.path, rel || '.');
    if (!inside(grant.path, target)) throw new Error('Path escapes selected folder');
    let ancestor = parentOnly && target !== grant.path ? path.dirname(target) : target;
    while (!fs.existsSync(ancestor)) {
      // Broken symlinks must not be treated as creatable paths.
      try { if (fs.lstatSync(ancestor).isSymbolicLink()) throw new Error('Unavailable symlink target'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      const next = path.dirname(ancestor);
      if (next === ancestor) throw new Error('Folder unavailable');
      ancestor = next;
    }
    const real = fs.realpathSync(ancestor);
    if (!this.grants.some(g => {
      try { return fs.realpathSync(g.path) === g.path && inside(g.path, real); } catch { return false; }
    })) throw new Error('Symlink target requires another folder grant');
    return target;
  }
  execute(op, args = {}) {
    const { rootId, rel = '' } = args;
    const target = this.resolve(rootId, rel, { parentOnly: op === 'delete' });
    if (op === 'stat') {
      try { const s = fs.statSync(target); return { exists: true, isDirectory: s.isDirectory(), isFile: s.isFile(), size: s.size }; }
      catch (e) { if (e.code === 'ENOENT') return { exists: false }; throw e; }
    }
    if (op === 'read') {
      try {
        const stat = fs.statSync(target);
        if (!stat.isFile() || stat.size > LIMIT) throw new Error('File exceeds read limit or is not a file');
        return { bytes: new Uint8Array(fs.readFileSync(target)) };
      } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    }
    if (op === 'write') {
      const data = typeof args.text === 'string' ? Buffer.from(args.text) : Buffer.from(args.bytes || []);
      if (data.length > LIMIT) throw new Error('File exceeds write limit');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      this.resolve(rootId, rel);
      fs.writeFileSync(target, data); return { ok: true };
    }
    if (op === 'mkdir') { fs.mkdirSync(target, { recursive: true }); return { ok: true }; }
    if (op === 'delete') {
      if (!rel || target === this.resolve(rootId)) throw new Error('Cannot delete granted root');
      const s = fs.lstatSync(target);
      if (s.isDirectory() && !args.folder) throw new Error('Expected a file');
      fs.rmSync(target, { recursive: !!args.folder && !s.isSymbolicLink() }); return { ok: true };
    }
    if (op === 'list' || op === 'search') {
      const max = Math.max(1, Math.min(5000, Number(args.max) || 1000));
      const recursive = op === 'search' || args.recursive === true;
      const result = [], queue = [rel], visited = new Set(); let scanned = 0;
      while (queue.length && result.length < max && scanned < 8000) {
        const current = queue.shift(); let dir;
        try { dir = this.resolve(rootId, current); } catch { continue; }
        const real = fs.realpathSync(dir);
        if (visited.has(real)) continue;
        visited.add(real);
        for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
          if (++scanned > 8000 || result.length >= max) break;
          const relative = path.posix.join(current.replace(/\\/g, '/'), entry.name);
          let directory = entry.isDirectory();
          if (entry.isSymbolicLink()) { try { directory = fs.statSync(path.join(dir, entry.name)).isDirectory(); } catch { /* display broken link */ } }
          if (!recursive) result.push({ name: entry.name, kind: directory ? 'directory' : 'file', symlink: entry.isSymbolicLink() });
          else if (directory) { if (!['.git', 'node_modules'].includes(entry.name)) queue.push(relative); }
          else if (op !== 'search' || relative.toLowerCase().includes(String(args.query || '').toLowerCase())) result.push(relative);
        }
      }
      return { [recursive ? 'files' : 'entries']: result, truncated: queue.length > 0 || result.length >= max || scanned >= 8000 };
    }
    throw new Error('Unknown file operation');
  }
}
module.exports = { NativeFiles, inside, atomicJson };
