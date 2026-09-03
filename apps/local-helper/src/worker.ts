import { resolvePort, resolveRequireAuth } from '../../../src/core/config';
import { resolveWorkspaceRoot } from '../../../src/core/paths';
import { startHttpServer } from '../../../src/mcp/http';

type ParentPort = { postMessage(message: unknown): void };

function notifyParent(message: unknown): void {
    const port = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;
    port?.postMessage(message);
}

async function main(): Promise<void> {
    const port = resolvePort();
    const root = resolveWorkspaceRoot();
    const requireAuth = resolveRequireAuth();
    try {
        const server = await startHttpServer({ port, root, requireAuth });
        notifyParent({ type: 'ready', port: server.port, root, requireAuth: server.requireAuth });
    } catch (error) {
        const err = error as NodeJS.ErrnoException;
        notifyParent({
            type: 'error',
            code: err.code || '',
            message: error instanceof Error ? error.message : String(error),
        });
        process.exitCode = err.code === 'EADDRINUSE' ? 0 : 1;
    }
}

void main();
