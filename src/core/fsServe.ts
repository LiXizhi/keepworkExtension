import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { PathEscapeError, confinePath, inspectDiskPath, isAbsDiskPath, relativeToRoot } from './paths';

const MAX_FILE_BYTES = 16_000_000;

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

export function readSearchFile(rootRaw: string, relRaw: string): { rel: string; type: string; body: Buffer } {
    const root = resolveRoot(rootRaw);
    const rel = normalizeRel(relRaw);
    const abs = resolveUnderRoot(root, rel);
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
        rel: relativeToRoot(root, abs).replace(/\\/g, '/'),
        type: contentTypeFor(abs),
        body: fs.readFileSync(abs),
    };
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
        if (opts.pathname === '/fs/file') {
            const file = readSearchFile(root, rel);
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
        opts.sendJson(404, { ok: false, error: 'not found' });
        return true;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = err instanceof PathEscapeError ? 400
            : /required|must be|not a directory|not allowed|too large|path is a directory/.test(message) ? 400
                : /not found/.test(message) ? 404
                    : 400;
        opts.sendJson(status, { ok: false, error: message });
        return true;
    }
}
