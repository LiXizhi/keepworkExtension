import { execFileSync } from 'node:child_process';

// GUI-launched Node processes do not inherit Windows Internet Settings. Respect
// explicit CLI proxy settings; otherwise reuse the user's enabled static proxy.
export function cliProxyEnvironment(env: NodeJS.ProcessEnv = process.env, platform = process.platform,
    readSettings = () => execFileSync('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
        { encoding: 'utf8', windowsHide: true, timeout: 1500, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'ignore'] })): NodeJS.ProcessEnv {
    const result = { ...env };
    if (platform !== 'win32' || Object.keys(env).some(key => /^(https?|all)_proxy$/i.test(key))) return result;
    let settings: string;
    try { settings = readSettings(); } catch { return result; }
    if (!/^\s*ProxyEnable\s+REG_DWORD\s+0x1\s*$/mi.test(settings)) return result;
    const server = /^\s*ProxyServer\s+REG_SZ\s+(.+)$/mi.exec(settings)?.[1].trim();
    if (!server) return result;
    const entries = server.split(';').map(part => part.trim());
    for (const scheme of ['http', 'https']) {
        const endpoint = server.includes('=') ? entries.find(part => part.toLowerCase().startsWith(scheme + '='))?.slice(scheme.length + 1) : server;
        if (!endpoint) continue;
        try {
            const url = new URL(endpoint.includes('://') ? endpoint : 'http://' + endpoint);
            if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash) continue;
            result[scheme.toUpperCase() + '_PROXY'] = url.origin;
        } catch { /* Unsupported system proxy format; keep the original environment. */ }
    }
    if ((result.HTTP_PROXY || result.HTTPS_PROXY) && !Object.keys(env).some(key => /^no_proxy$/i.test(key))) {
        const bypass = /^\s*ProxyOverride\s+REG_SZ\s+(.+)$/mi.exec(settings)?.[1] || '';
        result.NO_PROXY = ['localhost', '127.0.0.1', '::1', ...bypass.split(';').map(x => x.trim()).filter(x => x && x !== '<local>')].join(',');
    }
    return result;
}
