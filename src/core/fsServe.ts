import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { PathEscapeError, confinePath, inspectDiskPath, isAbsDiskPath, relativeToRoot } from './paths';

const SKIP_DIRS = new Set([
    '.git', '.svn', '.hg', 'node_modules', 'dist', 'out', '.cursor',
    '.vscode-test', 'bin', 'obj', '.next', 'coverage',
]);

const ALLOWED_EXT = new Set([
    '.lua', '.xml', '.html', '.htm', '.page', '.json', '.md', '.txt', '.csv',
    '.mcml', '.js', '.npl', '.table', '.fx',
]);

const MAX_FILES = 4000;
const MAX_FILE_BYTES = 2_000_000;

export interface FsListResult {
    ok: true;
    root: string;
    path: string;
    files: string[];
    truncated: boolean;
}

function normalizeRel(rel: string): string {
    return String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

function extAllowed(filename: string): boolean {
    return ALLOWED_EXT.has(path.extname(filename).toLowerCase());
}

function resolveRoot(raw: string): string {
    const value = String(raw || '').trim();
    if (!value) throw new Error('root is required');
    if (!isAbsDiskPath(value)) throw new Error('root must be an absolute disk path');
    const info = inspectDiskPath(value);
    if (!info.exists || !info.isDirectory) throw new Error(`root is not a directory: ${value}`);
    return info.resolved;
}

function resolveUnderRoot(root: string, rel: string): string {
    const norm = normalizeRel(rel);
    if (!norm) throw new Error('path is required');
    if (norm.split('/').some((p) => p === '..')) throw new PathEscapeError(`Path escapes root: ${rel}`);
    return confinePath(root, norm);
}

function walkFiles(root: string, start: string, out: string[]): boolean {
    let truncated = false;
    const visit = (dir: string) => {
        if (out.length >= MAX_FILES) {
            truncated = true;
            return;
        }
        let entries: fs.Dirent[] = [];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const ent of entries) {
            if (out.length >= MAX_FILES) {
                truncated = true;
                return;
            }
            if (ent.name === '.' || ent.name === '..') continue;
            const abs = path.join(dir, ent.name);
            if (ent.isSymbolicLink()) continue;
            if (ent.isDirectory()) {
                if (SKIP_DIRS.has(ent.name)) continue;
                visit(abs);
                continue;
            }
            if (!ent.isFile()) continue;
            if (!extAllowed(ent.name)) continue;
            let stat: fs.Stats;
            try { stat = fs.statSync(abs); } catch { continue; }
            if (stat.size > MAX_FILE_BYTES) continue;
            out.push(relativeToRoot(root, abs).replace(/\\/g, '/'));
        }
    };
    visit(start);
    return truncated;
}

export function listSearchFiles(rootRaw: string, relRaw: string): FsListResult {
    const root = resolveRoot(rootRaw);
    const rel = normalizeRel(relRaw);
    const abs = resolveUnderRoot(root, rel);
    let st: fs.Stats;
    try {
        st = fs.statSync(abs);
    } catch {
        throw new Error(`path not found: ${rel}`);
    }
    const files: string[] = [];
    let truncated = false;
    if (st.isFile()) {
        if (!extAllowed(abs)) throw new Error(`file type not allowed: ${rel}`);
        if (st.size > MAX_FILE_BYTES) throw new Error(`file too large: ${rel}`);
        files.push(relativeToRoot(root, abs).replace(/\\/g, '/'));
    } else if (st.isDirectory()) {
        truncated = walkFiles(root, abs, files);
    } else {
        throw new Error(`path is not a file or directory: ${rel}`);
    }
    files.sort();
    return { ok: true, root, path: rel, files, truncated };
}

export function readSearchFile(rootRaw: string, relRaw: string): { rel: string; body: Buffer } {
    const root = resolveRoot(rootRaw);
    const rel = normalizeRel(relRaw);
    const abs = resolveUnderRoot(root, rel);
    let st: fs.Stats;
    try {
        st = fs.statSync(abs);
    } catch {
        throw new Error(`file not found: ${rel}`);
    }
    if (!st.isFile()) throw new Error(`not a file: ${rel}`);
    if (!extAllowed(abs)) throw new Error(`file type not allowed: ${rel}`);
    if (st.size > MAX_FILE_BYTES) throw new Error(`file too large: ${rel}`);
    return { rel: relativeToRoot(root, abs).replace(/\\/g, '/'), body: fs.readFileSync(abs) };
}

export function tryHandleFs(opts: {
    pathname: string;
    method: string;
    url: URL;
    res: http.ServerResponse;
    sendJson: (status: number, body: unknown) => void;
}): boolean {
    if (!opts.pathname.startsWith('/fs')) return false;
    if (opts.method !== 'GET') {
        opts.sendJson(405, { ok: false, error: 'method not allowed' });
        return true;
    }

    const root = String(opts.url.searchParams.get('root') || '').trim();
    const rel = String(opts.url.searchParams.get('path') || '').trim();

    try {
        if (opts.pathname === '/fs/list') {
            opts.sendJson(200, listSearchFiles(root, rel));
            return true;
        }
        if (opts.pathname === '/fs/file') {
            const file = readSearchFile(root, rel);
            opts.res.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'Cache-Control': 'no-store',
                'Content-Length': file.body.length,
                'X-Search-Path': encodeURIComponent(file.rel),
            });
            opts.res.end(file.body);
            return true;
        }
        opts.sendJson(404, { ok: false, error: 'not found' });
        return true;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = err instanceof PathEscapeError ? 400
            : /required|must be|not a directory|not allowed|too large/.test(message) ? 400
                : /not found/.test(message) ? 404
                    : 400;
        opts.sendJson(status, { ok: false, error: message });
        return true;
    }
}
