import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { confinePath, relativeToRoot } from './paths';
import { OUTPUT_CHAR_CAP } from './config';

export interface GrepHit {
    file: string;
    line: number;
    text: string;
}

export interface GrepResult {
    ok: boolean;
    engine: 'rg' | 'node';
    pattern: string;
    path: string;
    hits: GrepHit[];
    truncated: boolean;
    error?: string;
}

const SKIP_DIRS = new Set([
    '.git', '.svn', '.hg', 'node_modules', 'dist', 'out', '.cursor',
    '.vscode-test', 'bin', 'obj', '.next', 'coverage',
]);

const BINARY_EXT = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.mp4', '.mov', '.avi',
    '.zip', '.7z', '.rar', '.gz', '.exe', '.dll', '.so', '.dylib', '.wasm',
    '.pdf', '.woff', '.woff2', '.ttf', '.eot', '.class', '.pdb', '.bin',
]);

let rgAvailable: boolean | null = null;

export async function hasRipgrep(): Promise<boolean> {
    if (rgAvailable !== null) return rgAvailable;
    rgAvailable = await new Promise<boolean>((resolve) => {
        const child = spawn('rg', ['--version'], { stdio: 'ignore', windowsHide: true, shell: false });
        child.on('error', () => resolve(false));
        child.on('close', (code) => resolve(code === 0));
    });
    return rgAvailable;
}

function globToRegExp(glob: string): RegExp | null {
    const g = String(glob || '').trim();
    if (!g || g === '**/*' || g === '*') return null;
    const escaped = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '::DS::').replace(/\*/g, '[^/\\\\]*').replace(/::DS::/g, '.*');
    return new RegExp(`^${escaped}$`, 'i');
}

async function grepWithRg(opts: {
    pattern: string;
    searchPath: string;
    glob?: string;
    maxMatches: number;
    root: string;
}): Promise<GrepResult> {
    const args = ['--json', '-n', '--max-count', String(opts.maxMatches), '--hidden', '--glob', '!node_modules/**', '--glob', '!.git/**'];
    if (opts.glob) args.push('--glob', opts.glob);
    args.push('--', opts.pattern, opts.searchPath);
    return new Promise((resolve) => {
        const child = spawn('rg', args, { windowsHide: true, shell: false });
        let raw = '';
        let err = '';
        child.stdout?.on('data', (d) => { raw += d.toString('utf8'); });
        child.stderr?.on('data', (d) => { err += d.toString('utf8'); });
        child.on('error', (e) => {
            resolve({
                ok: false, engine: 'rg', pattern: opts.pattern, path: relativeToRoot(opts.root, opts.searchPath),
                hits: [], truncated: false, error: String(e.message || e),
            });
        });
        child.on('close', () => {
            const hits: GrepHit[] = [];
            for (const line of raw.split('\n')) {
                if (!line.trim()) continue;
                try {
                    const ev = JSON.parse(line) as { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } };
                    if (ev.type !== 'match' || !ev.data) continue;
                    const fileAbs = ev.data.path?.text || '';
                    hits.push({
                        file: relativeToRoot(opts.root, fileAbs),
                        line: ev.data.line_number || 0,
                        text: String(ev.data.lines?.text || '').replace(/\n$/, ''),
                    });
                    if (hits.length >= opts.maxMatches) break;
                } catch {
                    /* skip bad json line */
                }
            }
            resolve({
                ok: true,
                engine: 'rg',
                pattern: opts.pattern,
                path: relativeToRoot(opts.root, opts.searchPath),
                hits,
                truncated: hits.length >= opts.maxMatches,
                error: err.trim() || undefined,
            });
        });
    });
}

function grepWithNode(opts: {
    pattern: string;
    searchPath: string;
    glob?: string;
    maxMatches: number;
    root: string;
}): GrepResult {
    let regex: RegExp;
    try {
        regex = new RegExp(opts.pattern, 'g');
    } catch {
        regex = new RegExp(opts.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    }
    const globRe = globToRegExp(opts.glob || '');
    const hits: GrepHit[] = [];
    const walk = (dir: string) => {
        if (hits.length >= opts.maxMatches) return;
        let entries: fs.Dirent[] = [];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const ent of entries) {
            if (hits.length >= opts.maxMatches) return;
            if (ent.name === '.' || ent.name === '..') continue;
            const abs = path.join(dir, ent.name);
            if (ent.isSymbolicLink()) continue;
            if (ent.isDirectory()) {
                if (SKIP_DIRS.has(ent.name)) continue;
                walk(abs);
                continue;
            }
            if (!ent.isFile()) continue;
            const ext = path.extname(ent.name).toLowerCase();
            if (BINARY_EXT.has(ext)) continue;
            const rel = relativeToRoot(opts.root, abs);
            if (globRe && !globRe.test(rel) && !globRe.test(ent.name)) continue;
            let stat: fs.Stats;
            try { stat = fs.statSync(abs); } catch { continue; }
            if (stat.size > 1_000_000) continue;
            let content: string;
            try { content = fs.readFileSync(abs, 'utf8'); } catch { continue; }
            if (content.includes('\0')) continue;
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
                regex.lastIndex = 0;
                if (!regex.test(lines[i])) continue;
                hits.push({ file: rel, line: i + 1, text: lines[i].slice(0, 400) });
                if (hits.length >= opts.maxMatches) return;
            }
        }
    };
    walk(opts.searchPath);
    return {
        ok: true,
        engine: 'node',
        pattern: opts.pattern,
        path: relativeToRoot(opts.root, opts.searchPath),
        hits,
        truncated: hits.length >= opts.maxMatches,
    };
}

export async function grepFiles(opts: {
    pattern: string;
    path?: string;
    glob?: string;
    maxMatches?: number;
    root: string;
}): Promise<GrepResult> {
    const pattern = String(opts.pattern || '');
    if (!pattern) throw new Error('pattern is required');
    const searchPath = confinePath(opts.root, opts.path || '.');
    let maxMatches = Number(opts.maxMatches);
    if (!Number.isFinite(maxMatches) || maxMatches <= 0) maxMatches = 50;
    maxMatches = Math.min(200, Math.max(1, Math.floor(maxMatches)));

    if (await hasRipgrep()) {
        try {
            return await grepWithRg({ pattern, searchPath, glob: opts.glob, maxMatches, root: opts.root });
        } catch {
            /* fall through */
        }
    }
    return grepWithNode({ pattern, searchPath, glob: opts.glob, maxMatches, root: opts.root });
}

export function formatGrepResult(result: GrepResult): string {
    if (!result.ok) return `grep failed (${result.engine}): ${result.error || 'unknown error'}`;
    if (!result.hits.length) return `No matches for /${result.pattern}/ under ${result.path} (${result.engine})`;
    const lines = result.hits.map(h => `${h.file}:${h.line}:${h.text}`);
    let text = lines.join('\n');
    if (text.length > OUTPUT_CHAR_CAP) {
        text = text.slice(0, OUTPUT_CHAR_CAP) + '\n…truncated';
    }
    if (result.truncated) text += `\n…max matches reached`;
    return text;
}
