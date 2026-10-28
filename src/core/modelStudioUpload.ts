import * as http from 'node:http';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const MODEL_STUDIO_UPLOAD_API = 'temporary-upload-v1';
export const MODEL_STUDIO_UPLOAD_PATH = '/model-studio/temporary-files/request';

/** Deliberately excludes inference, arbitrary URLs, redirects and caller-supplied headers. */
export function allowedModelStudioTarget(url: URL, method: string): boolean {
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false;
    if (method === 'GET') return ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com'].includes(url.hostname)
        && url.pathname === '/api/v1/uploads' && url.searchParams.get('action') === 'getPolicy'
        && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(url.searchParams.get('model') || '')
        && [...url.searchParams.keys()].length === 2
        && [...url.searchParams.keys()].every(key => ['action', 'model'].includes(key));
    return method === 'POST' && /^[a-z0-9-]+\.oss-(?:cn-beijing|ap-southeast-1)\.aliyuncs\.com$/.test(url.hostname)
        && url.pathname === '/' && !url.search;
}

/** Called only after the shared HTTP daemon's Origin and optional auth checks. */
export async function handleModelStudioUpload(req: http.IncomingMessage, res: http.ServerResponse, url: URL,
    fetcher: typeof fetch = fetch): Promise<void> {
    const fail = (status: number, message: string) => {
        if (res.headersSent) { res.destroy(); return; }
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: message }));
    };
    if (url.pathname !== MODEL_STUDIO_UPLOAD_PATH) { fail(404, 'Unknown Model Studio upload route'); return; }
    let target: URL;
    try { target = new URL(url.searchParams.get('url') || ''); } catch { fail(400, 'Upload target required'); return; }
    if (!allowedModelStudioTarget(target, req.method || '')) { fail(403, 'Upload target rejected'); return; }
    const upload = req.method === 'POST';
    const headers: Record<string, string> = {};
    if (upload) {
        const contentType = String(req.headers['content-type'] || '');
        if (!/^multipart\/form-data;\s*boundary=/.test(contentType)) { fail(400, 'Multipart upload required'); return; }
        headers['Content-Type'] = contentType;
    } else {
        const key = String(req.headers['x-dashscope-api-key'] || '');
        if (!key || key.length > 8192 || /\s/.test(key)) { fail(400, 'X-DashScope-Api-Key required'); return; }
        headers.Authorization = `Bearer ${key}`;
    }
    const maxBytes = upload ? 960_000_000 : 0;
    const length = req.headers['content-length'];
    if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) { fail(413, 'Upload too large'); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20 * 60_000);
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', disconnected); res.once('close', disconnected);
    let bytes = 0, tooLarge = false;
    const limited = new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > maxBytes) { tooLarge = true; callback(new Error('Upload too large')); }
        else callback(null, chunk);
    } });
    limited.on('error', () => controller.abort());
    try {
        const body = upload ? req.pipe(limited) : undefined;
        const response = await fetcher(target, {
            method: req.method, headers, ...(body ? { body: body as unknown as BodyInit, duplex: 'half' } : {}),
            signal: controller.signal, redirect: 'error',
        });
        // Never relay cookies, redirects, provider credentials or arbitrary upstream headers.
        res.writeHead(response.status, {
            'Content-Type': response.headers.get('content-type') || 'application/json',
            'Cache-Control': 'no-store',
            ...(response.headers.get('retry-after') ? { 'Retry-After': response.headers.get('retry-after')! } : {}),
        });
        if (response.body) await pipeline(Readable.fromWeb(response.body as never), res);
        else res.end();
    } catch {
        fail(tooLarge ? 413 : controller.signal.aborted ? 504 : 502,
            tooLarge ? 'Upload too large' : 'Model Studio upload request failed');
    } finally {
        clearTimeout(timer); req.removeListener('aborted', disconnected); res.removeListener('close', disconnected);
        req.unpipe(limited); limited.destroy();
    }
}
