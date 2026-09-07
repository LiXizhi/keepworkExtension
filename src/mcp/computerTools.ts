import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { computerController, computerSchema } from '../core/computer';
import { currentRequest } from './context';
import { z } from 'zod';

export const computerToolSchema = z.object({
    action: z.enum(['status', 'screenshot', 'click', 'type', 'key', 'scroll']).default('status').describe('Operation to perform. Omitted action returns status only; use screenshot to capture the desktop.'),
    x: z.number().int().min(0).max(32767).optional().describe('Required for click: physical pixel X on primary screen.'),
    y: z.number().int().min(0).max(32767).optional().describe('Required for click: physical pixel Y on primary screen.'),
    button: z.enum(['left', 'right']).optional(),
    text: z.string().min(1).max(1000).optional().describe('Required for type.'),
    key: z.enum(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown']).optional().describe('Required for key.'),
    delta: z.number().int().min(-1200).max(1200).optional().describe('Required for scroll: wheel units, 120 per notch.'),
}).strict();

export function registerComputerTools(server: McpServer) {
    server.registerTool('computer_use', {
        description: 'Windows primary desktop control: status, screenshot, click, type, key, scroll. Start with screenshot. Issue only ONE desktop action per model turn, then inspect its returned screenshot before deciding the next action. Every input returns a fresh screenshot after a short settling interval; inputSent means input delivered, not task success. If an app is still loading, request screenshot again. Never guess coordinates or repeat an ineffective click. Click x/y use the returned image width/height pixel grid; scale from any resized display. To open an app, locate Start in the screenshot, click it, type the app name, inspect results, then press Enter. Requires native session approval (20 seconds to respond), renewed after Take Back Control, session changes or 2 idle minutes. A capture-excluded border and bottom control panel remain visible. Agent clicks in the panel area fail. Screenshots are unmasked. Input targets the foreground app. No secure desktop/UAC, unattended operation or automatic retries. Prefer browser tools for web pages. Never enter secrets; ask the user to enter them locally.',
        inputSchema: computerToolSchema,
    }, async input => {
        const parsed = computerSchema.safeParse(input);
        if (!parsed.success) {
            return { isError: true, content: [{ type: 'text' as const, text: 'Invalid computer_use arguments. Use {"action":"status"}, {"action":"screenshot"}, click with x/y, type with text, key with key, or scroll with delta. Supply only fields for that action.' }] };
        }
        try {
            if (!currentRequest().sessionId) throw new Error('Desktop control requires an initialized HTTP MCP session');
            return await computerController.run(parsed.data, currentRequest().sessionId);
        } catch {
            return { isError: true, content: [{ type: 'text' as const, text: 'Desktop action unavailable, busy, denied or failed. Inspect desktop state before retrying.' }] };
        }
    });
}