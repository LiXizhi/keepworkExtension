import { HISTORY_MAX, HISTORY_PAGE_DEFAULT, HISTORY_PAGE_MAX, IDLE_SESSION_MS } from '../core/config';

export interface ClientSession {
    sessionId: string;
    origin: string;
    userAgent: string;
    connectedAt: string;
    lastSeenAt: string;
    callCount: number;
}

export interface HistoryRow {
    time: string;
    sessionId: string;
    origin: string;
    tool: string;
    summary: string;
    ok: boolean;
    error?: string;
    durationMs: number;
}

const sessions = new Map<string, ClientSession>();
const history: HistoryRow[] = [];
const closeHandlers = new Map<string, () => void>();

export function upsertSession(sessionId: string, origin: string, userAgent: string): ClientSession {
    const now = new Date().toISOString();
    const existing = sessions.get(sessionId);
    if (existing) {
        existing.origin = origin || existing.origin;
        existing.userAgent = userAgent || existing.userAgent;
        existing.lastSeenAt = now;
        return existing;
    }
    const created: ClientSession = {
        sessionId,
        origin: origin || '',
        userAgent: userAgent || '',
        connectedAt: now,
        lastSeenAt: now,
        callCount: 0,
    };
    sessions.set(sessionId, created);
    return created;
}

export function touchSession(sessionId: string): void {
    const s = sessions.get(sessionId);
    if (s) s.lastSeenAt = new Date().toISOString();
}

export function removeSession(sessionId: string): void {
    sessions.delete(sessionId);
    closeHandlers.delete(sessionId);
}

export function setSessionCloser(sessionId: string, closer: () => void): void {
    closeHandlers.set(sessionId, closer);
}

export function listSessions(): ClientSession[] {
    return [...sessions.values()].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

export function summarizeArgs(tool: string, args: unknown): string {
    const obj = args && typeof args === 'object' ? args as Record<string, unknown> : {};
    if (tool === 'run_terminal') return String(obj.command || '').slice(0, 200);
    if (tool === 'grep_files') return String(obj.pattern || '').slice(0, 200);
    if (tool === 'web_search') return String(obj.query || '').slice(0, 200);
    if (tool === 'fetch_url') return String(obj.url || '').slice(0, 200);
    try {
        return JSON.stringify(args).slice(0, 200);
    } catch {
        return '';
    }
}

export function recordCall(row: Omit<HistoryRow, 'time'> & { time?: string }): void {
    const session = sessions.get(row.sessionId);
    if (session) {
        session.callCount += 1;
        session.lastSeenAt = new Date().toISOString();
        if (row.origin) session.origin = row.origin;
    }
    history.push({
        time: row.time || new Date().toISOString(),
        sessionId: row.sessionId,
        origin: row.origin,
        tool: row.tool,
        summary: row.summary,
        ok: row.ok,
        error: row.error,
        durationMs: row.durationMs,
    });
    while (history.length > HISTORY_MAX) history.shift();
}

export interface HistoryPage {
    history: HistoryRow[];
    total: number;
    offset: number;
    limit: number;
    hasMore: boolean;
}

/** Newest-first page. Does not copy the full ring buffer. */
export function listHistory(offset = 0, limit = HISTORY_PAGE_DEFAULT): HistoryPage {
    const total = history.length;
    const off = Math.max(0, Math.min(Math.floor(Number(offset) || 0), total));
    const raw = Number(limit);
    const lim = Math.max(1, Math.min(
        Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : HISTORY_PAGE_DEFAULT,
        HISTORY_PAGE_MAX,
    ));
    const items: HistoryRow[] = [];
    const newest = total - 1 - off;
    for (let i = 0; i < lim && newest - i >= 0; i++) {
        items.push(history[newest - i]);
    }
    return {
        history: items,
        total,
        offset: off,
        limit: lim,
        hasMore: off + items.length < total,
    };
}

export function pruneIdleSessions(): string[] {
    const cutoff = Date.now() - IDLE_SESSION_MS;
    const closed: string[] = [];
    for (const [id, session] of sessions) {
        if (Date.parse(session.lastSeenAt) >= cutoff) continue;
        closeHandlers.get(id)?.();
        sessions.delete(id);
        closeHandlers.delete(id);
        closed.push(id);
    }
    return closed;
}

export function sessionCount(): number {
    return sessions.size;
}
