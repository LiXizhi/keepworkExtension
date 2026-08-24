import { randomUUID } from 'node:crypto';
import type * as http from 'node:http';

const STALE_MS = 90_000;
const SCREENSHOT_FRESH_MS = 8_000;
const JOB_WAIT_MS = 15_000;
const MIN_POLL_MS = 500;
const MAX_POLL_MS = 30_000;
const ACTIONS = new Set(['health', 'world_status', 'run_command', 'screenshot', 'open_world']);

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

interface RegisteredClient extends ParacraftIdentity {
    lastSeen: number;
    lastScreenshot?: ScreenshotCache;
    jobs: Job[];
    poller: Poller | null;
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

function pruneStale(): void {
    const cutoff = now() - STALE_MS;
    for (const [id, client] of clients) {
        if (client.lastSeen < cutoff) {
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
    }
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
        lastSeen: c.lastSeen,
        hasThumb: !!c.lastScreenshot,
        thumbAt: c.lastScreenshot?.at,
        service: c.service,
        version: c.version,
    };
}

export function liveClientCount(): number {
    pruneStale();
    return clients.size;
}

export function listClients() {
    pruneStale();
    return [...clients.values()].map(publicClient);
}

export function registerClient(body: Partial<ParacraftIdentity>): { ok: boolean; clientId?: string; error?: string } {
    const clientId = String(body.clientId || '').trim();
    if (!clientId) return { ok: false, error: 'clientId required' };
    const prev = clients.get(clientId);
    const next: RegisteredClient = {
        clientId,
        platform: String(body.platform || prev?.platform || 'desktop'),
        pid: typeof body.pid === 'number' ? body.pid : prev?.pid,
        worldEntered: body.worldEntered === true,
        worldName: body.worldName ?? prev?.worldName ?? null,
        worldPath: body.worldPath ?? prev?.worldPath ?? null,
        kpProjectId: body.kpProjectId ?? prev?.kpProjectId ?? null,
        revision: body.revision ?? prev?.revision ?? null,
        startedAt: body.startedAt || prev?.startedAt,
        service: body.service || prev?.service,
        version: body.version || prev?.version,
        lastSeen: now(),
        lastScreenshot: prev?.lastScreenshot,
        jobs: prev?.jobs || [],
        poller: prev?.poller || null,
    };
    clients.set(clientId, next);
    return { ok: true, clientId };
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
        waiter.resolve(payload);
    }
    return { ok: true };
}

const jobWaiters = new Map<string, Job>();

function cacheScreenshot(client: RegisteredClient, payload: Record<string, unknown>): void {
    const inner = (payload.result && typeof payload.result === 'object')
        ? payload.result as Record<string, unknown>
        : payload;
    const base64 = typeof inner.base64 === 'string' ? inner.base64 : '';
    if (!base64) return;
    client.lastScreenshot = {
        mimeType: typeof inner.mimeType === 'string' ? inner.mimeType : 'image/jpeg',
        base64,
        width: typeof inner.width === 'number' ? inner.width : undefined,
        height: typeof inner.height === 'number' ? inner.height : undefined,
        at: now(),
    };
}

function enqueue(client: RegisteredClient, action: string, params: Record<string, unknown>): Promise<unknown> {
    if (action === 'screenshot' && client.lastScreenshot && (now() - client.lastScreenshot.at) < SCREENSHOT_FRESH_MS) {
        const shot = client.lastScreenshot;
        return Promise.resolve({
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
        });
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
    try {
        const result = await enqueue(client, action, params);
        return { status: 200, body: result };
    } catch (err) {
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
        sendJson(200, registerClient(body as Partial<ParacraftIdentity>));
        return true;
    }

    if (pathname === '/paracraft/clients' && method === 'GET') {
        if (!assertAuth()) return true;
        sendJson(200, { ok: true, clients: listClients() });
        return true;
    }

    const poll = pathname.match(/^\/paracraft\/([^/]+)\/jobs\/poll$/);
    if (poll && method === 'POST') {
        const body = parseJson(await opts.readBody());
        const waitMs = Number(body.waitMs) || 2000;
        const jobs = await pollJobs(decodeURIComponent(poll[1]), waitMs);
        sendJson(200, { ok: true, jobs });
        return true;
    }

    const resultMatch = pathname.match(/^\/paracraft\/([^/]+)\/jobs\/([^/]+)\/result$/);
    if (resultMatch && method === 'POST') {
        const body = parseJson(await opts.readBody());
        sendJson(200, completeJob(decodeURIComponent(resultMatch[1]), decodeURIComponent(resultMatch[2]), body.result ?? body));
        return true;
    }

    const shot = pathname.match(/^\/paracraft\/([^/]+)\/screenshot$/);
    if (shot && method === 'GET') {
        if (!assertAuth()) return true;
        const cached = getCachedScreenshot(decodeURIComponent(shot[1]));
        if (cached && (now() - cached.at) < SCREENSHOT_FRESH_MS) {
            sendJson(200, {
                v: 1,
                ok: true,
                action: 'screenshot',
                clientId: decodeURIComponent(shot[1]),
                result: { ok: true, mimeType: cached.mimeType, base64: cached.base64, width: cached.width, height: cached.height, cached: true },
            });
            return true;
        }
        const dispatched = await dispatchAction(decodeURIComponent(shot[1]), 'screenshot', {});
        sendJson(dispatched.status, dispatched.body);
        return true;
    }

    const actionMatch = pathname.match(/^\/paracraft\/([^/]+)\/([^/]+)$/);
    if (actionMatch && method === 'POST') {
        if (!assertAuth()) return true;
        const id = decodeURIComponent(actionMatch[1]);
        const action = decodeURIComponent(actionMatch[2]);
        const body = parseJson(await opts.readBody());
        const dispatched = await dispatchAction(id, action, body);
        sendJson(dispatched.status, dispatched.body);
        return true;
    }

    sendJson(404, { ok: false, error: 'not found' });
    return true;
}
