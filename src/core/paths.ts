import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readConfigFile } from './config';

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
        process.cwd(),
        os.homedir(),
    ];
    for (const raw of candidates) {
        const value = String(raw || '').trim();
        if (!value) continue;
        try {
            return fs.realpathSync.native(path.resolve(value));
        } catch {
            return path.resolve(value);
        }
    }
    return path.resolve(os.homedir());
}

function realOrResolve(p: string): string {
    try {
        return fs.realpathSync.native(p);
    } catch {
        return path.resolve(p);
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

export function relativeToRoot(root: string, abs: string): string {
    const rel = path.relative(root, abs);
    return rel.split(path.sep).join('/');
}
