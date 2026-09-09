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
        description: 'Primary desktop control on Windows and experimental macOS. Start with status, then screenshot. macOS uses native session consent (24 hours, no idle timeout); hold Escape or move the pointer to the top-left corner to block the next action. Supports screenshot, native left click, type and navigation key only, no scroll, right-click or reclaim panel. Mac typing depends on application and keyboard support. Never click the reserved top-left stop corner. Windows supports all listed actions with revocable session consent, capture-excluded panel and 2-minute idle expiry. Issue ONE action per model turn and inspect its returned screenshot. inputSent means delivered, not success. Coordinates use the returned image grid (Mac images normalized to screen points); scale resized previews. Open apps using visible OS controls; do not assume Windows Start on Mac. Screenshots are unmasked and shared with the model. Approval expires after 20 seconds. No unattended operation or automatic retries. Prefer browser tools for web work. Never enter secrets; ask the user to enter them locally.',
        inputSchema: computerToolSchema,
    }, async input => {
        const parsed = computerSchema.safeParse(input);
        if (!parsed.success) {
            return { isError: true, content: [{ type: 'text' as const, text: 'Invalid computer_use arguments. Use {"action":"status"}, {"action":"screenshot"}, click with x/y, type with text, key with key, or scroll with delta. Supply only fields for that action.' }] };
        }
        try {
            if (!currentRequest().sessionId) throw new Error('Desktop control requires an initialized HTTP MCP session');
            return await computerController.run(parsed.data, currentRequest().sessionId);
        } catch (error) {
            return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Desktop action unavailable, busy, denied or failed. Inspect desktop state before retrying.' }] };
        }
    });
}
