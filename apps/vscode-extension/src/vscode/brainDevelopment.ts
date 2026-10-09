import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';

/** Development-only, loopback source server. No build or generated AIChat files. */
export async function startBrainDevelopmentServer(sourceDirectory: string, firstPort = 3001) {
    const source = fs.realpathSync(sourceDirectory);
    if (!fs.statSync(path.join(source, 'AIChat.html')).isFile()) throw new Error('AIChat source entry is missing');
    const repository = path.resolve(source, '../../../..');
    const root = fs.existsSync(path.join(repository, 'official/apps/tools/AIChat/AIChat.html')) ? repository : source;
    const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.wasm': 'application/wasm' };
    const server = http.createServer((req, res) => {
        try {
            if (!['GET', 'HEAD'].includes(req.method || '')) { res.writeHead(405).end(); return; }
            const relative = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname).replace(/^\/+/, '');
            if (relative.split(/[\\/]/).some(part => part.startsWith('.'))) throw new Error('Hidden path');
            const target = fs.realpathSync(path.resolve(root, relative));
            const confined = path.relative(root, target);
            if (confined.startsWith('..') || path.isAbsolute(confined) || !fs.statSync(target).isFile()) throw new Error('Outside source');
            res.writeHead(200, { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
            if (req.method === 'HEAD') res.end();
            else fs.createReadStream(target).on('error', () => res.destroy()).pipe(res);
        } catch { res.writeHead(404).end('Not found'); }
    });
    for (let port = firstPort; port < firstPort + 100; port++) {
        try {
            await new Promise<void>((resolve, reject) => {
                const ready = () => { server.removeListener('error', fail); resolve(); };
                const fail = (error: Error) => { server.removeListener('listening', ready); reject(error); };
                server.once('error', fail); server.once('listening', ready); server.listen(port, '127.0.0.1');
            });
            const address = server.address() as { port: number };
            const entry = path.relative(root, path.join(source, 'AIChat.html')).split(path.sep).map(encodeURIComponent).join('/');
            return { url: new URL(`http://127.0.0.1:${address.port}/${entry}`), dispose() { server.close(); server.closeAllConnections(); } };
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error; }
    }
    throw new Error('No free AIChat development port');
}

export async function selectBrainEntry(options: {
    override: string; development: boolean; hosted: URL;
    validate: (url: string) => URL;
    local: () => Promise<URL>;
    probe?: (url: URL) => Promise<boolean>;
}): Promise<URL> {
    // Validate outside the fallback: invalid or credential-bearing overrides are errors.
    const override = options.override ? options.validate(options.override) : undefined;
    try {
        if (override) {
            const probe = options.probe || (async url => (await fetch(url, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(1500) })).ok);
            return await probe(override) ? override : options.hosted;
        }
        if (options.development) return await options.local();
    } catch { /* Missing local checkout or unavailable loopback entry: use hosted AIChat. */ }
    return options.hosted;
}
