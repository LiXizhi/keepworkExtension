import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

interface Client { clientId: string; platform?: string; kpProjectId?: string | number | null; worldEntered?: boolean }
interface Launch {
    ok: boolean; launchId: string; projectId?: number; target: 'client' | 'project'; state: 'waiting' | 'ready' | 'failed';
    startedAt: number; deadline: number; clientId?: string; reused?: boolean; error?: string; retryAfterMs?: number;
    initialClientIds?: string[];
}

// Fixed protocol grammar: no arbitrary URLs, shell commands, paths or login tokens.
export function desktopProtocolUrl(projectId?: number): string {
    if (projectId === undefined) return 'paracraft://protocol="paracraft" debug="main"';
    if (!Number.isSafeInteger(projectId) || projectId <= 0) throw new Error('positive integer projectId required');
    return `paracraft://cmd/loadworld ${projectId} debug="main"`;
}

export function openDesktopProtocol(url: string): Promise<void> {
    if (url !== desktopProtocolUrl() && !/^paracraft:\/\/cmd\/loadworld [1-9]\d* debug="main"$/.test(url)) return Promise.reject(new Error('invalid_protocol_url'));
    if (process.platform !== 'win32') return Promise.reject(new Error('unsupported_platform: desktop protocol launch requires Windows'));
    const script = `$ErrorActionPreference='Stop'; Start-Process -FilePath '${url.replace(/'/g, "''")}'`;
    return new Promise((resolve, reject) => {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
            { windowsHide: true, timeout: 10000 }, error => {
                if (error) reject(new Error('protocol_launch_failed: check the installed paracraft URL handler'));
                else resolve();
            });
    });
}

// The singleton hub owns launch deduplication for HTTP and all stdio clients.
export function createParacraftLauncher(list: () => Promise<Client[]>, open = openDesktopProtocol, clock = Date.now) {
    const jobs = new Map<string, Launch>();
    const pending = new Map<number | 'client', Launch>();
    const probing = new Map<string, Promise<void>>();
    const key = (job: Launch) => job.projectId ?? 'client';
    const copy = (job: Launch) => {
        const { initialClientIds, ...result } = job;
        return { ...result, retryAfterMs: job.state === 'waiting' ? 1500 : undefined };
    };
    const match = (clients: Client[], projectId: number) => clients.filter(c => c.platform !== 'wasm' && c.worldEntered && String(c.kpProjectId) === String(projectId))
        .sort((a, b) => a.clientId.localeCompare(b.clientId))[0];
    async function refresh(job: Launch) {
        if (job.state !== 'waiting') return;
        let probe = probing.get(job.launchId);
        if (!probe) {
            probe = (async () => {
                const clients = await list();
                const client = job.projectId !== undefined ? match(clients, job.projectId)
                    : clients.filter(c => c.platform !== 'wasm' && !job.initialClientIds?.includes(c.clientId))
                        .sort((a, b) => a.clientId.localeCompare(b.clientId))[0];
                if (job.state !== 'waiting') return;
                if (client) { job.state = 'ready'; job.clientId = client.clientId; }
                else if (clock() >= job.deadline) { job.state = 'failed'; job.ok = false; job.error = job.target === 'client'
                    ? 'launch_timeout: no new desktop client registered' : 'launch_timeout: no matching desktop world registered'; }
                if (job.state !== 'waiting' && pending.get(key(job)) === job) pending.delete(key(job));
            })().finally(() => probing.delete(job.launchId));
            probing.set(job.launchId, probe);
        }
        await probe;
    }
    async function status(launchId: string, waitSeconds = 0) {
        const job = jobs.get(launchId);
        if (!job) return { ok: false, error: 'unknown_launch' };
        const until = clock() + waitSeconds * 1000;
        do {
            await refresh(job);
            if (job.state !== 'waiting' || clock() >= until) break;
            await new Promise(resolve => setTimeout(resolve, 500));
        } while (true);
        return copy(job);
    }
    async function launch(projectId?: number, waitSeconds = 0) {
        const url = desktopProtocolUrl(projectId);
        const pendingKey = projectId ?? 'client';
        let job = pending.get(pendingKey);
        if (!job) {
            for (const [id, previous] of jobs) if (clock() - previous.startedAt > 600000 && previous.state !== 'waiting') jobs.delete(id);
            if (jobs.size >= 128) return { ok: false, error: 'launch_capacity' };
            job = { ok: true, launchId: randomUUID(), projectId, target: projectId === undefined ? 'client' : 'project', state: 'waiting', startedAt: clock(), deadline: clock() + 60000 };
            jobs.set(job.launchId, job); pending.set(pendingKey, job);
            const current = job;
            // Install the pending entry before discovery so simultaneous chats cannot launch twice.
            const initial = (async () => {
                const clients = await list();
                current.initialClientIds = clients.map(c => c.clientId);
                const client = projectId !== undefined ? match(clients, projectId)
                    : clients.filter(c => c.platform !== 'wasm' && c.worldEntered === false && !c.kpProjectId)
                        .sort((a, b) => a.clientId.localeCompare(b.clientId))[0];
                if (client) { current.state = 'ready'; current.clientId = client.clientId; current.reused = true; pending.delete(pendingKey); }
                else { await open(url); current.reused = false; }
            })().catch((error: unknown) => {
                current.ok = false; current.state = 'failed'; current.error = error instanceof Error && error.message.startsWith('unsupported_platform:') ? error.message : 'protocol_launch_failed: check the installed paracraft URL handler';
                if (pending.get(pendingKey) === current) pending.delete(pendingKey);
            }).finally(() => probing.delete(current.launchId));
            probing.set(current.launchId, initial);
        }
        return status(job.launchId, waitSeconds);
    }
    return { launch, status };
}
