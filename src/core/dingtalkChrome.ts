import * as fs from 'node:fs';
import * as path from 'node:path';
import { DingEvent } from './dingtalk';
import { AichatClient, sanitizeClientUrl } from './aichatPresence';
import { resolveBrowser } from './headless';

export const MAX_DING_TABS = 8;
export const DING_CHROME_PROFILE = 'dingtalk-chrome';

export const VISIBLE_CHROME_ARGS = [
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,ThrottleForegroundTimers,MemorySaverMode,TabDiscarding',
];

export function chromeLaunchArgs(): string[] {
    return [...VISIBLE_CHROME_ARGS];
}

export function resolveChromeExecutable(): string | null {
    const preferred = [process.env.CHROME_PATH, ...chromeCandidates()].filter((value): value is string => !!value && !!value.trim());
    for (const candidate of preferred) {
        try { if (fs.existsSync(candidate)) return candidate; } catch { /* ignore */ }
    }
    return resolveBrowser();
}

function chromeCandidates(): string[] {
    if (process.platform === 'win32') {
        const pf = process.env.ProgramFiles || 'C:\\Program Files';
        const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
        const local = process.env.LOCALAPPDATA || '';
        return [
            path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ];
    }
    if (process.platform === 'darwin') return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
    return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
}

/** Memory Saver off (Chromium high-efficiency state 2 = disabled) before the first launch. */
export function writeChromeProfilePrefs(profileDir: string): void {
    const dir = path.join(profileDir, 'Default');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, 'Preferences');
    let prefs: { performance_tuning?: { high_efficiency_mode?: { state?: number } } } = {};
    try { prefs = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { prefs = {}; }
    prefs.performance_tuning = { ...(prefs.performance_tuning || {}), high_efficiency_mode: { state: 2 } };
    fs.writeFileSync(file, JSON.stringify(prefs), { mode: 0o600 });
}

export interface DingTurnResult { ok: boolean; reply?: string; error?: string; convId?: string }
export interface DingWorkerPage {
    addInitScript(source: string): Promise<void>;
    goto(url: string): Promise<void>;
    evaluate(message: DingTurnMessage): Promise<DingTurnResult>;
    waitUntilReady(timeoutMs: number): Promise<void>;
}
export interface DingWorkerBrowser {
    newPage(): Promise<DingWorkerPage>;
    close(): Promise<void>;
}
export interface DingTurnMessage { key: string; kind: DingEvent['kind']; text: string; sender: string }
interface Tab { key: string; page: DingWorkerPage; booted: boolean }

export class DingChromePool {
    private browser?: DingWorkerBrowser;
    private tabs = new Map<string, Tab>();
    private opening = 0;
    private waiters: Array<() => void> = [];
    private closed = false;
    constructor(private launch: (profileDir: string) => Promise<DingWorkerBrowser>, private profileDir: string, private maxTabs = MAX_DING_TABS) {}

    private wake(): void {
        const next = this.waiters.shift();
        if (next) next();
    }

    private async acquire(key: string): Promise<void> {
        while (!this.closed && !this.tabs.has(key) && this.tabs.size + this.opening >= this.maxTabs) {
            await new Promise<void>(resolve => this.waiters.push(resolve));
        }
        if (this.closed) throw new Error('Chrome window is closing');
    }

    private async pageFor(key: string, client: AichatClient): Promise<Tab> {
        const existing = this.tabs.get(key);
        if (existing) return existing;
        await this.acquire(key);
        const raced = this.tabs.get(key);
        if (raced) return raced;
        this.opening++;
        try {
            if (!this.browser) this.browser = await this.launch(this.profileDir);
            const page = await this.browser.newPage();
            const tab: Tab = { key, page, booted: false };
            this.tabs.set(key, tab);
            await this.boot(tab, client);
            return tab;
        } catch (error) {
            this.tabs.delete(key);
            throw error;
        } finally {
            this.opening--;
            this.wake();
        }
    }

    private async boot(tab: Tab, client: AichatClient): Promise<void> {
        const boot = { token: client.token, baseURL: client.baseURL || '', worker: true };
        await tab.page.addInitScript(`window.__AICHAT_DING_BOOT__ = ${JSON.stringify(boot)};`);
        await tab.page.goto(sanitizeClientUrl(client.url));
        await tab.page.waitUntilReady(120000);
        tab.booted = true;
    }

    async turn(event: DingEvent, client: AichatClient, key: string): Promise<string> {
        const tab = await this.pageFor(key, client);
        if (!tab.booted) await this.boot(tab, client);
        const result = await tab.page.evaluate({
            key, kind: event.kind, text: event.content, sender: event.sender_open_dingtalk_id,
        });
        if (!result || result.ok !== true || typeof result.reply !== 'string' || !result.reply.trim()) {
            throw new Error(result?.error || 'Chrome tab did not answer');
        }
        return result.reply;
    }

    async close(): Promise<void> {
        this.closed = true;
        this.wake();
        const browser = this.browser;
        this.browser = undefined;
        this.tabs.clear();
        await browser?.close().catch(() => undefined);
    }
}

declare global {
    interface Window {
        __AICHAT_DING_BOOT__?: { token?: string; baseURL?: string; worker?: boolean };
        __AICHAT_DING_READY__?: boolean;
        __aichatDingTurn?: (message: DingTurnMessage) => Promise<DingTurnResult>;
    }
}

export async function launchVisibleChrome(profileDir: string): Promise<DingWorkerBrowser> {
    const executablePath = resolveChromeExecutable();
    if (!executablePath) throw new Error('Install Google Chrome, or set CHROME_PATH, then restart Keepwork');
    const args = chromeLaunchArgs();
    if (args.some(arg => /headless/i.test(arg))) throw new Error('DingTalk Chrome must stay visible');
    writeChromeProfilePrefs(profileDir);
    const { chromium } = await import('playwright-core');
    const context = await chromium.launchPersistentContext(profileDir, {
        executablePath, headless: false, args, viewport: { width: 1280, height: 900 },
    });
    return {
        async newPage() {
            const page = await context.newPage();
            return {
                addInitScript: source => page.addInitScript(source),
                goto: url => page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).then(() => undefined),
                evaluate: message => page.evaluate(payload => {
                    const turn = window.__aichatDingTurn;
                    if (!turn) throw new Error('DingTalk worker is not ready');
                    return turn(payload);
                }, message),
                waitUntilReady: timeoutMs => page.waitForFunction(() => window.__AICHAT_DING_READY__ === true, null, { timeout: timeoutMs }).then(() => undefined),
            };
        },
        close: () => context.close(),
    };
}
