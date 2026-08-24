import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { defaultUserWorkspace, DEFAULT_WORKSPACE_SLOT, readConfigFile } from './config';

export class PathEscapeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PathEscapeError';
    }
}

export function resolveWorkspaceRoot(override?: string): string {
    const candidates = [
        override,
        process.env.KEEPWORK_MCP_ROOT,
        readConfigFile().workspaceRoot,
        defaultUserWorkspace(),
    ];
    for (const raw of candidates) {
        const value = String(raw || '').trim();
        if (!value) continue;
        const resolved = path.resolve(value);
        try {
            fs.mkdirSync(resolved, { recursive: true });
            fs.mkdirSync(path.join(resolved, DEFAULT_WORKSPACE_SLOT), { recursive: true });
        } catch {
            /* still return the path */
        }
        try {
            return fs.realpathSync.native(resolved);
        } catch {
            return resolved;
        }
    }
    const fallback = path.resolve(defaultUserWorkspace());
    fs.mkdirSync(fallback, { recursive: true });
    fs.mkdirSync(path.join(fallback, DEFAULT_WORKSPACE_SLOT), { recursive: true });
    return fallback;
}

function realOrResolve(p: string): string {
    try {
        return fs.realpathSync.native(p);
    } catch {
        return path.resolve(p);
    }
}

export function expandUserPath(raw: string): string {
    const s = String(raw || '').trim();
    if (!s) return '';
    if (s === '~') return os.homedir();
    if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2));
    return s;
}

export function isAbsDiskPath(p: string): boolean {
    const s = String(p || '').trim();
    return path.isAbsolute(expandUserPath(s))
        || /^[a-zA-Z]:[\\/]/.test(s)
        || s.startsWith('/')
        || s.startsWith('\\\\')
        || s === '~'
        || s.startsWith('~/')
        || s.startsWith('~\\');
}

export function inspectDiskPath(raw: string): { exists: boolean; isDirectory: boolean; resolved: string } {
    const expanded = expandUserPath(raw);
    if (!expanded) return { exists: false, isDirectory: false, resolved: '' };
    const resolved = path.resolve(expanded);
    try {
        const st = fs.statSync(resolved);
        return { exists: true, isDirectory: st.isDirectory(), resolved: realOrResolve(resolved) };
    } catch {
        return { exists: false, isDirectory: false, resolved };
    }
}

/** Resolve `rel` under `root`. Rejects `..` and paths that escape the root. */
export function confinePath(root: string, rel?: string): string {
    const base = realOrResolve(root);
    const target = realOrResolve(path.resolve(base, String(rel || '.').replace(/\\/g, '/')));
    const prefix = base.endsWith(path.sep) ? base : base + path.sep;
    if (target !== base && !target.startsWith(prefix)) {
        throw new PathEscapeError(`Path escapes workspace root: ${rel || '.'}`);
    }
    return target;
}

/**
 * Working directory / grep path:
 * - absolute (`C:\foo`, `/foo`, `~/foo`) → that folder if it exists
 * - relative → confined to the MCP workspace root
 */
export function resolveWorkdir(root: string, cwd?: string): string {
    const raw = String(cwd || '.').trim();
    if (raw && isAbsDiskPath(raw)) {
        const info = inspectDiskPath(raw);
        if (!info.exists || !info.isDirectory) {
            throw new Error(`Directory does not exist: ${raw}`);
        }
        return info.resolved;
    }
    return confinePath(root, raw);
}

export function relativeToRoot(root: string, abs: string): string {
    const rel = path.relative(root, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return abs;
    return rel.split(path.sep).join('/');
}
