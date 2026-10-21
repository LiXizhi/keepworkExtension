import * as http from 'node:http';
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { BIND_HOST, OUTPUT_CHAR_CAP, clearTerminalBridge, writeTerminalBridge } from '../../../../src/core/config';
import type { TerminalResult } from '../../../../src/core/terminal';
import { POWERSHELL_UTF8_INIT, cmdUtf8Command } from '../../../../src/core/terminalEncoding';

export const KEEPWORK_TERMINAL_NAME = 'Keepwork';

export interface TerminalBridgeHandle {
    port: number;
    dispose(): void;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(text);
}

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function commandWithCwd(command: string, cwd: string): string {
    const shell = String(vscode.env.shell || '').toLowerCase();
    const isPwsh = /powershell|pwsh/.test(shell);
    if (isPwsh) {
        const escaped = cwd.replace(/'/g, "''");
        return `${POWERSHELL_UTF8_INIT}; Set-Location -LiteralPath '${escaped}'; ${command}`;
    }
    if (process.platform === 'win32') {
        return cmdUtf8Command(`cd /d "${cwd}" && ${command}`);
    }
    return `cd ${JSON.stringify(cwd)} && ${command}`;
}

function getKeepworkTerminal(cwd: string): vscode.Terminal {
    const existing = vscode.window.terminals.find(t => t.name === KEEPWORK_TERMINAL_NAME);
    if (existing) return existing;
    return vscode.window.createTerminal({ name: KEEPWORK_TERMINAL_NAME, cwd });
}

export function showKeepworkTerminal(cwd: string): vscode.Terminal {
    const terminal = getKeepworkTerminal(cwd);
    terminal.show(false);
    return terminal;
}

function waitForShellIntegration(terminal: vscode.Terminal, ms: number): Promise<unknown> {
    const current = (terminal as vscode.Terminal & { shellIntegration?: unknown }).shellIntegration;
    if (current) return Promise.resolve(current);
    const onChange = (vscode.window as unknown as {
        onDidChangeTerminalShellIntegration?: (
            listener: (e: { terminal: vscode.Terminal; shellIntegration: unknown }) => void,
        ) => vscode.Disposable;
    }).onDidChangeTerminalShellIntegration;
    if (!onChange) return Promise.resolve(undefined);
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            disposable.dispose();
            resolve((terminal as vscode.Terminal & { shellIntegration?: unknown }).shellIntegration);
        }, ms);
        const disposable = onChange((e) => {
            if (e.terminal !== terminal) return;
            clearTimeout(timer);
            disposable.dispose();
            resolve(e.shellIntegration);
        });
    });
}

async function runInVscodeTerminal(opts: {
    command: string;
    cwd: string;
    timeoutMs: number;
}): Promise<TerminalResult> {
    const terminal = getKeepworkTerminal(opts.cwd);
    // cmd.exe can display output but does not provide VS Code shell-integration
    // completion markers. Never dispatch there and then replay after a timeout.
    const shellPath = (terminal.creationOptions as vscode.TerminalOptions).shellPath || vscode.env.shell || '';
    if (process.platform === 'win32' && /(?:^|[\\/])cmd(?:\.exe)?$/i.test(shellPath)) {
        throw new Error('vscode-terminal-unavailable');
    }
    terminal.show(true);
    const si = await waitForShellIntegration(terminal, 4000) as {
        executeCommand?: (commandLine: string) => { read(): AsyncIterable<string> };
    } | undefined;
    if (!si?.executeCommand) {
        throw new Error('vscode-terminal-unavailable');
    }
    const line = commandWithCwd(opts.command, opts.cwd);
    let stdout = '';
    let truncated = false;
    let timedOut = false;
    let exitCode: number | null = null;
    let failure = '';
    let finished = false;
    let ended = false;
    let streamEnded = false;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = () => { finished = true; resolve(); }; });
    let execution: { read(): AsyncIterable<string> } | undefined;
    const endListener = vscode.window.onDidEndTerminalShellExecution?.(e => {
        if (e.execution !== execution) return;
        exitCode = e.exitCode ?? null;
        ended = true;
        // Drain already queued output, but do not depend on the reader closing.
        clearTimeout(timer);
        if (streamEnded) finish();
        else drainTimer = setTimeout(finish, 50);
    });
    const closeListener = vscode.window.onDidCloseTerminal(t => {
        if (t !== terminal) return;
        failure = 'VS Code terminal closed before command completion; command not retried.';
        finish();
    });
    // A real deadline resolves independently of iterator.next(), including when
    // output has appeared but shell integration never closes its stream.
    const timer = setTimeout(() => {
        timedOut = true;
        failure = 'Timeout waiting for VS Code terminal completion; command may still be running and was not retried.';
        finish();
    }, opts.timeoutMs);
    try {
        execution = si.executeCommand(line);
        const iterator = execution.read()[Symbol.asyncIterator]();
        while (!finished) {
            const next = await Promise.race([iterator.next(), done.then(() => null)]);
            if (!next || finished) break;
            if (next.done) {
                streamEnded = true;
                // Completion/exit code comes from onDidEndTerminalShellExecution.
                if (ended) finish();
                else await done;
                break;
            }
            stdout += next.value;
            if (stdout.length > OUTPUT_CHAR_CAP) {
                stdout = stdout.slice(0, OUTPUT_CHAR_CAP);
                truncated = true;
                failure = 'VS Code terminal output limit reached; command not retried.';
                finish();
            }
        }
    } catch (err) {
        // Once dispatch was attempted, never signal safe-to-replay to the daemon.
        failure = `VS Code terminal execution could not be observed: ${err instanceof Error ? err.message : String(err)}. Command not retried.`;
    } finally {
        finished = true;
        clearTimeout(timer);
        if (drainTimer) clearTimeout(drainTimer);
        endListener?.dispose();
        closeListener.dispose();
    }
    return {
        ok: !failure && exitCode === 0,
        command: opts.command, cwd: opts.cwd, exitCode, signal: null,
        stdout, stderr: failure || (exitCode === null ? 'VS Code did not report an exit code; command not retried.' : ''),
        timedOut, truncated, via: 'vscode-terminal',
    };
}

export function startTerminalBridge(): TerminalBridgeHandle {
    const token = randomBytes(24).toString('hex');
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        const pathname = url.pathname.replace(/\/+$/, '') || '/';
        const header = String(req.headers.authorization || '');
        const got = (header.match(/^Bearer\s+(.+)$/i) || [])[1] || '';

        if (pathname === '/health' && req.method === 'GET') {
            sendJson(res, 200, { ok: true, name: 'keepwork-vscode-terminal' });
            return;
        }

        if (pathname !== '/run' || req.method !== 'POST') {
            sendJson(res, 404, { error: 'not found' });
            return;
        }
        if (got !== token) {
            sendJson(res, 401, { error: 'unauthorized' });
            return;
        }

        try {
            const raw = await readBody(req);
            const body = raw ? JSON.parse(raw) as { command?: string; cwd?: string; timeoutMs?: number } : {};
            const command = String(body.command || '').trim();
            const cwd = String(body.cwd || '').trim();
            const timeoutMs = Number(body.timeoutMs) || 30_000;
            if (!command || !cwd) {
                sendJson(res, 400, { error: 'command and cwd are required' });
                return;
            }
            const result = await runInVscodeTerminal({ command, cwd, timeoutMs });
            sendJson(res, 200, result);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            sendJson(res, 503, { error: msg, executed: false });
        }
    });

    server.listen(0, BIND_HOST, () => {
        const addr = server.address();
        const port = addr && typeof addr === 'object' ? addr.port : 0;
        writeTerminalBridge({ port, pid: process.pid, token });
    });

    const dispose = () => {
        clearTerminalBridge(process.pid);
        server.close();
    };

    const addr = server.address();
    return {
        port: addr && typeof addr === 'object' ? addr.port : 0,
        dispose,
    };
}
