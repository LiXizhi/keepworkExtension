import * as vscode from 'vscode';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
    console.log('Keepwork extension is now active!');

    // Command: Clone Repository from Keepwork URL
    const cloneCommand = vscode.commands.registerCommand('keepwork.cloneRepository', async () => {
        const keepworkUrl = await vscode.window.showInputBox({
            prompt: 'Enter Keepwork URL',
            placeHolder: 'https://keepwork.com/{owner}/{repo}/...',
            validateInput: (value) => {
                if (!value) {
                    return 'URL is required';
                }
                if (!value.startsWith('https://keepwork.com/')) {
                    return 'URL must start with https://keepwork.com/';
                }
                return null;
            }
        });

        if (!keepworkUrl) {
            return;
        }

        try {
            // Parse the URL to extract owner and repo
            // URL format: https://keepwork.com/{owner}/{repo}/any_path
            const url = new URL(keepworkUrl);
            const pathParts = url.pathname.split('/').filter(part => part.length > 0);

            if (pathParts.length < 2) {
                vscode.window.showErrorMessage('Invalid Keepwork URL. Expected format: https://keepwork.com/{owner}/{repo}/...');
                return;
            }

            const owner = pathParts[0];
            const repo = pathParts[1];

            // Construct git clone URL
            const gitUrl = `https://git.keepwork.com/${owner}/${repo}`;

            // Use VS Code's built-in git clone command
            await vscode.commands.executeCommand('git.clone', gitUrl);

            vscode.window.showInformationMessage(`Cloning ${owner}/${repo} from Keepwork...`);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to parse Keepwork URL: ${error}`);
        }
    });

    // Command: Open file in Keepwork browser
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

        // Get relative path from workspace root
        // Path structure: {owner}/{repo}/subfolder.../file.md
        const relativePath = path.relative(workspaceFolder.uri.fsPath, uri.fsPath);
        const pathParts = relativePath.split(path.sep);

        if (pathParts.length < 2) {
            vscode.window.showErrorMessage('Invalid path structure. Expected: {owner}/{repo}/...');
            return;
        }

        const owner = pathParts[0];
        const repo = pathParts[1];
        const filePath = pathParts.slice(2).join('/');
        const ext = path.extname(filePath).toLowerCase();

        let keepworkUrl: string;

        if (ext === '.md') {
            // For .md files: https://keepwork.com/{owner}/{repo}/{relativepath_without_extension}
            const filePathWithoutExt = filePath.replace(/\.md$/i, '');
            keepworkUrl = `https://keepwork.com/${owner}/${repo}/${filePathWithoutExt}`;
        } else {
            // For non-md files: https://keepwork.com/api/raw/{owner}/{repo}/{relativepath_with_extension}
            keepworkUrl = `https://keepwork.com/api/raw/${owner}/${repo}/${filePath}`;
        }

        try {
            await vscode.env.openExternal(vscode.Uri.parse(keepworkUrl));
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to open URL: ${error}`);
        }
    });

    context.subscriptions.push(cloneCommand, openInKeepworkCommand);
}

export function deactivate() {}
