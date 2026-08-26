import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureMcpHome, mcpHomeDir } from './config';
import { tryShowVscodeNotification } from './vscodeBridge';

export interface CalendarReminder {
    id: string;
    title: string;
    start: string;
    remindAt: string;
    openUrl?: string;
    location?: string;
    notified?: boolean;
}

interface ReminderStore {
    version: 1;
    horizonDays: number;
    updatedAt: string;
    events: CalendarReminder[];
}

const MAX_EVENTS = 400;
const RETRY_MS = 15_000;
const DEFAULT_OPEN = 'https://keepwork.com/chat?tool=calendar';

const timers = new Map<string, ReturnType<typeof setTimeout>>();
let retryTimer: ReturnType<typeof setInterval> | null = null;
let store: ReminderStore = emptyStore();

function emptyStore(): ReminderStore {
    return { version: 1, horizonDays: 7, updatedAt: new Date().toISOString(), events: [] };
}

function storePath(): string {
    return path.join(mcpHomeDir(), 'calendar-reminders.json');
}

export function isSafeOpenUrl(url: string): boolean {
    try {
        const u = new URL(url);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
        const h = u.hostname;
        return h === 'keepwork.com' || h.endsWith('.keepwork.com')
            || h === 'localhost' || h === '127.0.0.1';
    } catch {
        return false;
    }
}

function normalizeEvent(raw: unknown): CalendarReminder | null {
    if (!raw || typeof raw !== 'object') return null;
    const row = raw as Record<string, unknown>;
    const id = String(row.id || '').trim();
    const title = String(row.title || '').trim();
    const start = String(row.start || '').trim();
    const remindAt = String(row.remindAt || '').trim();
    if (!id || !title || !remindAt) return null;
    const at = Date.parse(remindAt);
    if (!Number.isFinite(at)) return null;
    const openUrl = String(row.openUrl || DEFAULT_OPEN).trim() || DEFAULT_OPEN;
    if (!isSafeOpenUrl(openUrl)) return null;
    return {
        id: id.slice(0, 120),
        title: title.slice(0, 200),
        start: start.slice(0, 64),
        remindAt,
        openUrl,
        location: String(row.location || '').slice(0, 200),
        notified: row.notified === true,
    };
}

function persist(): void {
    ensureMcpHome();
    fs.writeFileSync(storePath(), JSON.stringify(store, null, 2), 'utf8');
}

function loadStore(): void {
    try {
        const parsed = JSON.parse(fs.readFileSync(storePath(), 'utf8')) as ReminderStore;
        if (!parsed || !Array.isArray(parsed.events)) return;
        store = {
            version: 1,
            horizonDays: Math.min(14, Math.max(1, Number(parsed.horizonDays) || 7)),
            updatedAt: String(parsed.updatedAt || new Date().toISOString()),
            events: parsed.events.map(normalizeEvent).filter((row): row is CalendarReminder => !!row).slice(0, MAX_EVENTS),
        };
    } catch {
        store = emptyStore();
    }
}

function clearTimers(): void {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
}

async function fire(event: CalendarReminder): Promise<void> {
    if (event.notified) return;
    const ok = await tryShowVscodeNotification({
        title: event.title,
        body: event.start ? `开始时间 ${event.start}` : '日历提醒',
        openUrl: event.openUrl || DEFAULT_OPEN,
    });
    if (!ok) return;
    event.notified = true;
    persist();
}

function scheduleOne(event: CalendarReminder): void {
    if (event.notified) return;
    const at = Date.parse(event.remindAt);
    if (!Number.isFinite(at)) return;
    const delay = at - Date.now();
    const key = event.id;
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);
    if (delay <= 0) {
        timers.delete(key);
        void fire(event);
        return;
    }
    const timer = setTimeout(() => {
        timers.delete(key);
        void fire(event);
    }, Math.min(delay, 2_147_000_000));
    timer.unref?.();
    timers.set(key, timer);
}

function reschedule(): void {
    clearTimers();
    for (const event of store.events) scheduleOne(event);
}

export function listCalendarReminders(): ReminderStore {
    return {
        version: 1,
        horizonDays: store.horizonDays,
        updatedAt: store.updatedAt,
        events: store.events.map(event => ({ ...event })),
    };
}

export function replaceCalendarReminders(rawEvents: unknown, horizonDays = 7): ReminderStore {
    const events = (Array.isArray(rawEvents) ? rawEvents : [])
        .map(normalizeEvent)
        .filter((row): row is CalendarReminder => !!row)
        .slice(0, MAX_EVENTS);
    const prev = new Map(store.events.map(event => [event.id, event]));
    for (const event of events) {
        const old = prev.get(event.id);
        if (old?.notified && old.remindAt === event.remindAt) event.notified = true;
    }
    store = {
        version: 1,
        horizonDays: Math.min(14, Math.max(1, Number(horizonDays) || 7)),
        updatedAt: new Date().toISOString(),
        events,
    };
    persist();
    reschedule();
    return listCalendarReminders();
}

export function startCalendarWatch(): void {
    loadStore();
    reschedule();
    if (!retryTimer) {
        retryTimer = setInterval(() => {
            for (const event of store.events) {
                if (event.notified) continue;
                const at = Date.parse(event.remindAt);
                if (Number.isFinite(at) && at <= Date.now()) void fire(event);
            }
        }, RETRY_MS);
        retryTimer.unref?.();
    }
}

export function stopCalendarWatch(): void {
    clearTimers();
    if (retryTimer) {
        clearInterval(retryTimer);
        retryTimer = null;
    }
}

export async function tryHandleCalendar(opts: {
    pathname: string;
    method: string;
    readBody: () => Promise<string>;
    sendJson: (status: number, body: unknown) => void;
}): Promise<boolean> {
    if (opts.pathname !== '/calendar/reminders') return false;
    if (opts.method === 'GET') {
        opts.sendJson(200, { ok: true, ...listCalendarReminders() });
        return true;
    }
    if (opts.method !== 'POST') {
        opts.sendJson(405, { ok: false, error: 'method not allowed' });
        return true;
    }
    let body: { events?: unknown; horizonDays?: unknown } = {};
    try {
        const raw = await opts.readBody();
        body = raw ? JSON.parse(raw) as { events?: unknown; horizonDays?: unknown } : {};
    } catch {
        opts.sendJson(400, { ok: false, error: 'invalid json' });
        return true;
    }
    const next = replaceCalendarReminders(body.events, Number(body.horizonDays) || 7);
    opts.sendJson(200, { ok: true, ...next });
    return true;
}
