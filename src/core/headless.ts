import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const HEADLESS_TIMEOUT_MS = 15_000;
const VIRTUAL_TIME_MS = 8_000;
const MAX_DUMP_BYTES = 2 * 1024 * 1024;

let cachedBrowser: string | null | undefined;

function winCandidates(): string[] {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || '';
    return [
        path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
}

function macCandidates(): string[] {
    return [
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
}

function linuxCandidates(): string[] {
    return [
        '/usr/bin/microsoft-edge',
        '/usr/bin/microsoft-edge-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        'microsoft-edge',
        'google-chrome',
        'chromium',
    ];
}

function envCandidates(): string[] {
    return [process.env.EDGE_PATH, process.env.CHROME_PATH].filter((s): s is string => !!s && !!s.trim());
}

export function resolveBrowser(): string | null {
    if (cachedBrowser !== undefined) return cachedBrowser;
    const list = [
        ...envCandidates(),
        ...(process.platform === 'win32' ? winCandidates() : process.platform === 'darwin' ? macCandidates() : linuxCandidates()),
    ];
    for (const cand of list) {
        if (cand.includes('/') || cand.includes('\\')) {
            try {
                if (fs.existsSync(cand)) {
                    cachedBrowser = cand;
                    return cand;
                }
            } catch { /* ignore */ }
        }
    }
    cachedBrowser = null;
    return null;
}

function spawnDump(browser: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(browser, args, {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const chunks: Buffer[] = [];
        let size = 0;
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            try { child.kill(); } catch { /* ignore */ }
        }, HEADLESS_TIMEOUT_MS);
        child.stdout?.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_DUMP_BYTES) {
                try { child.kill(); } catch { /* ignore */ }
                return;
            }
            chunks.push(chunk);
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
        child.on('close', () => {
            clearTimeout(timer);
            if (timedOut) {
                reject(new Error('timeout'));
                return;
            }
            resolve(Buffer.concat(chunks).toString('utf8'));
        });
    });
}

function extractHtml(dump: string): string {
    const raw = String(dump || '');
    const start = raw.search(/<!doctype|<html/i);
    const html = start >= 0 ? raw.slice(start) : raw;
    return html.trim();
}

/** Render URL in system Edge/Chrome and return the JS-evaluated DOM, or null. */
export async function dumpDom(url: string): Promise<string | null> {
    const href = String(url || '').trim();
    if (!/^https?:\/\//i.test(href)) return null;
    const browser = resolveBrowser();
    if (!browser) return null;
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-headless-'));
    const args = [
        '--headless=new',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--no-first-run',
        '--no-default-browser-check',
        '--hide-scrollbars',
        `--user-data-dir=${userData}`,
        `--virtual-time-budget=${VIRTUAL_TIME_MS}`,
        '--dump-dom',
        href,
    ];
    try {
        const dump = await spawnDump(browser, args);
        const html = extractHtml(dump);
        if (html.length < 200 || !/<html|<body|<div/i.test(html)) return null;
        return html;
    } catch {
        return null;
    } finally {
        try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}
