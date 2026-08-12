import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolvePort } from '../core/config';
import { resolveWorkspaceRoot } from '../core/paths';
import { createMcpServer } from './server';

export async function startStdioServer(opts?: { root?: string; port?: number }): Promise<void> {
    const server = createMcpServer({
        root: resolveWorkspaceRoot(opts?.root),
        port: resolvePort(opts?.port),
        startedAt: new Date().toISOString(),
    });
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
