import { randomUUID } from 'node:crypto';
import * as pty from 'node-pty';
import { GLOBAL_TERMINAL_CAP, OUTPUT_CHAR_CAP } from './config';
import { resolveWorkdir } from './paths';
import { assertAllowedCommand } from './terminal';

const TERMINAL_IDLE_MS = 30 * 60 * 1000;
const MAX_INPUT_LENGTH = 64_000;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MIN_COLS = 2;
const MIN_ROWS = 1;
const MAX_COLS = 500;
const MAX_ROWS = 200;

interface TerminalSession {
    id: string;
    owner: string;
    cwd: string;
    process: pty.IPty;
    output: string;
    baseCursor: number;
    outputListeners: Set<(event: TerminalOutputEvent) => void>;
    createdAt: number;
    touchedAt: number;
    closed: boolean;
}

export interface TerminalOutputEvent {
    cursor: number;
    reset: boolean;
    output: string;
    closed: boolean;
}

export interface TerminalSessionSnapshot {
    id: string;
    cwd: string;
    createdAt: string;
    runningCommand: boolean;
    closed: boolean;
    cols: number;
    rows: number;
}

function clampDimension(value: number | undefined, fallback: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(value as number)));
}

function appendOutput(session: TerminalSession, text: string): void {
    if (!text) return;
    session.output += text;
    if (session.output.length > OUTPUT_CHAR_CAP) {
        const overflow = session.output.length - OUTPUT_CHAR_CAP;
        session.output = session.output.slice(overflow);
        session.baseCursor += overflow;
    }
    const event = {
        cursor: session.baseCursor + session.output.length,
        reset: false,
        output: text,
        closed: session.closed,
    };
    for (const listener of session.outputListeners) listener(event);
}

function shellSpec(): { command: string; args: string[] } {
    if (process.platform === 'win32') {
        return {
            command: process.env.ComSpec && /cmd(?:\.exe)?$/i.test(process.env.ComSpec)
                ? 'powershell.exe'
                : (process.env.ComSpec || 'powershell.exe'),
            args: ['-NoLogo', '-NoProfile'],
        };
    }
    return { command: process.env.SHELL || '/bin/sh', args: [] };
}

export class TerminalSessionManager {
    private readonly sessions = new Map<string, TerminalSession>();

    create(
        root: string,
        cwd: string | undefined,
        owner: string,
        dimensions?: { cols?: number; rows?: number },
    ): TerminalSessionSnapshot {
        if (this.sessions.size >= GLOBAL_TERMINAL_CAP) {
            throw new Error(`terminal session limit reached (${GLOBAL_TERMINAL_CAP})`);
        }
        const resolvedCwd = resolveWorkdir(root, cwd || '.');
        const shell = shellSpec();
        const cols = clampDimension(dimensions?.cols, DEFAULT_COLS, MIN_COLS, MAX_COLS);
        const rows = clampDimension(dimensions?.rows, DEFAULT_ROWS, MIN_ROWS, MAX_ROWS);
        const terminalProcess = pty.spawn(shell.command, shell.args, {
            name: 'xterm-256color',
            cwd: resolvedCwd,
            cols,
            rows,
            env: process.env,
            useConpty: process.platform === 'win32',
        });
        const now = Date.now();
        const session: TerminalSession = {
            id: randomUUID(),
            owner,
            cwd: resolvedCwd,
            process: terminalProcess,
            output: '',
            baseCursor: 0,
            outputListeners: new Set(),
            createdAt: now,
            touchedAt: now,
            closed: false,
        };
        this.sessions.set(session.id, session);
        terminalProcess.onData(data => appendOutput(session, data));
        terminalProcess.onExit(({ exitCode }) => {
            session.closed = true;
            appendOutput(session, `\r\n[terminal exited ${exitCode}]\r\n`);
        });
        return this.snapshot(session);
    }

    write(id: string, owner: string, data: string): { accepted: true } {
        const session = this.get(id, owner);
        const text = String(data || '');
        if (text.length > MAX_INPUT_LENGTH) throw new Error('terminal input is too long');
        if (session.closed) throw new Error('terminal session is closed');
        session.touchedAt = Date.now();
        session.process.write(text);
        return { accepted: true };
    }

    send(id: string, owner: string, command: string): { accepted: true } {
        const text = String(command || '').trim();
        assertAllowedCommand(text);
        return this.write(id, owner, `${text}\r`);
    }

    resize(id: string, owner: string, cols: number | undefined, rows: number | undefined): TerminalSessionSnapshot {
        const session = this.get(id, owner);
        if (session.closed) throw new Error('terminal session is closed');
        const nextCols = clampDimension(cols, session.process.cols, MIN_COLS, MAX_COLS);
        const nextRows = clampDimension(rows, session.process.rows, MIN_ROWS, MAX_ROWS);
        session.process.resize(nextCols, nextRows);
        session.touchedAt = Date.now();
        return this.snapshot(session);
    }

    output(id: string, owner: string, cursor: number): TerminalSessionSnapshot & {
        cursor: number;
        reset: boolean;
        output: string;
    } {
        const session = this.get(id, owner);
        session.touchedAt = Date.now();
        const requested = Number.isFinite(cursor) && cursor >= 0 ? Math.floor(cursor) : 0;
        const reset = requested < session.baseCursor;
        const start = reset ? 0 : Math.min(session.output.length, requested - session.baseCursor);
        return {
            ...this.snapshot(session),
            cursor: session.baseCursor + session.output.length,
            reset,
            output: session.output.slice(start),
        };
    }

    subscribe(id: string, owner: string, cursor: number, listener: (event: TerminalOutputEvent) => void): () => void {
        const session = this.get(id, owner);
        session.outputListeners.add(listener);
        listener(this.output(id, owner, cursor));
        return () => session.outputListeners.delete(listener);
    }

    interrupt(id: string, owner: string): void {
        this.write(id, owner, '\x03');
    }

    close(id: string, owner: string): void {
        const session = this.get(id, owner);
        try { session.process.kill(); } catch { /* already stopped */ }
        this.sessions.delete(id);
    }

    prune(now = Date.now()): void {
        for (const session of this.sessions.values()) {
            if (now - session.touchedAt <= TERMINAL_IDLE_MS) continue;
            try { session.process.kill(); } catch { /* already stopped */ }
            this.sessions.delete(session.id);
        }
    }

    closeAll(): void {
        for (const session of this.sessions.values()) {
            try { session.process.kill(); } catch { /* already stopped */ }
        }
        this.sessions.clear();
    }

    private get(id: string, owner: string): TerminalSession {
        const session = this.sessions.get(id);
        if (!session || session.owner !== owner) throw new Error('terminal session not found');
        return session;
    }

    private snapshot(session: TerminalSession): TerminalSessionSnapshot {
        return {
            id: session.id,
            cwd: session.cwd,
            createdAt: new Date(session.createdAt).toISOString(),
            runningCommand: !session.closed,
            closed: session.closed,
            cols: session.process.cols,
            rows: session.process.rows,
        };
    }
}