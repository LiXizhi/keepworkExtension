import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type BundledBrowserStatus = 'not-installed' | 'downloading' | 'installed' | 'failed';

const INSTALL_TIMEOUT_MS = 15 * 60_000;
const MAX_OUTPUT_CHARS = 4000;

export function browserCacheRoot(): string {
    return process.env.KEEPWORK_BROWSER_CACHE || path.join(os.homedir(), '.keepwork-mcp', 'browsers');
}

function executableRelatives(headless: boolean): string[] {
    const shell = process.platform === 'win32' ? path.join('chrome-win', 'headless_shell.exe')
        : process.platform === 'darwin' ? path.join('chrome-mac', 'headless_shell')
        : path.join('chrome-linux', 'headless_shell');
    const full = process.platform === 'win32' ? path.join('chrome-win', 'chrome.exe')
        : process.platform === 'darwin' ? path.join('chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium')
        : path.join('chrome-linux', 'chrome');
    return headless ? [shell, full] : [full, shell];
}

/** Newest downloaded Chromium executable under the cache root, preferring the requested mode. */
export function bundledBrowserExecutable(headless: boolean, root: string = browserCacheRoot()): string | null {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
    const revisions = entries
        .filter(entry => entry.isDirectory() && /^chromium(_headless_shell)?-\d+$/.test(entry.name))
        .map(entry => entry.name)
        .sort()
        .reverse();
    for (const relative of executableRelatives(headless)) {
        for (const revision of revisions) {
            const candidate = path.join(root, revision, relative);
            if (fs.existsSync(candidate)) return candidate;
        }
    }
    return null;
}

export function playwrightCli(): string | null {
    try {
        const entry = require.resolve('playwright-core');
        const cli = path.join(path.dirname(entry), 'cli.js');
        return fs.existsSync(cli) ? cli : null;
    } catch { return null; }
}

export function runInstaller(cli: string, root: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [cli, 'install', 'chromium'], {
            env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: root },
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        const capture = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-MAX_OUTPUT_CHARS); };
        child.stdout?.on('data', capture);
        child.stderr?.on('data', capture);
        const timer = setTimeout(() => {
            try { child.kill(); } catch { /* ignore */ }
            reject(new Error('Chromium download timed out'));
        }, INSTALL_TIMEOUT_MS);
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('close', code => {
            clearTimeout(timer);
            if (code === 0) resolve();
            else reject(new Error(`Chromium download failed (exit ${code}): ${output.trim().slice(-500)}`));
        });
    });
}

let inflight: Promise<void> | null = null;
let lastFailure: string | null = null;

export function bundledBrowserStatus(root: string = browserCacheRoot()): BundledBrowserStatus {
    if (inflight) return 'downloading';
    if (bundledBrowserExecutable(true, root)) return 'installed';
    return lastFailure ? 'failed' : 'not-installed';
}

/** Single-flight download of the bundled Chromium into the shared cache. */
export function ensureBundledBrowser(run?: () => Promise<void>): Promise<void> {
    if (bundledBrowserExecutable(true)) return Promise.resolve();
    if (inflight) return inflight;
    if (!run) {
        const cli = playwrightCli();
        if (!cli) {
            lastFailure = 'Bundled browser installer is unavailable in this runtime';
            return Promise.reject(new Error(lastFailure));
        }
        try { fs.mkdirSync(browserCacheRoot(), { recursive: true }); } catch { /* the installer reports the failure */ }
        run = () => runInstaller(cli, browserCacheRoot());
    }
    const runner = run;
    inflight = (async () => {
        await Promise.resolve();
        await runner();
        if (!bundledBrowserExecutable(true)) throw new Error('Chromium download finished without a usable executable');
        lastFailure = null;
    })()
        .catch((error: unknown) => {
            lastFailure = error instanceof Error ? error.message : String(error);
            throw error;
        })
        .finally(() => { inflight = null; });
    return inflight;
}
