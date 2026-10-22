import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { presenceOriginAllowed, rememberAichatClient } from '../core/aichatPresence';
import { currentRequest } from './context';

/** HTTP MCP extension, deliberately not a model tool or a recorded tool call. */
export function registerMcpPresence(server: McpServer, sessionLive: (id: string) => boolean) {
    server.server.registerCapabilities({ experimental: { 'keepwork/events': { version: 1, presence: 'mcp-v1' } } });
    server.server.setRequestHandler(z.object({ method: z.literal('keepwork/presence'), params: z.record(z.string(), z.unknown()) }), async ({ params }) => {
        const { sessionId, origin } = currentRequest();
        // Reuse the legacy presence endpoint's stricter Origin policy. Never trust
        // sessionId/origin supplied inside params, or reflect credentials in errors.
        if (!presenceOriginAllowed(origin) || !sessionLive(sessionId)) throw new Error('AIChat presence rejected');
        try {
            if (Buffer.byteLength(JSON.stringify(params)) > 16384) throw new Error('Request too large');
            rememberAichatClient({
                sessionId, origin, url: String(params.url || ''), token: String(params.token || ''),
                baseURL: params.baseURL as string, owner: params.owner as string,
                handler: params.handler === true, brainRoot: params.brainRoot as string,
                defaultExecutor: params.defaultExecutor as { backend?: string; model?: string },
            });
        } catch { throw new Error('AIChat presence rejected'); }
        return { remembered: true };
    });
}
