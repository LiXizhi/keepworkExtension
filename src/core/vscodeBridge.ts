import { OUTPUT_CHAR_CAP, readTerminalBridge } from './config';
import type { TerminalResult } from './terminal';

/** Ask the VS Code extension to run a command in the integrated terminal. Null = no live editor. */
export async function tryRunInVscodeTerminal(opts: {
    command: string;
    cwd: string;
    timeoutMs: number;
}): Promise<TerminalResult | null> {
    const info = readTerminalBridge();
    if (!info) return null;
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
        if (!res.ok) return null;
        const body = await res.json() as Partial<TerminalResult> & { ok?: boolean };
        if (typeof body.command !== 'string') return null;
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
            exitCode: typeof body.exitCode === 'number' ? body.exitCode : (body.ok === false ? 1 : 0),
            signal: body.signal ?? null,
            stdout,
            stderr,
            timedOut: !!body.timedOut,
            truncated,
            via: 'vscode-terminal',
        };
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

export function vscodeTerminalBridgeLive(): boolean {
    return !!readTerminalBridge();
}
