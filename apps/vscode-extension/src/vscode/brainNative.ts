import * as vscode from 'vscode';
import * as path from 'node:path';
const { NativeFiles } = require('../../../../src/core/nativeFiles.cjs');

/** Native file service; the renderer can use grants, never create them from paths. */
export function createBrainNative(context: vscode.ExtensionContext) {
    const files = new NativeFiles(path.join(context.globalStorageUri.fsPath, 'aichat-folder-grants.json'));
    let picking = false;
    return async (method: string, args: Record<string, any> = {}, active = () => true) => {
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid native arguments');
        if (!active()) throw new Error('Native view closed');
        if (method === 'roots') return files.roots();
        if (method === 'workspaceFolders' || method === 'selectWorkspaceFolder') {
            if (vscode.env.remoteName || !vscode.workspace.isTrusted) throw new Error('Open a trusted local VS Code workspace');
            const folders = (vscode.workspace.workspaceFolders || []).filter(folder => folder.uri.scheme === 'file');
            if (method === 'workspaceFolders') return folders.map(folder => ({ uri: folder.uri.toString(), name: folder.name, path: folder.uri.fsPath }));
            const folder = folders.find(folder => folder.uri.toString() === args.uri);
            if (!folder) throw new Error('Folder is no longer in the VS Code workspace');
            return files.grant(folder.uri.fsPath);
        }
        if (method === 'revokeFolder') return files.revoke(args.rootId);
        if (method === 'pickFolder') {
            if (picking) throw new Error('Folder dialog already open');
            picking = true;
            try {
                const selected = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, title: 'AIChat: Open Folder' });
                if (!active() || !selected?.length) return null;
                if (selected[0].scheme !== 'file') throw new Error('Select a local folder');
                return files.grant(selected[0].fsPath);
            } finally { picking = false; }
        }
        if (method === 'file') {
            if (args.op === 'reveal') {
                const uri = vscode.Uri.file(files.resolve(args.rootId, args.rel));
                if (args.mode === 'open') await vscode.commands.executeCommand('vscode.open', uri);
                else await vscode.commands.executeCommand('revealFileInOS', uri);
                return { ok: true };
            }
            const result = files.execute(args.op, args);
            // VS Code webview messages are JSON, unlike Electron's structured clone.
            return result?.bytes ? { ...result, bytes: Array.from(result.bytes) } : result;
        }
        throw new Error('Unsupported native method');
    };
}
