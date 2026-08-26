import * as http from 'node:http';
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { BIND_HOST, clearNotifyBridge, writeNotifyBridge } from '../core/config';

function isSafeOpenUrl(url: string): boolean {
    try {
        const u = new URL(url);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
        const h = u.hostname;
        return h === 'keepwork.com' || h.endsWith('.keepwork.com')
            || h === 'localhost' || h === '127.0.0.1';
    } catch {
        return false;
    }
}

export interface NotifyBridgeHandle {
    port: number;
    dispose(): void;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(text);
}

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

export function startNotifyBridge(): NotifyBridgeHandle {
    const token = randomBytes(24).toString('hex');
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        const pathname = url.pathname.replace(/\/+$/, '') || '/';
        const header = String(req.headers.authorization || '');
        const got = (header.match(/^Bearer\s+(.+)$/i) || [])[1] || '';

        if (pathname === '/health' && req.method === 'GET') {
            sendJson(res, 200, { ok: true });
            return;
        }
        if (pathname !== '/notify' || req.method !== 'POST') {
            sendJson(res, 404, { error: 'not found' });
            return;
        }
        if (got !== token) {
            sendJson(res, 401, { error: 'unauthorized' });
            return;
        }
        try {
            const raw = await readBody(req);
            const body = raw ? JSON.parse(raw) as { title?: string; body?: string; openUrl?: string } : {};
            const title = String(body.title || '日历提醒').slice(0, 200);
            const detail = String(body.body || '').slice(0, 300);
            const openUrl = String(body.openUrl || '').trim();
            const safeUrl = isSafeOpenUrl(openUrl) ? openUrl : '';
            sendJson(res, 200, { ok: true });
            void vscode.window.showInformationMessage(
                `${title}${detail ? `\n${detail}` : ''}`,
                '打开日历',
            ).then((action) => {
                if (action === '打开日历' && safeUrl) {
                    return vscode.env.openExternal(vscode.Uri.parse(safeUrl));
                }
                return undefined;
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            sendJson(res, 503, { error: msg });
        }
    });

    server.listen(0, BIND_HOST, () => {
        const addr = server.address();
        const port = addr && typeof addr === 'object' ? addr.port : 0;
        writeNotifyBridge({ port, pid: process.pid, token });
    });

    const dispose = () => {
        clearNotifyBridge(process.pid);
        server.close();
    };

    const addr = server.address();
    return {
        port: addr && typeof addr === 'object' ? addr.port : 0,
        dispose,
    };
}
