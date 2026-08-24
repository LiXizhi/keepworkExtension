import { randomUUID } from 'node:crypto';
import type * as http from 'node:http';

const KEEP_ALIVE_MS = 10_000;
const STALE_MS = KEEP_ALIVE_MS;
const NPL_FAILS_TO_DROP = 2;
const NPL_SCAN_FROM = 8099;
const NPL_SCAN_TO = 8115;
const NPL_SCAN_TIMEOUT_MS = 600;
const DISCOVER_MIN_MS = 2_000;
const SCREENSHOT_FRESH_MS = 8_000;
const JOB_WAIT_MS = 15_000;
const MIN_POLL_MS = 500;
const MAX_POLL_MS = KEEP_ALIVE_MS;
const MAX_HISTORY = 40;
const MAX_SHOTS = 6;
const SUMMARY_LEN = 160;
const PING_ACTIONS = new Set(['health']);
const ACTIONS = new Set(['health', 'world_status', 'run_command', 'screenshot', 'open_world', 'exit', 'bring_to_front']);

export interface ParacraftIdentity {
    clientId: string;
    platform?: string;
    pid?: number;
    worldEntered?: boolean;
    worldName?: string | null;
    worldPath?: string | null;
    kpProjectId?: string | number | null;
    revision?: string | number | null;
    startedAt?: string;
    nplPort?: number | null;
    service?: string;
    version?: string;
}

interface ScreenshotCache {
    mimeType: string;
    base64: string;
    width?: number;
    height?: number;
    at: number;
}

interface HistoryEvent {
    at: number;
    action: string;
    ok: boolean;
    summary: string;
}

interface RegisteredClient extends ParacraftIdentity {
    lastSeen: number;
    connectedAt: number;
    lastScreenshot?: ScreenshotCache;
    shots: ScreenshotCache[];
    history: HistoryEvent[];
    jobs: Job[];
    poller: Poller | null;
    useNpl: boolean;
    nplAlive: boolean;
    nplFails: number;
    pendingKpProjectId?: string | number | null;
    pendingKpAt?: number;
}

interface Job {
    jobId: string;
    action: string;
    request: Record<string, unknown>;
    createdAt: number;
    resolve: (result: unknown) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

interface Poller {
    resolve: (jobs: Array<{ jobId: string; request: Record<string, unknown> }>) => void;
    timer: ReturnType<typeof setTimeout>;
}

const clients = new Map<string, RegisteredClient>();

function now(): number {
    return Date.now();
}

function parseNplPort(value: unknown): number | undefined {
    const port = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 8089) return undefined;
    return port;
}

async function loopbackJson(port: number, path: string, init?: RequestInit, timeoutMs = 3000): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, {
            ...init,
            signal: ctrl.signal,
            headers: { Accept: 'application/json', ...(init?.headers || {}) },
        });
        const body = await res.json().catch(() => ({}));
        return { ok: res.ok, status: res.status, body: body && typeof body === 'object' ? body as Record<string, unknown> : {} };
    } finally {
        clearTimeout(timer);
    }
}

function identityFromHealth(body: Record<string, unknown>, nplPort: number): Partial<ParacraftIdentity> | null {
    const inner = (body.result && typeof body.result === 'object') ? body.result as Record<string, unknown> : body;
    const clientId = String(inner.clientId || body.clientId || '').trim();
    if (!clientId) return null;
    const service = inner.service != null ? String(inner.service) : String(body.service || '');
    if (service && service !== 'paracraft-cli') return null;
    const pidRaw = inner.pid ?? body.pid;
    const pid = typeof pidRaw === 'number' ? pidRaw : Number(pidRaw);
    return {
        clientId,
        platform: inner.platform != null ? String(inner.platform) : undefined,
        pid: Number.isFinite(pid) ? pid : undefined,
        worldEntered: inner.worldEntered === true,
        worldName: inner.worldName == null || String(inner.worldName) === '' ? null : String(inner.worldName),
        worldPath: inner.worldPath == null || String(inner.worldPath) === '' ? null : String(inner.worldPath),
        kpProjectId: (inner.kpProjectId as string | number | null | undefined) ?? null,
        revision: (inner.revision as string | number | null | undefined) ?? null,
        startedAt: inner.startedAt != null ? String(inner.startedAt) : undefined,
        nplPort,
        service: service || 'paracraft-cli',
        version: inner.version != null ? String(inner.version) : undefined,
    };
}

async function fetchNplIdentity(port: number, expectedPid?: number, timeoutMs = 3000): Promise<Partial<ParacraftIdentity> | null> {
    const nplPort = parseNplPort(port);
    if (!nplPort) return null;
    try {
        const cli = await loopbackJson(nplPort, '/ajax/paracraft_cli?action=health', undefined, timeoutMs);
        if (cli.ok && cli.body.ok !== false) {
            const ident = identityFromHealth(cli.body, nplPort);
            if (!ident) return null;
            if (expectedPid && ident.pid && ident.pid !== expectedPid) return null;
            return ident;
        }
    } catch {
        /* not a paracraft-cli listener */
    }
    return null;
}

export async function pingNpl(port: number, expectedPid?: number): Promise<boolean> {
    return !!(await fetchNplIdentity(port, expectedPid));
}

async function dispatchNpl(client: RegisteredClient, action: string, params: Record<string, unknown>): Promise<unknown> {
    const port = parseNplPort(client.nplPort);
    if (!port) throw new Error('npl port missing');
    // admin-ajax.page reads request:get('action') from query after JSON parse, so
    // ?action=paracraft_cli overwrites the JSON verb and NPL returns unknown action.
    const qs = new URLSearchParams({ action });
    for (const [key, value] of Object.entries(params || {})) {
        if (value == null || value === '') continue;
        if (typeof value === 'object') continue;
        qs.set(key, String(value));
    }
    const path = `/ajax/paracraft_cli?${qs.toString()}`;
    const getActions = new Set(['health', 'world_status', 'screenshot', 'bring_to_front', 'exit', 'open_world']);
    let raw: { ok: boolean; status: number; body: Record<string, unknown> };
    if (getActions.has(action)) {
        raw = await loopbackJson(port, path, undefined, JOB_WAIT_MS);
    } else {
        raw = await loopbackJson(port, path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ v: 1, id: randomUUID(), action, params }),
        }, JOB_WAIT_MS);
    }
    if (!raw.ok || raw.body.ok === false) {
        throw new Error(String(raw.body.error || `npl ${raw.status}`));
    }
    return raw.body;
}

function dropClient(id: string, client: RegisteredClient): void {
    if (client.poller) {
        clearTimeout(client.poller.timer);
        client.poller.resolve([]);
    }
    for (const job of client.jobs) {
        clearTimeout(job.timer);
        job.reject(new Error('client gone'));
    }
    clients.delete(id);
}

function markNplPing(client: RegisteredClient, alive: boolean): void {
    if (alive) {
        client.nplFails = 0;
        client.nplAlive = true;
        client.useNpl = true;
        client.lastSeen = now();
        return;
    }
    client.nplAlive = false;
    client.nplFails = (client.nplFails || 0) + 1;
}

function pruneStale(): void {
    const cutoff = now() - STALE_MS;
    for (const [id, client] of clients) {
        if (client.nplPort && client.useNpl) continue;
        if (client.poller) continue;
        if (client.lastSeen < cutoff) dropClient(id, client);
    }
}

function applyLiveIdentity(client: RegisteredClient, ident: Partial<ParacraftIdentity>): void {
    if (ident.pid != null) client.pid = ident.pid;
    if (ident.startedAt) client.startedAt = ident.startedAt;
    if (ident.version) client.version = ident.version;
    if (ident.platform) client.platform = String(ident.platform);
    const pendingFresh = client.pendingKpProjectId != null && (now() - (client.pendingKpAt || 0)) < 45_000;
    if (pendingFresh && !sameKp(ident.kpProjectId, client.pendingKpProjectId)) {
        client.worldEntered = ident.worldEntered === true;
        client.lastSeen = now();
        return;
    }
    if (pendingFresh && sameKp(ident.kpProjectId, client.pendingKpProjectId)) {
        client.pendingKpProjectId = undefined;
        client.pendingKpAt = undefined;
    }
    const kpChanged = !sameKp(ident.kpProjectId, client.kpProjectId);
    if (ident.kpProjectId !== undefined) client.kpProjectId = ident.kpProjectId ?? null;
    if (kpChanged) {
        client.worldName = ident.worldName ?? null;
        client.worldPath = ident.worldPath ?? null;
        client.lastScreenshot = undefined;
        client.shots = [];
    } else {
        if (ident.worldName) client.worldName = ident.worldName;
        if (ident.worldPath) client.worldPath = ident.worldPath;
    }
    if (ident.revision !== undefined) client.revision = ident.revision ?? null;
    client.worldEntered = ident.worldEntered === true;
    client.lastSeen = now();
}

async function pingNplClients(): Promise<void> {
    await Promise.all([...clients.entries()].map(async ([id, client]) => {
        if (!client.nplPort) return;
        const ident = await fetchNplIdentity(client.nplPort, client.pid);
        markNplPing(client, !!ident);
        if (ident) applyLiveIdentity(client, ident);
        else if (client.nplFails >= NPL_FAILS_TO_DROP) dropClient(id, client);
    }));
}

let keepAliveWatch: ReturnType<typeof setInterval> | null = null;
let lastDiscoverAt = 0;

async function discoverNplClients(force = false): Promise<void> {
    if (!force && now() - lastDiscoverAt < DISCOVER_MIN_MS) return;
    lastDiscoverAt = now();
    const known = new Set<number>();
    for (const client of clients.values()) {
        const port = parseNplPort(client.nplPort);
        if (port) known.add(port);
    }
    const ports: number[] = [];
    for (let port = NPL_SCAN_FROM; port <= NPL_SCAN_TO; port += 1) {
        if (!known.has(port)) ports.push(port);
    }
    await Promise.all(ports.map(async (port) => {
        const ident = await fetchNplIdentity(port, undefined, NPL_SCAN_TIMEOUT_MS);
        if (!ident?.clientId) return;
        await registerClient({ ...ident, nplPort: port }, { skipNplPing: true });
    }));
}

export function startParacraftWatch(): void {
    if (keepAliveWatch) return;
    void discoverNplClients(true);
    keepAliveWatch = setInterval(() => {
        void (async () => {
            pruneStale();
            await pingNplClients();
            await discoverNplClients();
        })();
    }, KEEP_ALIVE_MS);
    keepAliveWatch.unref();
}

export function stopParacraftWatch(): void {
    if (!keepAliveWatch) return;
    clearInterval(keepAliveWatch);
    keepAliveWatch = null;
}

function publicClient(c: RegisteredClient) {
    return {
        clientId: c.clientId,
        platform: c.platform || 'desktop',
        pid: c.pid,
        worldEntered: c.worldEntered === true,
        worldName: c.worldName || null,
        worldPath: c.worldPath || null,
        kpProjectId: c.kpProjectId ?? null,
        revision: c.revision ?? null,
        startedAt: c.startedAt,
        connectedAt: c.connectedAt,
        lastSeen: c.lastSeen,
        hasThumb: !!c.lastScreenshot,
        thumbAt: c.lastScreenshot?.at,
        nplPort: c.useNpl && c.nplPort ? c.nplPort : null,
        useNpl: c.useNpl === true,
        service: c.service,
        version: c.version,
    };
}

export function liveClientCount(): number {
    pruneStale();
    return clients.size;
}

export async function listClients() {
    await discoverNplClients();
    pruneStale();
    return [...clients.values()].map(publicClient);
}

export function unregisterClient(id: string): { ok: boolean } {
    const client = clients.get(id);
    if (client) dropClient(id, client);
    return { ok: true };
}

function sameKp(a: unknown, b: unknown): boolean {
    return String(a ?? '') === String(b ?? '');
}

function applyOpenWorldIdentity(client: RegisteredClient, params: Record<string, unknown>): void {
    const pid = params.projectId ?? params.project_id;
    if (pid == null || String(pid).trim() === '') return;
    const nextKp = String(pid).trim();
    const kpChanged = !sameKp(client.kpProjectId, nextKp);
    client.kpProjectId = /^\d+$/.test(nextKp) ? Number(nextKp) : nextKp;
    client.pendingKpProjectId = client.kpProjectId;
    client.pendingKpAt = now();
    const name = typeof params.name === 'string' ? params.name.trim() : '';
    if (name) client.worldName = name;
    else if (kpChanged) client.worldName = null;
    if (kpChanged) {
        client.worldPath = null;
        client.lastScreenshot = undefined;
        client.shots = [];
    }
}

export async function registerClient(body: Partial<ParacraftIdentity>, opts?: { skipNplPing?: boolean }): Promise<{ ok: boolean; clientId?: string; useNpl?: boolean; nplPort?: number | null; error?: string }> {
    const clientId = String(body.clientId || '').trim();
    if (!clientId) return { ok: false, error: 'clientId required' };
    const prev = clients.get(clientId);
    const nplPort = parseNplPort(body.nplPort) ?? parseNplPort(prev?.nplPort);
    let pendingKpProjectId = prev?.pendingKpProjectId;
    let pendingKpAt = prev?.pendingKpAt;
    const pendingFresh = pendingKpProjectId != null && (now() - (pendingKpAt || 0)) < 45_000;
    let kpProjectId = body.kpProjectId !== undefined ? (body.kpProjectId ?? null) : (prev?.kpProjectId ?? null);
    let ignoreStaleWorld = false;
    if (pendingKpProjectId != null && sameKp(kpProjectId, pendingKpProjectId)) {
        pendingKpProjectId = undefined;
        pendingKpAt = undefined;
    } else if (pendingFresh) {
        kpProjectId = pendingKpProjectId ?? kpProjectId;
        ignoreStaleWorld = true;
    }
    const kpChanged = !sameKp(kpProjectId, prev?.kpProjectId);
    const worldName = ignoreStaleWorld
        ? (prev?.worldName ?? null)
        : (body.worldName != null && String(body.worldName) !== ''
            ? body.worldName
            : (kpChanged ? null : prev?.worldName ?? null));
    const worldPath = ignoreStaleWorld
        ? (prev?.worldPath ?? null)
        : (body.worldPath != null && String(body.worldPath) !== ''
            ? body.worldPath
            : (kpChanged ? null : prev?.worldPath ?? null));
    const next: RegisteredClient = {
        clientId,
        platform: String(body.platform || prev?.platform || 'desktop'),
        pid: typeof body.pid === 'number' ? body.pid : prev?.pid,
        worldEntered: body.worldEntered === true,
        worldName,
        worldPath,
        kpProjectId,
        revision: kpChanged ? (body.revision ?? null) : (body.revision ?? prev?.revision ?? null),
        startedAt: body.startedAt || prev?.startedAt,
        nplPort,
        service: body.service || prev?.service,
        version: body.version || prev?.version,
        lastSeen: now(),
        connectedAt: prev?.connectedAt || now(),
        lastScreenshot: kpChanged ? undefined : prev?.lastScreenshot,
        shots: kpChanged ? [] : (prev?.shots || []),
        history: prev?.history || [],
        jobs: prev?.jobs || [],
        poller: prev?.poller || null,
        useNpl: false,
        nplAlive: false,
        nplFails: prev?.nplFails || 0,
        pendingKpProjectId,
        pendingKpAt,
    };
    if (nplPort) {
        const alive = opts?.skipNplPing ? true : await pingNpl(nplPort, next.pid);
        markNplPing(next, alive);
        if (alive && next.poller) {
            clearTimeout(next.poller.timer);
            next.poller.resolve([]);
            next.poller = null;
        }
    }
    clients.set(clientId, next);
    startParacraftWatch();
    return { ok: true, clientId, useNpl: next.useNpl, nplPort: next.useNpl ? nplPort ?? null : null };
}

function getLive(id: string): RegisteredClient | null {
    pruneStale();
    const client = clients.get(id);
    if (!client) return null;
    client.lastSeen = now();
    return client;
}

function flushJobs(client: RegisteredClient): Array<{ jobId: string; request: Record<string, unknown> }> {
    if (!client.jobs.length) return [];
    const pending = client.jobs.splice(0, client.jobs.length);
    return pending.map((job) => ({ jobId: job.jobId, request: job.request }));
}

export function pollJobs(id: string, waitMs: number): Promise<Array<{ jobId: string; request: Record<string, unknown> }>> {
    const client = getLive(id);
    if (!client) return Promise.resolve([]);
    if (client.useNpl) return Promise.resolve([]);
    const ready = flushJobs(client);
    if (ready.length) return Promise.resolve(ready);

    const hold = Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, waitMs || 2000));
    if (client.poller) {
        clearTimeout(client.poller.timer);
        client.poller.resolve([]);
        client.poller = null;
    }
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            if (client.poller && client.poller.resolve === resolve) client.poller = null;
            resolve([]);
        }, hold);
        client.poller = { resolve, timer };
    });
}

export function completeJob(id: string, jobId: string, result: unknown): { ok: boolean; error?: string } {
    const client = getLive(id);
    if (!client) return { ok: false, error: 'unknown client' };
    const queued = client.jobs.find((j) => j.jobId === jobId);
    // Job is usually already flushed to the client; waiters live on a side map.
    const waiter = jobWaiters.get(jobId);
    if (!waiter && !queued) return { ok: false, error: 'unknown job' };
    if (queued) {
        client.jobs = client.jobs.filter((j) => j.jobId !== jobId);
    }
    if (waiter) {
        clearTimeout(waiter.timer);
        jobWaiters.delete(jobId);
        const payload = (result && typeof result === 'object') ? result as Record<string, unknown> : { ok: true, result };
        cacheScreenshot(client, payload);
        recordEvent(client, waiter.action, (waiter.request.params && typeof waiter.request.params === 'object') ? waiter.request.params as Record<string, unknown> : {}, payload, payload.ok !== false);
        waiter.resolve(payload);
    }
    return { ok: true };
}

const jobWaiters = new Map<string, Job>();

function clipSummary(text: string): string {
    const compact = String(text || '').replace(/\s+/g, ' ').trim();
    return compact.length > SUMMARY_LEN ? `${compact.slice(0, SUMMARY_LEN - 1)}…` : compact;
}

function wantsFreshScreenshot(params: Record<string, unknown> | undefined): boolean {
    const v = params?.fresh ?? params?.force;
    return v === true || v === 1 || v === '1';
}

function summarizeAction(action: string, params: Record<string, unknown>, result: unknown): string {
    const payload = result && typeof result === 'object' ? result as Record<string, unknown> : {};
    const inner = (payload.result && typeof payload.result === 'object')
        ? payload.result as Record<string, unknown>
        : payload;
    if (action === 'run_command') return clipSummary(String(params.command || inner.command || '/'));
    if (action === 'screenshot') return clipSummary(`截图 ${inner.width || '?'}×${inner.height || '?'}`);
    if (action === 'open_world') return clipSummary(`打开 ${params.projectId || params.path || ''}`);
    if (action === 'exit') return '退出客户端';
    if (action === 'bring_to_front') return '前置窗口';
    if (action === 'world_status') return clipSummary(`世界 ${inner.worldName || inner.kpProjectId || ''}`);
    return clipSummary(action);
}

function recordEvent(client: RegisteredClient, action: string, params: Record<string, unknown>, result: unknown, ok: boolean): void {
    if (PING_ACTIONS.has(action)) return;
    client.history.push({ at: now(), action, ok, summary: summarizeAction(action, params, result) });
    if (client.history.length > MAX_HISTORY) client.history.splice(0, client.history.length - MAX_HISTORY);
}

function cacheScreenshot(client: RegisteredClient, payload: Record<string, unknown>): void {
    const inner = (payload.result && typeof payload.result === 'object')
        ? payload.result as Record<string, unknown>
        : payload;
    const base64 = typeof inner.base64 === 'string' ? inner.base64 : '';
    if (!base64) return;
    const shot: ScreenshotCache = {
        mimeType: typeof inner.mimeType === 'string' ? inner.mimeType : 'image/jpeg',
        base64,
        width: typeof inner.width === 'number' ? inner.width : undefined,
        height: typeof inner.height === 'number' ? inner.height : undefined,
        at: now(),
    };
    client.lastScreenshot = shot;
    client.shots.push(shot);
    if (client.shots.length > MAX_SHOTS) client.shots.splice(0, client.shots.length - MAX_SHOTS);
}

export function getTimeline(id: string, limit = 20): { ok: boolean; screenshots: Array<{ at: number; mimeType: string; width?: number; height?: number; dataUrl: string }>; events: HistoryEvent[]; updatedAt: number; error?: string } {
    const client = getLive(id);
    if (!client) return { ok: false, screenshots: [], events: [], updatedAt: 0, error: 'unknown client' };
    const cap = Math.min(MAX_HISTORY, Math.max(1, limit || 20));
    const events = client.history.slice(-cap).reverse();
    const screenshots = client.shots.slice(-MAX_SHOTS).reverse().map((shot) => ({
        at: shot.at,
        mimeType: shot.mimeType,
        width: shot.width,
        height: shot.height,
        dataUrl: `data:${shot.mimeType};base64,${shot.base64}`,
    }));
    const updatedAt = Math.max(client.lastScreenshot?.at || 0, client.history[client.history.length - 1]?.at || 0, client.lastSeen);
    return { ok: true, screenshots, events, updatedAt };
}

function enqueue(client: RegisteredClient, action: string, params: Record<string, unknown>): Promise<unknown> {
    if (action === 'screenshot' && !wantsFreshScreenshot(params) && client.lastScreenshot && (now() - client.lastScreenshot.at) < SCREENSHOT_FRESH_MS) {
        const shot = client.lastScreenshot;
        const cached = {
            v: 1,
            ok: true,
            action: 'screenshot',
            clientId: client.clientId,
            result: {
                ok: true,
                mimeType: shot.mimeType,
                base64: shot.base64,
                width: shot.width,
                height: shot.height,
                cached: true,
            },
        };
        recordEvent(client, action, params, cached, true);
        return Promise.resolve(cached);
    }

    return new Promise((resolve, reject) => {
        const jobId = randomUUID();
        const request = { v: 1, id: jobId, action, params };
        const timer = setTimeout(() => {
            jobWaiters.delete(jobId);
            client.jobs = client.jobs.filter((j) => j.jobId !== jobId);
            reject(new Error('paracraft job timeout'));
        }, JOB_WAIT_MS);
        const job: Job = { jobId, action, request, createdAt: now(), resolve, reject, timer };
        jobWaiters.set(jobId, job);
        if (client.poller) {
            clearTimeout(client.poller.timer);
            const poller = client.poller;
            client.poller = null;
            poller.resolve([{ jobId, request }]);
        } else {
            client.jobs.push(job);
        }
    });
}

export async function dispatchAction(id: string, action: string, params: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    if (!ACTIONS.has(action)) {
        return { status: 400, body: { ok: false, error: `unknown action: ${action}` } };
    }
    const client = getLive(id);
    if (!client) return { status: 404, body: { ok: false, error: 'unknown client' } };
    if (client.useNpl && client.nplPort) {
        try {
            const result = await dispatchNpl(client, action, params);
            if (result && typeof result === 'object') cacheScreenshot(client, result as Record<string, unknown>);
            if (action === 'open_world') applyOpenWorldIdentity(client, params);
            recordEvent(client, action, params, result, true);
            if (action === 'exit') dropClient(id, client);
            return { status: 200, body: result };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (action === 'screenshot' && client.lastScreenshot) {
                const shot = client.lastScreenshot;
                return {
                    status: 200,
                    body: {
                        v: 1,
                        ok: true,
                        action: 'screenshot',
                        clientId: client.clientId,
                        result: {
                            ok: true,
                            mimeType: shot.mimeType,
                            base64: shot.base64,
                            width: shot.width,
                            height: shot.height,
                            cached: true,
                        },
                    },
                };
            }
            recordEvent(client, action, params, { error: message }, false);
            if (action === 'exit') dropClient(id, client);
            return { status: 504, body: { ok: false, error: message } };
        }
    }
    try {
        const result = await enqueue(client, action, params);
        if (action === 'open_world') applyOpenWorldIdentity(client, params);
        if (action === 'exit') dropClient(id, client);
        return { status: 200, body: result };
    } catch (err) {
        if (action === 'exit') dropClient(id, client);
        recordEvent(client, action, params, { error: err instanceof Error ? err.message : String(err) }, false);
        return { status: 504, body: { ok: false, error: err instanceof Error ? err.message : String(err) } };
    }
}

export function getCachedScreenshot(id: string): ScreenshotCache | null {
    const client = getLive(id);
    return client?.lastScreenshot || null;
}

function parseJson(raw: string): Record<string, unknown> {
    if (!raw) return {};
    try {
        const data = JSON.parse(raw);
        return data && typeof data === 'object' ? data as Record<string, unknown> : {};
    } catch {
        return {};
    }
}

export async function tryHandleParacraft(opts: {
    req: http.IncomingMessage;
    res: http.ServerResponse;
    pathname: string;
    method: string;
    readBody: () => Promise<string>;
    sendJson: (status: number, body: unknown) => void;
    assertAuth: () => boolean;
}): Promise<boolean> {
    const { pathname, method, sendJson, assertAuth } = opts;
    if (!pathname.startsWith('/paracraft')) return false;

    if (pathname === '/paracraft/register' && method === 'POST') {
        const body = parseJson(await opts.readBody());
        sendJson(200, await registerClient(body as Partial<ParacraftIdentity>));
        return true;
    }

    if (pathname === '/paracraft/unregister' && method === 'POST') {
        const body = parseJson(await opts.readBody());
        sendJson(200, unregisterClient(String(body.clientId || '')));
        return true;
    }

    if (pathname === '/paracraft/clients' && method === 'GET') {
        if (!assertAuth()) return true;
        sendJson(200, { ok: true, clients: await listClients() });
        return true;
    }

    const poll = pathname.match(/^\/paracraft\/([^/]+)\/jobs\/poll$/);
    if (poll && method === 'POST') {
        const body = parseJson(await opts.readBody());
        const waitMs = Number(body.waitMs) || 2000;
        const id = decodeURIComponent(poll[1]);
        const jobs = await pollJobs(id, waitMs);
        const live = clients.get(id);
        sendJson(200, { ok: true, jobs, useNpl: live?.useNpl === true, nplPort: live?.useNpl ? live.nplPort ?? null : null });
        return true;
    }

    const resultMatch = pathname.match(/^\/paracraft\/([^/]+)\/jobs\/([^/]+)\/result$/);
    if (resultMatch && method === 'POST') {
        const body = parseJson(await opts.readBody());
        sendJson(200, completeJob(decodeURIComponent(resultMatch[1]), decodeURIComponent(resultMatch[2]), body.result ?? body));
        return true;
    }

    const timeline = pathname.match(/^\/paracraft\/([^/]+)\/timeline$/);
    if (timeline && method === 'GET') {
        if (!assertAuth()) return true;
        const rawUrl = opts.req.url || '/';
        const query = rawUrl.includes('?') ? new URL(rawUrl, 'http://127.0.0.1').searchParams : new URLSearchParams();
        sendJson(200, getTimeline(decodeURIComponent(timeline[1]), Number(query.get('limit') || 20)));
        return true;
    }

    const shot = pathname.match(/^\/paracraft\/([^/]+)\/screenshot$/);
    if (shot && method === 'GET') {
        if (!assertAuth()) return true;
        const cached = getCachedScreenshot(decodeURIComponent(shot[1]));
        const rawUrl = opts.req.url || '/';
        const query = rawUrl.includes('?') ? new URL(rawUrl, 'http://127.0.0.1').searchParams : new URLSearchParams();
        const fresh = query.get('fresh') === '1' || query.get('force') === '1';
        if (!fresh && cached && (now() - cached.at) < SCREENSHOT_FRESH_MS) {
            sendJson(200, {
                v: 1,
                ok: true,
                action: 'screenshot',
                clientId: decodeURIComponent(shot[1]),
                result: { ok: true, mimeType: cached.mimeType, base64: cached.base64, width: cached.width, height: cached.height, cached: true },
            });
            return true;
        }
        const dispatched = await dispatchAction(decodeURIComponent(shot[1]), 'screenshot', fresh ? { fresh: true } : {});
        sendJson(dispatched.status, dispatched.body);
        return true;
    }

    const actionMatch = pathname.match(/^\/paracraft\/([^/]+)\/([^/]+)$/);
    if (actionMatch && (method === 'POST' || method === 'GET')) {
        if (!assertAuth()) return true;
        const id = decodeURIComponent(actionMatch[1]);
        const action = decodeURIComponent(actionMatch[2]);
        const body = method === 'POST' ? parseJson(await opts.readBody()) : {};
        const dispatched = await dispatchAction(id, action, body);
        sendJson(dispatched.status, dispatched.body);
        return true;
    }

    sendJson(404, { ok: false, error: 'not found' });
    return true;
}
