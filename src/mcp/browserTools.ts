import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { currentRequest } from './context';
import { managedBrowsers, browserRedact, BrowserArgs } from '../core/browser';

const target = { treeId: z.string().min(1).max(200).regex(/^[^\r\n]+$/), sessionId: z.string().min(1), pageId: z.string().optional() };
const dimensions = { width: z.number().int().min(280).max(2560).optional(), height: z.number().int().min(240).max(2560).optional() };
const timeoutMs = z.number().int().min(1).max(10000).optional();
export const browserToolSchemas = {
    browser_session: z.object({ treeId: target.treeId, action: z.enum(['create', 'list', 'close']), sessionId: z.string().optional(), url: z.string().max(4000).optional(), visible: z.boolean().optional(), ...dimensions }).strict(),
    browser_snapshot: z.object({ ...target, limit: z.number().int().min(1).max(200).optional() }).strict(),
    browser_action: z.object({ ...target, action: z.enum(['navigate', 'reload', 'viewport', 'click', 'fill', 'select', 'press', 'scroll', 'waitFor', 'assert']), url: z.string().max(4000).optional(), selector: z.string().max(1000).optional(), ref: z.string().optional(), value: z.string().max(20000).optional(), key: z.string().max(100).optional(), y: z.number().optional(), deltaY: z.number().optional(), assertion: z.enum(['visible', 'hidden', 'textContains', 'value', 'checked']).optional(), expected: z.union([z.string(), z.boolean()]).optional(), state: z.enum(['attached', 'visible', 'hidden']).optional(), timeoutMs, ...dimensions }).strict(),
    browser_diagnostics: z.object({ ...target, cursor: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(200).optional() }).strict(),
    browser_screenshot: z.object({ ...target, timeoutMs }).strict(),
};
const descriptions = {
    browser_session: 'Create/list/close an isolated Edge/Chrome browser owned by this MCP session and Agent tree. Headless by default. list never launches a browser. Use returned sessionId/pageId.',
    browser_snapshot: 'Read a bounded DOM snapshot with actionable refs; new snapshots and navigation invalidate old refs. No screenshot.',
    browser_action: 'Perform one browser action. Prefer refs from a snapshot or a unique CSS selector. No arbitrary JavaScript. Only http(s) navigation, including localhost development servers.',
    browser_diagnostics: 'Read console, runtime errors, failed resources and navigation since cursor. Return cursor supports incremental reads.',
    browser_screenshot: 'Capture the current viewport as a temporary JPEG image with capture identity, URL, timestamp and viewport. Password fields are masked. Only capture when needed.',
};
export function registerBrowserTools(server: McpServer) {
    for (const name of Object.keys(browserToolSchemas) as Array<keyof typeof browserToolSchemas>) {
        server.registerTool(name, { description: descriptions[name], inputSchema: browserToolSchemas[name] }, async (input: any) => {
            try {
                const args = browserToolSchemas[name].parse(input) as BrowserArgs;
                const sid = currentRequest().sessionId;
                if (!sid) throw new Error('Browser automation requires an initialized HTTP MCP session');
                const result = await managedBrowsers.run(`${sid}\n${args.treeId}`, name, args);
                return result?.content ? result : { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
            } catch (error) {
                return { isError: true, content: [{ type: 'text' as const, text: browserRedact(error instanceof Error ? error.message : String(error)) }] };
            }
        });
    }
}
