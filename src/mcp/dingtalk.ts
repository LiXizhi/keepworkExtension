import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { DingService, DingTransports, keepworkDingModel } from '../core/dingtalk';
import { DingListener, sendDingDraft, queryDingReceipt } from '../core/dingtalkDws';

export const DINGTALK_API = 'dingtalk-drafts-v1';
type Listener = Pick<DingListener, 'start' | 'stop' | 'status'>;
export function dingOriginAllowed(origin: string): boolean {
    try {
        const url = new URL(origin);
        return url.origin === origin && ((url.protocol === 'https:' && ['keepwork.com', 'cdn.keepwork.com'].includes(url.hostname))
            || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)));
    } catch { return false; }
}
export class DingController {
    readonly service: DingService;
    private token: string;
    private listeners: Listener[] = [];
    private operations: Promise<unknown> = Promise.resolve();
    private closed = false;
    private retentionTimer?: NodeJS.Timeout;
    constructor(home: string, transports: DingTransports = { model: keepworkDingModel, send: sendDingDraft, receipt: queryDingReceipt },
        private modelReady = () => !!process.env.KEEPWORK_DINGTALK_MODEL_TOKEN,
        private makeListener = (profile: string, kind: 'all-direct' | 'at-me'): Listener => new DingListener(profile, kind, event => this.service.receive(event), undefined,
            path.join(home, `listener-${createHash('sha256').update(profile).digest('hex')}-${kind}.json`))) {
        fs.mkdirSync(home, { recursive: true, mode: 0o700 });
        const tokenFile = path.join(home, 'pairing-token');
        if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
        this.token = fs.readFileSync(tokenFile, 'utf8').trim();
        if (!/^[a-f0-9]{64}$/.test(this.token)) throw new Error('Invalid DingTalk pairing token');
        this.service = new DingService(path.join(home, 'state.json'), transports);
    }
    private async stopListeners(): Promise<void> {
        const results = await Promise.allSettled(this.listeners.map(listener => listener.stop()));
        if (results.some(result => result.status === 'rejected')) throw new Error('Listener stop unconfirmed; restart blocked');
        this.listeners = [];
    }
    private startListeners(): void {
        if (this.closed || this.listeners.length || !this.service.isActive()) return;
        const config = this.service.configuration();
        if (!config || !this.modelReady()) { this.service.pause(); return; }
        this.listeners = ['all-direct', 'at-me'].map(kind => this.makeListener(config.profile, kind as 'all-direct' | 'at-me'));
        for (const listener of this.listeners) listener.start();
    }
    restore(): void {
        this.service.prune();
        this.startListeners();
        this.retentionTimer = setInterval(() => {
            try { this.service.prune(); } catch { void this.stopListeners().catch(() => undefined); }
        }, 3600000);
        this.retentionTimer.unref();
    }
    status() {
        const state = this.service.status();
        return { ...state, jobs: state.jobs.slice(-100).reverse(), jobCount: state.jobs.length,
            listeners: this.listeners.map(listener => listener.status()), modelReady: this.modelReady(), api: DINGTALK_API };
    }
    async close(): Promise<void> {
        this.closed = true;
        if (this.retentionTimer) clearInterval(this.retentionTimer);
        await this.operations.catch(() => undefined);
        await this.stopListeners();
        await this.service.drain();
    }
    async handle(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<boolean> {
        if (!pathname.startsWith('/dingtalk/')) return false;
        res.setHeader('Cache-Control', 'no-store');
        const respond = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
        if (!dingOriginAllowed(String(req.headers.origin || ''))) { respond(403, { error: 'Explicit allowed Origin required' }); return true; }
        const supplied = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer /, ''));
        const expected = Buffer.from(this.token);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { respond(401, { error: 'DingTalk pairing token required' }); return true; }
        if (this.closed) { respond(503, { error: 'Integration stopping' }); return true; }
        if (req.method === 'GET' && pathname === '/dingtalk/status') { respond(200, this.status()); return true; }
        if (req.method !== 'POST') { respond(405, { error: 'Method not allowed' }); return true; }
        try {
            if (!String(req.headers['content-type']).startsWith('application/json')) throw new Error('JSON required');
            let size = 0;
            const chunks: Buffer[] = [];
            for await (const chunk of req) {
                size += chunk.length;
                if (size > 32000) throw new Error('Request too large');
                chunks.push(Buffer.from(chunk));
            }
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Object required');
            if (pathname === '/dingtalk/pause') this.service.pause();
            const operation = this.operations.then(async () => {
                if (this.closed) throw new Error('Integration stopping');
                switch (pathname) {
                    case '/dingtalk/configure':
                        this.service.pause();
                        await this.stopListeners();
                        this.service.configure(body);
                        break;
                    case '/dingtalk/enable':
                        if (!this.modelReady()) throw new Error('Host model credential missing');
                        if (body.mode !== 'draft') throw new Error('Only draft mode supported; DWS requires concrete send confirmation');
                        if (this.listeners.length) throw new Error('Pause before restarting listeners');
                        this.service.enable(body.consent === true);
                        this.startListeners();
                        break;
                    case '/dingtalk/pause':
                        this.service.pause();
                        await this.stopListeners();
                        break;
                    case '/dingtalk/test': {
                        if (!this.modelReady()) throw new Error('Host model credential missing');
                        const id = randomUUID();
                        await this.service.receive({ event_id: id, message_id: id, conversation_id: 'local-test', sender_open_dingtalk_id: 'local-test',
                            content: body.question, timestamp: Date.now(), kind: 'all-direct' }, true);
                        break;
                    }
                    case '/dingtalk/send': await this.service.send(body.id, body.confirmation); break;
                    case '/dingtalk/reconcile': await this.service.reconcile(body.id); break;
                    default: throw new Error('Unknown integration action');
                }
                return this.status();
            });
            this.operations = operation.catch(() => undefined);
            respond(200, await operation);
        } catch (error) {
            respond(400, { error: error instanceof Error && !/ENOENT|EACCES|JSON/.test(error.message) ? error.message : 'Integration request rejected' });
        }
        return true;
    }
}