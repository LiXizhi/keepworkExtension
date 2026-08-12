import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SERVER_NAME, SERVER_VERSION } from '../core/config';
import { hasRipgrep, grepFiles, formatGrepResult } from '../core/grep';
import { resolveWorkspaceRoot } from '../core/paths';
import { enqueueSession, formatTerminalResult, runTerminal } from '../core/terminal';
import { currentRequest } from './context';
import { recordCall, summarizeArgs } from './sessions';

export interface ServerRuntime {
    root: string;
    port: number;
    startedAt: string;
}

function textResult(text: string, isError = false) {
    return { content: [{ type: 'text' as const, text }], isError };
}

function wrap<T extends Record<string, unknown>>(
    tool: string,
    handler: (args: T) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>,
) {
    return async (args: T) => {
        const ctx = currentRequest();
        const started = Date.now();
        let ok = true;
        let error = '';
        try {
            const result = await handler(args);
            ok = !result.isError;
            if (result.isError) error = result.content[0]?.text?.slice(0, 200) || 'error';
            return result;
        } catch (err) {
            ok = false;
            error = err instanceof Error ? err.message : String(err);
            return textResult(`Failed: ${error}`, true);
        } finally {
            if (ctx.sessionId) {
                recordCall({
                    sessionId: ctx.sessionId,
                    origin: ctx.origin,
                    tool,
                    summary: summarizeArgs(tool, args),
                    ok,
                    error: error || undefined,
                    durationMs: Date.now() - started,
                });
            }
        }
    };
}

export function createMcpServer(runtime: ServerRuntime): McpServer {
    const server = new McpServer({
        name: SERVER_NAME,
        version: SERVER_VERSION,
    });

    server.registerTool(
        'mcp_status',
        {
            description: 'Report Keepwork local MCP daemon status: workspace root, port, ripgrep availability.',
            inputSchema: z.object({}),
        },
        wrap('mcp_status', async () => {
            const rg = await hasRipgrep();
            const text = [
                '# Keepwork local MCP',
                '',
                `- name: ${SERVER_NAME} ${SERVER_VERSION}`,
                `- port: ${runtime.port}`,
                `- pid: ${process.pid}`,
                `- workspaceRoot: ${runtime.root}`,
                `- startedAt: ${runtime.startedAt}`,
                `- ripgrep: ${rg ? 'yes' : 'no (Node walker fallback)'}`,
                '',
                'Tools: run_terminal, grep_files, mcp_status',
            ].join('\n');
            return textResult(text);
        }),
    );

    server.registerTool(
        'run_terminal',
        {
            description: 'Run a shell command on the user\'s local disk under the MCP workspace root. cwd is relative to that root. Requires user confirmation in AIChat.',
            inputSchema: z.object({
                command: z.string().describe('Shell command to run'),
                cwd: z.string().optional().describe('Working directory relative to the workspace root'),
                timeoutMs: z.number().optional().describe('Timeout in milliseconds (default 30000, max 120000)'),
            }),
        },
        wrap('run_terminal', async (args) => {
            const ctx = currentRequest();
            const result = await enqueueSession(ctx.sessionId, () => runTerminal({
                command: String(args.command || ''),
                cwd: args.cwd ? String(args.cwd) : undefined,
                timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
                root: resolveWorkspaceRoot(runtime.root),
            }));
            return textResult(formatTerminalResult(result), !result.ok);
        }),
    );

    server.registerTool(
        'grep_files',
        {
            description: 'Search file contents under the MCP workspace root. Prefer this over shelling out to grep. pattern is a regex.',
            inputSchema: z.object({
                pattern: z.string().describe('Regular expression to search for'),
                path: z.string().optional().describe('Directory or file relative to the workspace root'),
                glob: z.string().optional().describe('Optional glob filter, e.g. **/*.ts'),
                maxMatches: z.number().optional().describe('Maximum matches to return (default 50, max 200)'),
            }),
        },
        wrap('grep_files', async (args) => {
            const result = await grepFiles({
                pattern: String(args.pattern || ''),
                path: args.path ? String(args.path) : undefined,
                glob: args.glob ? String(args.glob) : undefined,
                maxMatches: typeof args.maxMatches === 'number' ? args.maxMatches : undefined,
                root: resolveWorkspaceRoot(runtime.root),
            });
            return textResult(formatGrepResult(result), !result.ok);
        }),
    );

    return server;
}
