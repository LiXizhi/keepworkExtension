import * as http from 'node:http';
import { AgentSessions, ownerKey } from '../core/agentSessions';

export async function handleAgentHttp(req: http.IncomingMessage, res: http.ServerResponse, url: URL, manager: AgentSessions) {
    res.setHeader('Cache-Control', 'no-store');
    const send = (status: number, data: any) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    try {
        const owner = ownerKey(String(req.headers.origin || ''), String(req.headers['x-agent-owner'] || ''));
        let input: any = {};
        if (req.method === 'POST' || req.method === 'PATCH') {
            if (!String(req.headers['content-type']).startsWith('application/json')) throw new Error('JSON required');
            const chunks: Buffer[] = []; let size = 0;
            const limit = url.pathname.startsWith('/agents/contexts/') && url.pathname.endsWith('/result') ? 12_500_000 : 2_000_000;
            for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error('Request too large'); chunks.push(chunk); }
            input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        }
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts[1] === 'contexts') {
            const id = parts[2], action = parts[3];
            if (id === 'revoke' && req.method === 'POST') { manager.revokeContext(owner); send(200, { ok: true }); return; }
            if (!action && req.method === 'POST') { send(200, manager.toolBridge.register(owner, id, input)); return; }
            if (action === 'credentials' && req.method === 'POST') { send(200, manager.registerWorkspaceGrant(owner, id, input)); return; }
            if (action === 'overlay' && req.method === 'POST') { send(200, await manager.workspaceFiles.overlayOperation(owner, id, input)); return; }
            if (action === 'file' && req.method === 'POST') { send(200, await manager.workspaceFiles.execute(owner, id, input)); return; }
            if (action === 'events' && req.method === 'GET') { manager.toolBridge.attach(owner, id, url.searchParams.get('pageId') || '', url.searchParams.get('generation') || '', res); return; }
            if (action === 'result' && req.method === 'POST') { send(200, manager.toolBridge.result(owner, id, input)); return; }
            send(404, { error: 'Unknown context operation' }); return;
        }
        if (parts.join('/') === 'agents/backends' && req.method === 'GET') {
            if (url.searchParams.get('probe') === 'executable') { send(200, manager.inventory()); return; }
            const backend = url.searchParams.get('backend');
            send(200, backend ? { [backend]: await manager.status(backend, {
                owner, cwd: url.searchParams.get('cwd') || undefined,
                conversationId: url.searchParams.get('conversationId') || undefined,
                sessionId: url.searchParams.get('sessionId') || undefined,
                model: url.searchParams.get('model') || undefined,
                refresh: url.searchParams.get('refresh') === '1',
            }) } : await manager.backends()); return;
        }
        if (parts.join('/') === 'agents/login' && req.method === 'POST') { send(200, await manager.login(input.backend || 'codex')); return; }
        if (parts[1] !== 'sessions') { send(404, { error: 'Unknown agent endpoint' }); return; }
        const id = parts[2], action = parts[3];
        if (!id && req.method === 'GET') {
            const offset = Number(url.searchParams.get('cursor') || 0);
            if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000) throw new Error('Invalid list cursor');
            const sessions = manager.list(owner, offset, 100);
            send(200, { sessions, nextCursor: sessions.length === 100 ? offset + 100 : null }); return;
        }
        if (!id && req.method === 'POST') { send(200, await manager.create(owner, input)); return; }
        if (id && !action && req.method === 'GET') { send(200, await manager.read(id, owner)); return; }
        if (id && !action && req.method === 'PATCH') { send(200, await manager.update(id, owner, input)); return; }
        if (id && req.method === 'POST') {
            if (action === 'turns') { send(200, await manager.turn(id, owner, input)); return; }
            if (action === 'interrupt') { send(200, await manager.interrupt(id, owner)); return; }
            if (action === 'respond') { send(200, manager.respond(id, owner, input)); return; }
        }
        if (id && action === 'events' && req.method === 'GET') {
            await manager.read(id, owner);
            if (res.destroyed) return;
            let unsubscribe: (() => void) | undefined;
            let blocked = false, latest: any, ending = false;
            let drainTimeout: NodeJS.Timeout | undefined;
            const write = (text: string) => {
                // false means accepted into Node's buffer, NOT a failed write.
                // Pause until drain; keep at most one newer full snapshot.
                blocked = !res.write(text);
                if (blocked) {
                    drainTimeout = setTimeout(() => res.destroy(), 30000);
                    drainTimeout.unref();
                }
            };
            const flush = () => {
                if (res.destroyed || blocked) return;
                if (latest) { const event = latest; latest = undefined; write(JSON.stringify(event) + '\n'); }
                if (ending && !blocked) res.end();
            };
            const onDrain = () => {
                clearTimeout(drainTimeout); drainTimeout = undefined; blocked = false; flush();
            };
            const heartbeat = setInterval(() => { if (!res.destroyed && !blocked && !ending) write('\n'); }, 20000); heartbeat.unref();
            res.on('drain', onDrain);
            res.on('close', () => { clearInterval(heartbeat); clearTimeout(drainTimeout); res.off('drain', onDrain); unsubscribe?.(); });
            res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
            unsubscribe = manager.subscribe(id, owner, event => {
                if (event.closed) ending = true; else latest = event;
                flush();
            });
            if (res.destroyed) unsubscribe();
            return;
        }
        send(404, { error: 'Unknown agent operation' });
    } catch (error) {
        if (!res.headersSent) send(400, { error: (error as Error).message, acceptanceUnknown: (error as any).acceptanceUnknown === true }); else res.end();
    }
}
