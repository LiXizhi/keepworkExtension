import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Notification, shell } from 'electron';
import {
    BIND_HOST,
    clearNotifyBridge,
    isPidAlive,
    readNotifyBridge,
    writeNotifyBridge,
} from '../../../src/core/config';

export interface HelperNotifyBridgeHandle {
    port: number;
    dispose(): void;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (chunk) => {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += buf.length;
            if (size > 1024 * 1024) {
                reject(new Error('request body is too large'));
                req.destroy();
                return;
            }
            chunks.push(buf);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function isSafeOpenUrl(raw: string): boolean {
    try {
        const url = new URL(raw);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
        return url.hostname === 'keepwork.com'
            || url.hostname.endsWith('.keepwork.com')
            || url.hostname === 'localhost'
            || url.hostname === '127.0.0.1';
    } catch {
        return false;
    }
}

async function revealPath(abs: string): Promise<void> {
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
        const error = await shell.openPath(abs);
        if (error) throw new Error(error);
        return;
    }
    shell.showItemInFolder(abs);
}

export async function startHelperNotifyBridge(): Promise<HelperNotifyBridgeHandle> {
    const token = randomBytes(24).toString('hex');
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        const pathname = url.pathname.replace(/\/+$/, '') || '/';
        const header = String(req.headers.authorization || '');
        const supplied = (header.match(/^Bearer\s+(.+)$/i) || [])[1] || '';

        if (pathname === '/health' && req.method === 'GET') {
            sendJson(res, 200, { ok: true, name: 'kp-local-helper-notify' });
            return;
        }
        if (supplied !== token) {
            sendJson(res, 401, { error: 'unauthorized' });
            return;
        }

        try {
            if (pathname === '/reveal' && req.method === 'POST') {
                const body = JSON.parse((await readBody(req)) || '{}') as { path?: string };
                const requested = String(body.path || '').trim();
                if (!requested || !path.isAbsolute(requested) || !fs.existsSync(requested)) {
                    sendJson(res, 400, { error: 'path is not an existing absolute path' });
                    return;
                }
                await revealPath(path.resolve(requested));
                sendJson(res, 200, { ok: true });
                return;
            }

            if (pathname === '/notify' && req.method === 'POST') {
                const body = JSON.parse((await readBody(req)) || '{}') as {
                    title?: string;
                    body?: string;
                    openUrl?: string;
                };
                const title = String(body.title || 'Keepwork 提醒').slice(0, 200);
                const detail = String(body.body || '').slice(0, 300);
                const openUrl = String(body.openUrl || '').trim();
                if (Notification.isSupported()) {
                    const notification = new Notification({ title, body: detail });
                    if (isSafeOpenUrl(openUrl)) {
                        notification.on('click', () => { void shell.openExternal(openUrl); });
                    }
                    notification.show();
                }
                sendJson(res, 200, { ok: true });
                return;
            }

            sendJson(res, 404, { error: 'not found' });
        } catch (error) {
            sendJson(res, 503, { error: error instanceof Error ? error.message : String(error) });
        }
    });

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, BIND_HOST, () => {
            server.removeListener('error', reject);
            resolve();
        });
    });

    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : 0;
    const advertise = () => {
        const current = readNotifyBridge();
        if (!current || current.pid === process.pid || !isPidAlive(current.pid)) {
            writeNotifyBridge({ port, pid: process.pid, token });
        }
    };
    advertise();
    const advertiseTimer = setInterval(advertise, 5000);
    advertiseTimer.unref();

    return {
        port,
        dispose() {
            clearInterval(advertiseTimer);
            clearNotifyBridge(process.pid);
            server.close();
        },
    };
}
