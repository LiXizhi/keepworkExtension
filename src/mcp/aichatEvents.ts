import { touchAichatPresence } from '../core/aichatPresence';
import type * as http from 'node:http';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Personas } from '../core/personas';

/** Attach owner-scoped invalidations to the existing MCP GET, never a second SSE. */
export function attachAichatEvents(res: http.ServerResponse, transport: StreamableHTTPServerTransport,
    personas: Pick<Personas, 'watch'>, owner: string) {
    let closed = false, pending = false, dirty = !!owner;
    const send = async () => {
        if (closed || pending) return;
        pending = true;
        let sent = false;
        const changed = dirty;
        dirty = false;
        try {
            await transport.send({ jsonrpc: '2.0', method: changed
                ? 'notifications/keepwork/personas_changed' : 'notifications/keepwork/alive', params: {} });
            sent = true;
            if (transport.sessionId) touchAichatPresence(transport.sessionId);
        } catch { dirty ||= changed; /* GET may still be opening; retry on heartbeat. */ }
        finally { pending = false; if (sent && dirty) void send(); }
    };
    const stop = owner ? personas.watch(owner, () => { dirty = true; void send(); }, () => res.end()) : () => {};
    // Transport installs its stream asynchronously; ready invalidation is retried
    // until sent, so reconnect always refreshes snapshots missed while offline.
    const ready = setTimeout(() => void send(), 100);
    const heartbeat = setInterval(() => void send(), 25000);
    ready.unref(); heartbeat.unref();
    const cleanup = () => { closed = true; clearTimeout(ready); clearInterval(heartbeat); stop(); };
    res.once('close', cleanup);
    return cleanup;
}
