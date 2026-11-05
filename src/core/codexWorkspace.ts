import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

export type NativeWorkspace = { version: 1; roots: string[]; complete: boolean; error?: string };
/** Read only the first structured metadata record, never conversation text or config credentials. */
export async function codexWorkspace(thread: any, primary: string, home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')): Promise<NativeWorkspace> {
    const fallback: NativeWorkspace = {version: 1, roots: [primary], complete: false};
    if (typeof thread?.path !== 'string' || !path.isAbsolute(thread.path)) return fallback;
    let file;
    try {
        const target = await fs.realpath(thread.path);
        const allowed = await Promise.all(['sessions', 'archived_sessions'].map(name => fs.realpath(path.join(home, name)).catch(() => '')));
        if (!allowed.some(root => root && target.startsWith(root + path.sep))) return fallback;
        file = await fs.open(target, 'r');
        // Metadata is the first JSONL record. Bound memory even for malformed files.
        const buffer = Buffer.alloc(2 * 1024 * 1024);
        const {bytesRead} = await file.read(buffer, 0, buffer.length, 0);
        const end = buffer.subarray(0, bytesRead).indexOf(10);
        if (end < 0 && bytesRead === buffer.length) return fallback;
        const record = JSON.parse(buffer.subarray(0, end < 0 ? bytesRead : end).toString('utf8'));
        if (record.type !== 'session_meta' || record.payload?.id !== thread.id) return fallback;
        const roots = record.payload.runtime_workspace_roots;
        if (roots == null) return fallback;
        if (!Array.isArray(roots) || roots.length > 16 || roots.some(root => typeof root !== 'string' || !path.isAbsolute(root) || root.length > 4096 || root.includes('\0'))) {
            return {...fallback, error: 'Codex workspace folder metadata is invalid or exceeds 16 folders'};
        }
        // Existence and symlink canonicalization are verified by the ordinary folder binder.
        // Keep missing folders visible so new-chat creation fails rather than dropping them.
        const normalized = await Promise.all(roots.map(root => fs.realpath(root).catch(() => path.normalize(root))));
        const unique = [...new Set([primary, ...normalized].map(root => process.platform === 'win32' ? root.toLowerCase() : root))];
        if (unique.length > 16) return {...fallback, error: 'Codex workspace exceeds 16 folders'};
        return {version: 1, roots: unique, complete: true};
    } catch { return fallback; }
    finally { await file?.close(); }
}
