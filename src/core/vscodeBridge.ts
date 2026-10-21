import { OUTPUT_CHAR_CAP, readNotifyBridge, readTerminalBridge } from './config';
import type { TerminalResult } from './terminal';

const TERMINAL_BRIDGE_COOLDOWN_MS = 60_000;
let failedTerminalBridge: { identity: string; until: number } | undefined;

/** Ask the VS Code extension to run a command in the integrated terminal. Null = no live editor. */
export async function tryRunInVscodeTerminal(opts: {
    command: string;
    cwd: string;
    timeoutMs: number;
}): Promise<TerminalResult | null> {
    const info = readTerminalBridge();
    if (!info) return null;
    const identity = `${info.pid}:${info.port}:${info.token}`;
    if (failedTerminalBridge?.identity === identity && failedTerminalBridge.until > Date.now()) return null;
    const coolDown = () => { failedTerminalBridge = { identity, until: Date.now() + TERMINAL_BRIDGE_COOLDOWN_MS }; };
    // Probe without executing anything, so a dead editor can safely fall back quickly.
    const probe = new AbortController();
    const probeTimer = setTimeout(() => probe.abort(), 1500);
    try {
        const health = await fetch(`http://127.0.0.1:${info.port}/health`, { signal: probe.signal });
        if (!health.ok || (await health.json() as { name?: string }).name !== 'keepwork-vscode-terminal') {
            coolDown();
            return null;
        }
    } catch {
        coolDown();
        return null;
    } finally { clearTimeout(probeTimer); }
    const uncertainResult = (): TerminalResult => ({
        ok: false, command: opts.command, cwd: opts.cwd, exitCode: null, signal: null,
        stdout: '', stderr: 'VS Code terminal response was lost; the command may have executed. Not retried to avoid duplicate execution.',
        timedOut: ctrl.signal.aborted, truncated: false, via: 'vscode-terminal',
    });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.min(opts.timeoutMs + 8000, 180_000));
    try {
        const res = await fetch(`http://127.0.0.1:${info.port}/run`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${info.token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                command: opts.command,
                cwd: opts.cwd,
                timeoutMs: opts.timeoutMs,
            }),
            signal: ctrl.signal,
        });
        if (!res.ok) {
            coolDown();
            const error = await res.json() as { error?: string; executed?: boolean };
            // Only an explicit pre-execution rejection permits replay via spawn.
            if (error.executed === false || error.error === 'vscode-terminal-unavailable') return null;
            return uncertainResult();
        }
        const body = await res.json() as Partial<TerminalResult> & { ok?: boolean };
        if (body.command !== opts.command) { coolDown(); return uncertainResult(); }
        if (body.timedOut || body.exitCode == null) coolDown();
        else failedTerminalBridge = undefined;
        let stdout = String(body.stdout || '');
        let stderr = String(body.stderr || '');
        let truncated = !!body.truncated;
        if (stdout.length + stderr.length > OUTPUT_CHAR_CAP) {
            truncated = true;
            stdout = stdout.slice(0, OUTPUT_CHAR_CAP);
            stderr = '';
        }
        return {
            ok: typeof body.ok === 'boolean' ? body.ok : (!body.timedOut && body.exitCode === 0),
            command: body.command,
            cwd: String(body.cwd || opts.cwd),
            exitCode: typeof body.exitCode === 'number' ? body.exitCode : null,
            signal: body.signal ?? null,
            stdout,
            stderr,
            timedOut: !!body.timedOut,
            truncated,
            via: 'vscode-terminal',
        };
    } catch {
        coolDown();
        return uncertainResult();
    } finally {
        clearTimeout(timer);
    }
}

export function vscodeTerminalBridgeLive(): boolean {
    return !!readTerminalBridge();
}

/** Ask the VS Code extension to show a calendar notification. Null/false = no live editor. */
export async function tryShowVscodeNotification(opts: {
    title: string;
    body: string;
    openUrl: string;
}): Promise<boolean> {
    const info = readNotifyBridge();
    if (!info) return false;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
        const res = await fetch(`http://127.0.0.1:${info.port}/notify`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${info.token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                title: opts.title,
                body: opts.body,
                openUrl: opts.openUrl,
            }),
            signal: ctrl.signal,
        });
        if (!res.ok) return false;
        const body = await res.json() as { ok?: boolean };
        return body.ok !== false;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

/** Ask the VS Code extension to reveal a disk path in the OS file manager. */
export async function tryRevealInVscode(abs: string): Promise<boolean> {
    const info = readNotifyBridge();
    if (!info) return false;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
        const res = await fetch(`http://127.0.0.1:${info.port}/reveal`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${info.token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ path: abs }),
            signal: ctrl.signal,
        });
        if (!res.ok) return false;
        const body = await res.json() as { ok?: boolean };
        return body.ok !== false;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}
