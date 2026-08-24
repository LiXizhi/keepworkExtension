import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { DEFAULT_TIMEOUT_MS, GLOBAL_TERMINAL_CAP, MAX_TIMEOUT_MS, OUTPUT_CHAR_CAP } from './config';
import { confinePath, PathEscapeError } from './paths';
import { tryRunInVscodeTerminal } from './vscodeBridge';

export interface TerminalResult {
    ok: boolean;
    command: string;
    cwd: string;
    exitCode: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    truncated: boolean;
    via?: 'vscode-terminal' | 'spawn';
}

const DENY_PATTERNS: RegExp[] = [
    /\bformat\s+[a-z]:/i,
    /\bshutdown\b/i,
    /\brm\s+(-[a-z]*f[a-z]*\s+)*\/(\s|$)/i,
    /\bdel\s+\/s\s+\/q\s+[c-z]:\\/i,
    /\bmkfs\b/i,
    /\bdd\s+if=/i,
    /\bcipher\s+\/w/i,
    /\breg\s+delete\s+hklm\b/i,
    /\bRemove-Item\s+.*-Recurse.*[c-z]:\\/i,
];

let activeTerminals = 0;
const waiters: Array<() => void> = [];
const sessionTails = new Map<string, Promise<unknown>>();

export function assertAllowedCommand(command: string): void {
    const text = String(command || '').trim();
    if (!text) throw new Error('command is required');
    for (const re of DENY_PATTERNS) {
        if (re.test(text)) {
            throw new Error(`Command blocked by deny-list: ${text.slice(0, 80)}`);
        }
    }
}

async function withGlobalSlot<T>(fn: () => Promise<T>): Promise<T> {
    while (activeTerminals >= GLOBAL_TERMINAL_CAP) {
        await new Promise<void>(resolve => waiters.push(resolve));
    }
    activeTerminals += 1;
    try {
        return await fn();
    } finally {
        activeTerminals -= 1;
        const next = waiters.shift();
        if (next) next();
    }
}

export function enqueueSession<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const key = sessionId || '_anon';
    const prev = sessionTails.get(key) || Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(() => undefined, () => undefined);
    sessionTails.set(key, tail);
    return run;
}

function killProcessTree(pid: number | undefined): void {
    if (!pid) return;
    if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        return;
    }
    try {
        process.kill(-pid, 'SIGKILL');
    } catch {
        try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
    }
}

export async function runTerminal(opts: {
    command: string;
    cwd?: string;
    timeoutMs?: number;
    root: string;
}): Promise<TerminalResult> {
    const command = String(opts.command || '').trim();
    assertAllowedCommand(command);
    let cwd: string;
    try {
        cwd = confinePath(opts.root, opts.cwd || '.');
    } catch (err) {
        if (err instanceof PathEscapeError) throw err;
        throw new Error(`Invalid cwd: ${opts.cwd}`);
    }
    try {
        if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true });
        else if (!statSync(cwd).isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith('cwd is not')) throw err;
        throw new Error(`Working directory missing and could not be created (${cwd}): ${msg}`);
    }
    let timeoutMs = Number(opts.timeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = DEFAULT_TIMEOUT_MS;
    timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1000, timeoutMs));

    return withGlobalSlot(async () => {
        const viaVscode = await tryRunInVscodeTerminal({ command, cwd, timeoutMs });
        if (viaVscode) return viaVscode;
        return runSpawn(command, cwd, timeoutMs);
    });
}

function runSpawn(command: string, cwd: string, timeoutMs: number): Promise<TerminalResult> {
    return new Promise((resolve) => {
        const child = spawn(command, {
            cwd,
            shell: true,
            windowsHide: true,
            env: process.env,
        });
        let stdout = '';
        let stderr = '';
        let truncated = false;
        let timedOut = false;
        let settled = false;

        const append = (dest: 'stdout' | 'stderr', chunk: Buffer | string) => {
            const text = chunk.toString('utf8');
            if (dest === 'stdout') stdout += text;
            else stderr += text;
            const total = stdout.length + stderr.length;
            if (total > OUTPUT_CHAR_CAP) {
                truncated = true;
                const overflow = total - OUTPUT_CHAR_CAP;
                if (stderr.length >= overflow) stderr = stderr.slice(0, stderr.length - overflow);
                else {
                    stdout = stdout.slice(0, Math.max(0, stdout.length - (overflow - stderr.length)));
                    stderr = '';
                }
                killProcessTree(child.pid);
            }
        };

        const timer = setTimeout(() => {
            timedOut = true;
            killProcessTree(child.pid);
        }, timeoutMs);

        child.stdout?.on('data', (d) => append('stdout', d));
        child.stderr?.on('data', (d) => append('stderr', d));

        const finish = (exitCode: number | null, signal: string | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({
                ok: !timedOut && exitCode === 0,
                command,
                cwd,
                exitCode,
                signal,
                stdout,
                stderr,
                timedOut,
                truncated,
                via: 'spawn',
            });
        };

        child.on('error', (err) => {
            const msg = String(err.message || err);
            stderr += /ENOENT/i.test(msg)
                ? `${msg}\n(working directory must exist: ${cwd})`
                : msg;
            finish(1, null);
        });
        child.on('close', (code, signal) => finish(code, signal));
    });
}

export function formatTerminalResult(result: TerminalResult): string {
    const lines = [
        `cwd: ${result.cwd}`,
        `exit: ${result.timedOut ? 'timeout' : result.exitCode}`,
        result.via ? `via: ${result.via}` : '',
        result.truncated ? 'output: truncated' : '',
        result.stdout ? `--- stdout ---\n${result.stdout}` : '--- stdout ---\n(empty)',
        result.stderr ? `--- stderr ---\n${result.stderr}` : '',
    ].filter(Boolean);
    return lines.join('\n');
}
