import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { tryRevealInVscode } from './vscodeBridge';
import {
    PathEscapeError, confineLexical, confinePath, inspectDiskPath, isAbsDiskPath, relativeToRoot,
} from './paths';

export const FS_API = 'workspace';
const MAX_FILE_BYTES = 16_000_000;
const DEFAULT_LIST_MAX = 1000;
const MAX_LIST_MAX = 5000;

// MIME from extension so other clients can use /fs/file like a normal file URL
// (img, html, lua in a tab). Never append charset=: that makes XHR decode the
// body. Unspecified charset means display clients may assume utf-8; the body
// is still the on-disk bytes.
const MIME: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.tga': 'image/x-tga',
    '.dds': 'image/vnd-ms.dds',
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.lua': 'text/plain',
    '.npl': 'text/plain',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
    '.xml': 'application/xml',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.page': 'text/html',
    '.mcml': 'text/html',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.wasm': 'application/wasm',
    '.pdf': 'application/pdf',
    '.table': 'text/plain',
    '.fx': 'text/plain',
};

function normalizeRel(rel: string): string {
    return String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

function contentTypeFor(filename: string): string {
    return MIME[path.extname(filename).toLowerCase()] || 'application/octet-stream';
}

function wantsBase64(url: URL): boolean {
    const v = String(url.searchParams.get('base64') || '').trim().toLowerCase();
    return v === 'true' || v === '1';
}

function wantsLinks(url: URL): boolean {
    const v = String(url.searchParams.get('links') || '').trim().toLowerCase();
    return v === 'include' || v === '1' || v === 'true';
}

function wantsRecursive(url: URL): boolean {
    const v = String(url.searchParams.get('recursive') || '').trim().toLowerCase();
    return v === '1' || v === 'true';
}

function parseMax(url: URL): number {
    const n = Number(url.searchParams.get('max') || DEFAULT_LIST_MAX);
    if (!Number.isFinite(n) || n < 1) return DEFAULT_LIST_MAX;
    return Math.min(MAX_LIST_MAX, Math.floor(n));
}

function resolveRoot(raw: string): string {
    const value = String(raw || '').trim();
    if (!value) throw new Error('root is required');
    if (!isAbsDiskPath(value)) throw new Error('root must be an absolute disk path');
    const info = inspectDiskPath(value);
    if (!info.exists || !info.isDirectory) throw new Error(`root is not a directory: ${value}`);
    return info.resolved;
}

function resolveUnderRoot(root: string, rel: string, { includeLinks = false } = {}): string {
    const norm = normalizeRel(rel);
    if (!norm) throw new Error('path is required');
    if (norm.split('/').some((p) => p === '..')) throw new PathEscapeError(`Path escapes root: ${rel}`);
    return includeLinks ? confineLexical(root, norm) : confinePath(root, norm);
}

function resolveDir(rootRaw: string, relRaw: string): { root: string; rel: string; abs: string } {
    const root = resolveRoot(rootRaw);
    const rel = normalizeRel(relRaw);
    const abs = rel ? confineLexical(root, rel) : root;
    let st: fs.Stats;
    try {
        st = fs.statSync(abs);
    } catch {
        throw new Error(`file not found: ${rel || '.'}`);
    }
    if (!st.isDirectory()) throw new Error('path is not a directory');
    return { root, rel, abs };
}

function classifyDirent(dir: string, dirent: fs.Dirent): { name: string; kind: 'file' | 'directory'; symlink: boolean } {
    const name = dirent.name;
    const symlink = dirent.isSymbolicLink();
    if (symlink) {
        try {
            const st = fs.statSync(path.join(dir, name));
            return { name, kind: st.isDirectory() ? 'directory' : 'file', symlink: true };
        } catch {
            return { name, kind: 'file', symlink: true };
        }
    }
    return { name, kind: dirent.isDirectory() ? 'directory' : 'file', symlink: false };
}

function realKey(abs: string): string {
    try {
        return fs.realpathSync.native(abs);
    } catch {
        return path.resolve(abs);
    }
}

export function readSearchFile(rootRaw: string, relRaw: string, { includeLinks = false } = {}): { rel: string; type: string; body: Buffer } {
    const root = resolveRoot(rootRaw);
    const rel = normalizeRel(relRaw);
    const abs = resolveUnderRoot(root, rel, { includeLinks });
    let st: fs.Stats;
    try {
        st = fs.statSync(abs);
    } catch {
        throw new Error(`file not found: ${rel}`);
    }
    if (st.isDirectory()) throw new Error('path is a directory');
    if (!st.isFile()) throw new Error(`not a file: ${rel}`);
    if (st.size > MAX_FILE_BYTES) throw new Error(`file too large: ${rel}`);
    return {
        rel: includeLinks ? rel.replace(/\\/g, '/') : relativeToRoot(root, abs).replace(/\\/g, '/'),
        type: contentTypeFor(abs),
        body: fs.readFileSync(abs),
    };
}

function listDir(rootRaw: string, relRaw: string, max: number) {
    const { rel, abs } = resolveDir(rootRaw, relRaw);
    const dirents = fs.readdirSync(abs, { withFileTypes: true });
    const entries: { name: string; kind: 'file' | 'directory'; symlink: boolean }[] = [];
    let truncated = false;
    for (const dirent of dirents) {
        if (entries.length >= max) {
            truncated = true;
            break;
        }
        entries.push(classifyDirent(abs, dirent));
    }
    entries.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
    return { path: rel, entries, truncated };
}

function listFilesRecursive(rootRaw: string, relRaw: string, max: number) {
    const { rel, abs } = resolveDir(rootRaw, relRaw);
    const files: string[] = [];
    const queue: { dir: string; prefix: string }[] = [{ dir: abs, prefix: rel }];
    const seen = new Set<string>([realKey(abs)]);
    let truncated = false;
    let seenCount = 0;

    while (queue.length && !truncated) {
        const { dir, prefix } = queue.shift()!;
        let dirents: fs.Dirent[];
        try {
            dirents = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const dirent of dirents) {
            if (seenCount >= max) {
                truncated = true;
                break;
            }
            seenCount += 1;
            const child = path.join(dir, dirent.name);
            const childRel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
            const info = classifyDirent(dir, dirent);
            if (info.kind === 'directory') {
                const key = realKey(child);
                if (seen.has(key)) continue;
                seen.add(key);
                queue.push({ dir: child, prefix: childRel });
            } else {
                files.push(childRel.replace(/\\/g, '/'));
            }
        }
    }
    return { path: rel, files, truncated };
}

const SEARCH_SCAN_CAP = 8000;
const SEARCH_SKIP_DIRS = new Set([
    '.git', '.svn', '.hg', 'node_modules', 'dist', 'out', '.cursor',
    '.vscode-test', 'bin', 'obj', '.next', 'coverage',
]);

function searchFilesByName(rootRaw: string, relRaw: string, query: string, max: number) {
    const { rel, abs } = resolveDir(rootRaw, relRaw);
    const q = String(query || '').toLowerCase();
    const files: string[] = [];
    const queue: { dir: string; prefix: string }[] = [{ dir: abs, prefix: rel }];
    const seen = new Set<string>([realKey(abs)]);
    let truncated = false;
    let scanned = 0;

    while (queue.length && files.length < max && !truncated) {
        const { dir, prefix } = queue.shift()!;
        let dirents: fs.Dirent[];
        try {
            dirents = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const dirent of dirents) {
            if (scanned >= SEARCH_SCAN_CAP) {
                truncated = true;
                break;
            }
            scanned += 1;
            const child = path.join(dir, dirent.name);
            const childRel = (prefix ? `${prefix}/${dirent.name}` : dirent.name).replace(/\\/g, '/');
            const info = classifyDirent(dir, dirent);
            if (info.kind === 'directory') {
                if (SEARCH_SKIP_DIRS.has(dirent.name)) continue;
                const key = realKey(child);
                if (seen.has(key)) continue;
                seen.add(key);
                queue.push({ dir: child, prefix: childRel });
            } else if (!q || childRel.toLowerCase().includes(q) || dirent.name.toLowerCase().includes(q)) {
                files.push(childRel);
                if (files.length >= max) break;
            }
        }
    }
    return { path: rel, query, files, truncated: truncated || files.length >= max };
}

function statPath(rootRaw: string, relRaw: string, { includeLinks = false } = {}) {
    const root = resolveRoot(rootRaw);
    const rel = normalizeRel(relRaw);
    if (!rel) {
        return { exists: true, isFile: false, isDirectory: true, symlink: false, size: 0, rel: '' };
    }
    const abs = resolveUnderRoot(root, rel, { includeLinks });
    let lst: fs.Stats;
    try {
        lst = fs.lstatSync(abs);
    } catch {
        return { exists: false, isFile: false, isDirectory: false, symlink: false, size: 0, rel };
    }
    let st = lst;
    if (lst.isSymbolicLink()) {
        try { st = fs.statSync(abs); } catch { /* broken link */ }
    }
    return {
        exists: true,
        isFile: st.isFile(),
        isDirectory: st.isDirectory(),
        symlink: lst.isSymbolicLink(),
        size: st.isFile() ? st.size : 0,
        rel,
    };
}

function writeSearchFile(rootRaw: string, relRaw: string, body: Buffer) {
    const root = resolveRoot(rootRaw);
    const rel = normalizeRel(relRaw);
    const abs = resolveUnderRoot(root, rel, { includeLinks: true });
    if (body.length > MAX_FILE_BYTES) throw new Error(`file too large: ${rel}`);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
    return { rel, size: body.length };
}

function createDirectory(rootRaw: string, relRaw: string) {
    const root = resolveRoot(rootRaw);
    const rel = normalizeRel(relRaw);
    if (!rel) return { rel: '', created: false };
    const abs = resolveUnderRoot(root, rel, { includeLinks: true });
    let created = false;
    try {
        const st = fs.statSync(abs);
        if (!st.isDirectory()) throw new Error('path is not a directory');
    } catch (err) {
        if (err instanceof Error && err.message === 'path is not a directory') throw err;
        fs.mkdirSync(abs, { recursive: true });
        created = true;
    }
    return { rel, created };
}

function revealInOs(abs: string, folder: boolean): void {
    if (process.platform === 'win32') {
        const args = folder ? [abs] : [`/select,${abs}`];
        spawn('explorer.exe', args, { detached: true, stdio: 'ignore' }).unref();
        return;
    }
    if (process.platform === 'darwin') {
        spawn('open', folder ? [abs] : ['-R', abs], { detached: true, stdio: 'ignore' }).unref();
        return;
    }
    const dir = folder ? abs : path.dirname(abs);
    spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref();
}

/** Open a file (or folder) with the OS default application. */
function openInOs(abs: string): void {
    if (process.platform === 'win32') {
        spawn('cmd', ['/c', 'start', '', abs], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        return;
    }
    if (process.platform === 'darwin') {
        spawn('open', [abs], { detached: true, stdio: 'ignore' }).unref();
        return;
    }
    spawn('xdg-open', [abs], { detached: true, stdio: 'ignore' }).unref();
}

function revealMode(url: URL): 'reveal' | 'open' | 'dir' {
    const mode = String(url.searchParams.get('mode') || '').trim().toLowerCase();
    if (mode === 'open' || mode === 'dir' || mode === 'reveal') return mode;
    if (/^(1|true)$/i.test(String(url.searchParams.get('open') || ''))) return 'open';
    if (/^(1|true)$/i.test(String(url.searchParams.get('dir') || ''))) return 'dir';
    return 'reveal';
}

async function revealPath(rootRaw: string, relRaw: string, mode: 'reveal' | 'open' | 'dir' = 'reveal') {
    const root = resolveRoot(rootRaw);
    const rel = normalizeRel(relRaw);
    const abs = rel ? confineLexical(root, rel) : root;
    let st: fs.Stats;
    try {
        st = fs.statSync(abs);
    } catch {
        throw new Error(`file not found: ${rel || '.'}`);
    }
    const folder = st.isDirectory();
    if (mode === 'open') {
        openInOs(abs);
        return { rel, via: 'os', mode };
    }
    if (mode === 'dir') {
        const dir = folder ? abs : path.dirname(abs);
        const viaVscode = await tryRevealInVscode(dir);
        if (!viaVscode) revealInOs(dir, true);
        return { rel, via: viaVscode ? 'vscode' : 'os', mode };
    }
    const viaVscode = await tryRevealInVscode(abs);
    if (!viaVscode) revealInOs(abs, folder);
    return { rel, via: viaVscode ? 'vscode' : 'os', mode: 'reveal' };
}

function deletePath(rootRaw: string, relRaw: string, { folder = false } = {}) {
    const root = resolveRoot(rootRaw);
    const rel = normalizeRel(relRaw);
    if (!rel) throw new Error('path is required');
    const abs = resolveUnderRoot(root, rel, { includeLinks: true });
    let lst: fs.Stats;
    try {
        lst = fs.lstatSync(abs);
    } catch {
        throw new Error(`file not found: ${rel}`);
    }
    if (folder) {
        if (!lst.isDirectory() && !lst.isSymbolicLink()) throw new Error('path is not a directory');
        fs.rmSync(abs, { recursive: true, force: false });
    } else {
        if (lst.isDirectory() && !lst.isSymbolicLink()) throw new Error('path is a directory');
        fs.rmSync(abs, { force: false });
    }
    return { rel };
}

function fsStatus(err: unknown): number {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof PathEscapeError) return 400;
    if (/required|must be|not a directory|not allowed|too large|path is a directory/.test(message)) return 400;
    if (/not found/.test(message)) return 404;
    return 400;
}

export async function tryHandleFs(opts: {
    pathname: string;
    method: string;
    url: URL;
    res: http.ServerResponse;
    readBodyBuffer?: () => Promise<Buffer>;
    sendJson: (status: number, body: unknown) => void;
}): Promise<boolean> {
    if (!opts.pathname.startsWith('/fs')) return false;

    const method = opts.method.toUpperCase();
    const root = String(opts.url.searchParams.get('root') || '').trim();
    const rel = String(opts.url.searchParams.get('path') || '').trim();
    const includeLinks = wantsLinks(opts.url);

    try {
        if (opts.pathname === '/fs/list' && method === 'GET') {
            const max = parseMax(opts.url);
            if (wantsRecursive(opts.url)) {
                opts.sendJson(200, { ok: true, ...listFilesRecursive(root, rel, max) });
            } else {
                opts.sendJson(200, { ok: true, ...listDir(root, rel, max) });
            }
            return true;
        }

        if (opts.pathname === '/fs/search' && method === 'GET') {
            const q = String(opts.url.searchParams.get('q') || opts.url.searchParams.get('query') || '').trim();
            opts.sendJson(200, { ok: true, ...searchFilesByName(root, rel, q, parseMax(opts.url)) });
            return true;
        }

        if (opts.pathname === '/fs/stat' && method === 'GET') {
            opts.sendJson(200, { ok: true, ...statPath(root, rel, { includeLinks: true }) });
            return true;
        }

        if (opts.pathname === '/fs/file' && method === 'GET') {
            const file = readSearchFile(root, rel, { includeLinks });
            if (wantsBase64(opts.url)) {
                opts.sendJson(200, {
                    ok: true,
                    size: file.body.length,
                    rel: file.rel,
                    type: file.type,
                    base64: file.body.toString('base64'),
                });
                return true;
            }
            opts.res.writeHead(200, {
                'Content-Type': file.type,
                'Cache-Control': 'no-store',
                'Content-Length': file.body.length,
                'X-Content-Type-Options': 'nosniff',
                'X-Search-Path': encodeURIComponent(file.rel),
            });
            opts.res.end(file.body);
            return true;
        }

        if (opts.pathname === '/fs/file' && method === 'PUT') {
            if (!opts.readBodyBuffer) {
                opts.sendJson(500, { ok: false, error: 'readBodyBuffer missing' });
                return true;
            }
            const body = await opts.readBodyBuffer();
            opts.sendJson(200, { ok: true, ...writeSearchFile(root, rel, body) });
            return true;
        }

        if (opts.pathname === '/fs/file' && method === 'DELETE') {
            opts.sendJson(200, { ok: true, ...deletePath(root, rel, { folder: false }) });
            return true;
        }

        if (opts.pathname === '/fs/dir' && method === 'PUT') {
            opts.sendJson(200, { ok: true, ...createDirectory(root, rel) });
            return true;
        }

        if (opts.pathname === '/fs/dir' && method === 'DELETE') {
            opts.sendJson(200, { ok: true, ...deletePath(root, rel, { folder: true }) });
            return true;
        }

        if (opts.pathname === '/fs/reveal' && (method === 'POST' || method === 'GET')) {
            opts.sendJson(200, { ok: true, ...await revealPath(root, rel, revealMode(opts.url)) });
            return true;
        }

        if (opts.pathname.startsWith('/fs')) {
            opts.sendJson(method === 'GET' || method === 'PUT' || method === 'DELETE' ? 404 : 405, {
                ok: false,
                error: method === 'GET' || method === 'PUT' || method === 'DELETE' ? 'not found' : 'method not allowed',
            });
            return true;
        }
        return false;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        opts.sendJson(fsStatus(err), { ok: false, error: message });
        return true;
    }
}
