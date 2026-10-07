import * as vscode from 'vscode';
import { readToken } from '../../../../src/core/config';
import { ensureDaemon, mcpBaseUrl, mcpEnabled } from './daemon';

export const COPILOT_MCP_PROVIDER = 'keepwork.mcp';

/** Publish the existing singleton daemon without writing user/workspace MCP files. */
export function registerCopilotMcp(context: vscode.ExtensionContext): void {
    // Older VS Code / Cursor versions can still use the rest of the extension.
    if (!vscode.lm?.registerMcpServerDefinitionProvider || !vscode.McpHttpServerDefinition) return;

    const changed = new vscode.EventEmitter<void>();
    const enabled = () => mcpEnabled()
        && vscode.workspace.getConfiguration('keepwork.mcp').get<boolean>('connectCopilot', true);
    const provider: vscode.McpServerDefinitionProvider<vscode.McpHttpServerDefinition> = {
        onDidChangeMcpServerDefinitions: changed.event,
        provideMcpServerDefinitions: () => enabled() ? [new vscode.McpHttpServerDefinition(
            'Keepwork', vscode.Uri.parse(`${mcpBaseUrl()}/mcp`), {}, context.extension.packageJSON.version,
        )] : [],
        resolveMcpServerDefinition: async (server, cancellation) => {
            if (!enabled() || cancellation.isCancellationRequested) return undefined;
            const health = await ensureDaemon(context);
            if (cancellation.isCancellationRequested || !enabled()) return undefined;
            if (!health.ok) throw new Error(`Keepwork MCP: ${health.error || 'failed to start'}`);
            server.uri = vscode.Uri.parse(`${mcpBaseUrl()}/mcp`);
            // Read fresh credentials only at connection time; never publish or persist them.
            server.headers = {};
            if (health.requireAuth) {
                const token = readToken();
                if (!token) throw new Error('Keepwork MCP pairing token is missing. Start the MCP server first.');
                server.headers = { Authorization: `Bearer ${token}` };
            }
            return server;
        },
    };
    context.subscriptions.push(
        changed,
        vscode.lm.registerMcpServerDefinitionProvider(COPILOT_MCP_PROVIDER, provider),
        vscode.workspace.onDidChangeConfiguration(event => {
            // Unrelated terminal/search settings must not rediscover the MCP server.
            if (['enableHttp', 'connectCopilot', 'port', 'workspaceRoot', 'requireAuth']
                .some(key => event.affectsConfiguration(`keepwork.mcp.${key}`))) changed.fire();
        }),
    );
}
