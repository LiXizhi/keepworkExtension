#!/usr/bin/env node
import { resolvePort, resolveRequireAuth, SERVER_NAME } from '../../../src/core/config';
import { resolveWorkspaceRoot } from '../../../src/core/paths';
import { McpHostKind, startHttpServer } from '../../../src/mcp/http';

function optionValue(args: string[], name: string): string | undefined {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    return value;
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const portText = optionValue(args, '--port');
    const port = portText === undefined ? resolvePort() : Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port: ${portText}`);
    const root = optionValue(args, '--root');
    const requireAuth = args.includes('--require-auth') ? true : resolveRequireAuth();
    const hostKind = resolveHostKind();
    const hostVersion = String(process.env.KEEPWORK_MCP_HOST_VERSION || '').trim() || undefined;

    try {
        const handle = await startHttpServer({ port, root, requireAuth, hostKind, hostVersion });
        console.error(`${SERVER_NAME} listening on http://127.0.0.1:${handle.port}/mcp`);
        console.error(`workspace root: ${resolveWorkspaceRoot(root)}`);
        console.error(`auth: ${handle.requireAuth ? 'token required' : 'open (no token)'}`);

        let closing = false;
        const shutdown = async (): Promise<void> => {
            if (closing) return;
            closing = true;
            await handle.close();
        };
        process.once('SIGINT', () => { void shutdown(); });
        process.once('SIGTERM', () => { void shutdown(); });
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EADDRINUSE') {
            console.error(`${SERVER_NAME} already running on port ${port}`);
            process.exitCode = 0;
            return;
        }
        throw error;
    }
}

function resolveHostKind(): McpHostKind {
    const value = String(process.env.KEEPWORK_MCP_HOST_KIND || '').trim();
    if (value === 'electron-node-runtime' || value === 'local-helper' || value === 'vscode-extension' || value === 'standalone') {
        return value;
    }
    return 'standalone';
}

void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
