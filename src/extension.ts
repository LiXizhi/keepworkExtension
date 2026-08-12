import * as vscode from 'vscode';
import * as path from 'node:path';
import { parseKeepworkCloneUrl, buildKeepworkOpenUrl } from './core/keepwork';
import { readToken } from './core/config';
import { ensureDaemon, mcpEnabled, stopDaemon } from './vscode/daemon';
import { createMcpStatusBar, refreshStatusBar } from './vscode/statusBar';
import { openMcpPanel } from './vscode/mcpPanel';

export function activate(context: vscode.ExtensionContext) {
    console.log('Keepwork extension is now active!');

    const cloneCommand = vscode.commands.registerCommand('keepwork.cloneRepository', async () => {
        const keepworkUrl = await vscode.window.showInputBox({
            prompt: 'Enter Keepwork URL',
            placeHolder: 'https://keepwork.com/{owner}/{repo}/...',
            validateInput: (value) => {
                if (!value) return 'URL is required';
                if (!value.startsWith('https://keepwork.com/')) return 'URL must start with https://keepwork.com/';
                return null;
            },
        });
        if (!keepworkUrl) return;
        try {
            const { owner, repo, gitUrl } = parseKeepworkCloneUrl(keepworkUrl);
            await vscode.commands.executeCommand('git.clone', gitUrl);
            vscode.window.showInformationMessage(`Cloning ${owner}/${repo} from Keepwork...`);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to parse Keepwork URL: ${error}`);
        }
    });

    const openInKeepworkCommand = vscode.commands.registerCommand('keepwork.openInKeepwork', async (uri: vscode.Uri) => {
        if (!uri) {
            vscode.window.showErrorMessage('No file selected');
            return;
        }
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('File is not in a workspace folder');
            return;
        }
        const relativePath = path.relative(workspaceFolder.uri.fsPath, uri.fsPath);
        try {
            const keepworkUrl = buildKeepworkOpenUrl(relativePath);
            await vscode.env.openExternal(vscode.Uri.parse(keepworkUrl));
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to open URL: ${error}`);
        }
    });

    let panel: vscode.WebviewPanel | undefined;
    const showMcp = vscode.commands.registerCommand('keepwork.showMcpServer', () => {
        if (panel) {
            panel.reveal();
            return;
        }
        panel = openMcpPanel(context);
        panel.onDidDispose(() => { panel = undefined; });
    });

    const startMcp = vscode.commands.registerCommand('keepwork.startMcpServer', async () => {
        const result = await ensureDaemon(context);
        if (result.ok) vscode.window.showInformationMessage('Keepwork MCP is running');
        else vscode.window.showErrorMessage(`Keepwork MCP: ${result.error || 'failed to start'}`);
        await refreshStatusBar(status);
    });

    const stopMcp = vscode.commands.registerCommand('keepwork.stopMcpServer', async () => {
        const ok = await stopDaemon();
        vscode.window.showInformationMessage(ok ? 'Keepwork MCP stopped' : 'Keepwork MCP was not running');
        await refreshStatusBar(status);
    });

    const copyToken = vscode.commands.registerCommand('keepwork.copyMcpToken', async () => {
        const token = readToken();
        if (!token) {
            vscode.window.showWarningMessage('No pairing token yet. Start the MCP server first.');
            return;
        }
        await vscode.env.clipboard.writeText(token);
        vscode.window.showInformationMessage('Keepwork MCP token copied');
    });

    const status = createMcpStatusBar('keepwork.showMcpServer');
    const poll = setInterval(() => { void refreshStatusBar(status); }, 3000);

    context.subscriptions.push(
        cloneCommand,
        openInKeepworkCommand,
        showMcp,
        startMcp,
        stopMcp,
        copyToken,
        status,
        { dispose: () => clearInterval(poll) },
    );

    if (mcpEnabled()) {
        void ensureDaemon(context).then(() => refreshStatusBar(status));
    } else {
        void refreshStatusBar(status);
    }
}

export function deactivate() {}
