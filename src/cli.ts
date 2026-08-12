#!/usr/bin/env node
import { resolvePort, SERVER_NAME } from './core/config';
import { resolveWorkspaceRoot } from './core/paths';
import { startHttpServer } from './mcp/http';
import { startStdioServer } from './mcp/stdio';

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const stdio = args.includes('--stdio');
    const portFlag = args.findIndex(a => a === '--port');
    const port = portFlag >= 0 ? Number(args[portFlag + 1]) : resolvePort();
    const rootFlag = args.findIndex(a => a === '--root');
    const root = rootFlag >= 0 ? args[rootFlag + 1] : undefined;

    if (stdio) {
        await startStdioServer({ root, port });
        return;
    }

    try {
        const handle = await startHttpServer({ port, root });
        console.error(`${SERVER_NAME} listening on http://127.0.0.1:${handle.port}/mcp`);
        console.error(`workspace root: ${resolveWorkspaceRoot(root)}`);
        console.error(`token: ${handle.token}`);
        console.error(`token file: ~/.keepwork-mcp/token`);
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EADDRINUSE') {
            console.error(`${SERVER_NAME} already running on port ${port}`);
            process.exit(0);
        }
        console.error(err);
        process.exit(1);
    }
}

void main();
