import { randomUUID } from 'node:crypto';
import { chromium, Browser, BrowserContext, Page, ElementHandle } from 'playwright-core';
import { resolveBrowser } from './headless';

const IDLE_MS = 15 * 60_000;
const MAX_SESSIONS = 4;
const SECRET = /token|authorization|password|secret|cookie|api.?key/i;
export function browserRedact(text: string): string {
    return String(text).replace(/((?:token|password|secret|api[_-]?key|authorization|cookie)[\s"':=]+)[^\s&"',;}]+/gi, '$1[redacted]').slice(0, 4000);
}
export function browserUrl(value: string): string {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Browser navigation requires an http(s) URL');
    if (url.username || url.password) throw new Error('Credentials in browser URLs are not supported');
    return url.href;
}
function displayUrl(value: string): string {
    try {
        const url = new URL(value);
        url.username = ''; url.password = '';
        for (const key of Array.from(url.searchParams.keys())) if (SECRET.test(key)) url.searchParams.set(key, '[redacted]');
        return browserRedact(url.href);
    } catch { return ''; }
}
type Diagnostic = { cursor: number; kind: string; text: string; time: string };
type Tab = { id: string; page: Page; generation: number; refs: Map<string, ElementHandle>; diagnostics: Diagnostic[]; cursor: number; queue: Promise<unknown> };
type Session = { id: string; owner: string; browser: Browser; context: BrowserContext; tabs: Map<string, Tab>; touched: number; active: number };
export type BrowserArgs = { treeId: string; sessionId?: string; pageId?: string; action?: string; url?: string; visible?: boolean; width?: number; height?: number; selector?: string; ref?: string; value?: string; key?: string; y?: number; deltaY?: number; timeoutMs?: number; limit?: number; cursor?: number; assertion?: string; expected?: string | boolean; state?: string };

export class ManagedBrowserManager {
    private sessions = new Map<string, Session>();
    private launching = 0;
    private revoked = new Set<string>();
    private stopped = false;

    private addPage(session: Session, page: Page): Tab {
        const existing = [...session.tabs.values()].find(tab => tab.page === page);
        if (existing) return existing;
        const tab: Tab = { id: randomUUID(), page, generation: 0, refs: new Map(), diagnostics: [], cursor: 0, queue: Promise.resolve() };
        session.tabs.set(tab.id, tab);
        const log = (kind: string, text: string) => {
            tab.diagnostics.push({ cursor: ++tab.cursor, kind, text: browserRedact(text), time: new Date().toISOString() });
            if (tab.diagnostics.length > 200) tab.diagnostics.shift();
        };
        page.on('console', msg => log(`console:${msg.type()}`, msg.text()));
        page.on('pageerror', error => log('runtime-error', error.message));
        page.on('requestfailed', request => log('resource-error', `${displayUrl(request.url())}: ${request.failure()?.errorText || 'failed'}`));
        page.on('response', response => { if (response.status() >= 400) log('resource-error', `${response.status()} ${displayUrl(response.url())}`); });
        page.on('framenavigated', frame => {
            if (frame !== page.mainFrame()) return;
            this.clearRefs(tab);
            log('navigation', displayUrl(frame.url()));
        });
        page.on('close', () => { this.clearRefs(tab); session.tabs.delete(tab.id); });
        return tab;
    }

    private clearRefs(tab: Tab) {
        tab.generation++;
        for (const handle of tab.refs.values()) void handle.dispose().catch(() => {});
        tab.refs.clear();
    }

    async run(owner: string, name: string, args: BrowserArgs): Promise<any> {
        if (!owner || this.stopped || this.revoked.has(owner.split('\n')[0])) throw new Error('Browser session disconnected');
        if (name === 'browser_session') {
            if (args.action === 'list') return { sessions: await Promise.all([...this.sessions.values()].filter(s => s.owner === owner).map(s => this.describe(s))) };
            if (args.action === 'create') return this.create(owner, args);
            const session = this.getSession(owner, args.sessionId);
            if (args.action === 'close') { await this.close(session); return { closed: true, sessionId: session.id }; }
            throw new Error('Unsupported session action');
        }
        const session = this.getSession(owner, args.sessionId);
        const tab = args.pageId ? session.tabs.get(args.pageId) : session.tabs.size === 1 ? [...session.tabs.values()][0] : undefined;
        if (!tab) throw new Error('Select pageId from browser_session list');
        if (session.active >= 8) throw new Error('Too many pending browser actions');
        const queuedAt = Date.now();
        session.active++;
        const task = tab.queue.catch(() => {}).then(async () => {
            if (Date.now() - queuedAt > 10000) throw new Error('Browser action expired in queue; inspect state before retrying');
            let timer: NodeJS.Timeout | undefined;
            try {
                return await Promise.race([
                    this.execute(session, tab, name, args),
                    new Promise((_, reject) => {
                        timer = setTimeout(() => {
                            // Closing the page interrupts even a blocked page.evaluate.
                            void tab.page.close({ runBeforeUnload: false }).catch(() => {});
                            reject(new Error('Browser action timed out; page closed. Inspect state before retrying'));
                        }, (args.timeoutMs ?? 10000) + 2000);
                    }),
                ]);
            } finally { if (timer) clearTimeout(timer); }
        });
        tab.queue = task;
        try { return await task; } finally { session.active--; session.touched = Date.now(); }
    }

    private getSession(owner: string, id?: string) {
        const session = id ? this.sessions.get(id) : undefined;
        if (!session || session.owner !== owner) throw new Error('Unknown browser session; create/list sessions for this Agent tree');
        session.touched = Date.now();
        return session;
    }

    private async describe(session: Session) {
        return { sessionId: session.id, pages: await Promise.all([...session.tabs.values()].map(async t => ({ pageId: t.id, url: displayUrl(t.page.url()), title: browserRedact(await t.page.title().catch(() => '')) }))) };
    }

    private async create(owner: string, args: BrowserArgs) {
        const url = args.url ? browserUrl(args.url) : undefined;
        if (this.sessions.size + this.launching >= MAX_SESSIONS) throw new Error('Browser session limit reached; close an unused session');
        const executablePath = resolveBrowser();
        if (!executablePath) throw new Error('Install Edge or Chrome, or configure EDGE_PATH/CHROME_PATH, then restart Keepwork');
        this.launching++;
        let browser: Browser | undefined;
        try {
            browser = await chromium.launch({ executablePath, headless: !args.visible, timeout: 15000 });
            const context = await browser.newContext({ viewport: { width: args.width || 1280, height: args.height || 800 }, acceptDownloads: false });
            context.setDefaultTimeout(5000);
            context.setDefaultNavigationTimeout(10000);
            // Never navigate to file:// or browser-internal pages, including redirects/popups.
            await context.route('**/*', route => /^(https?:|data:|blob:)/.test(route.request().url()) ? route.continue() : route.abort());
            const session: Session = { id: randomUUID(), owner, browser, context, tabs: new Map(), touched: Date.now(), active: 1 };
            if (this.stopped || this.revoked.has(owner.split('\n')[0])) throw new Error('Browser session disconnected');
            this.sessions.set(session.id, session);
            browser.on('disconnected', () => this.sessions.delete(session.id));
            context.on('page', page => {
                if (session.tabs.size >= 8) { void page.close(); return; }
                this.addPage(session, page);
            });
            const page = await context.newPage();
            this.addPage(session, page);
            if (url) await page.goto(url, { waitUntil: 'domcontentloaded' });
            session.active = 0;
            return await this.describe(session);
        } catch (error) { await browser?.close().catch(() => {}); throw error; }
        finally { this.launching--; }
    }

    private async target(tab: Tab, args: BrowserArgs) {
        if (args.ref) {
            const handle = tab.refs.get(args.ref);
            if (!handle || !await handle.evaluate(el => el.isConnected).catch(() => false)) throw new Error('Stale ref; take a new snapshot');
            return handle;
        }
        if (!args.selector) throw new Error('selector or ref is required');
        const locator = tab.page.locator(args.selector);
        if (await locator.count() !== 1) throw new Error('Selector must match exactly one element');
        return locator;
    }

    private async execute(session: Session, tab: Tab, name: string, args: BrowserArgs): Promise<any> {
        const page = tab.page;
        const metadata = () => ({ sessionId: session.id, pageId: tab.id, url: displayUrl(page.url()) });
        const timeout = args.timeoutMs ?? 5000;
        if (name === 'browser_snapshot') {
            this.clearRefs(tab);
            const handles = await page.locator('button,a,input,textarea,select,[role],[data-testid],h1,h2,h3').elementHandles();
            const elements = [];
            for (let i = 0; i < handles.length; i++) {
                const handle = handles[i];
                if (i >= (args.limit || 80)) { await handle.dispose(); continue; }
                const ref = `${tab.id}:${tab.generation}:${i}`;
                tab.refs.set(ref, handle);
                const summary = await handle.evaluate(node => { const el = node as Element; return ({ tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', name: el.getAttribute('aria-label') || el.getAttribute('name') || '', text: (el.textContent || '').slice(0, 300), disabled: el.hasAttribute('disabled') }); });
                elements.push({ ref, ...summary, name: browserRedact(summary.name), text: browserRedact(summary.text), visible: await handle.isVisible() });
            }
            return { ...metadata(), title: browserRedact(await page.title()), elements, truncated: handles.length > elements.length };
        }
        if (name === 'browser_diagnostics') {
            const entries = tab.diagnostics.filter(d => d.cursor > (args.cursor || 0)).slice(0, args.limit || 50);
            return { ...metadata(), entries, cursor: entries[entries.length - 1]?.cursor || tab.cursor, dropped: (args.cursor || 0) < (tab.diagnostics[0]?.cursor || 1) - 1 };
        }
        if (name === 'browser_screenshot') {
            const captureId = randomUUID();
            const data = await page.screenshot({ type: 'jpeg', quality: 65, timeout, mask: [page.locator('input[type="password"],input[name*="token" i],input[name*="secret" i]')] });
            if (data.length > 3 * 1024 * 1024) throw new Error('Screenshot exceeds 3 MB limit');
            return { content: [
                { type: 'text', text: JSON.stringify({ ...metadata(), captureId, capturedAt: new Date().toISOString(), viewport: page.viewportSize() }) },
                { type: 'image', data: data.toString('base64'), mimeType: 'image/jpeg' },
            ] };
        }
        if (name !== 'browser_action') throw new Error('Unknown browser tool');
        switch (args.action) {
            case 'navigate': await page.goto(browserUrl(args.url || ''), { waitUntil: 'domcontentloaded', timeout }); break;
            case 'reload': await page.reload({ waitUntil: 'domcontentloaded', timeout }); break;
            case 'viewport':
                if (!args.width || !args.height) throw new Error('width and height required');
                await page.setViewportSize({ width: args.width, height: args.height }); break;
            case 'click': await (await this.target(tab, args)).click({ timeout }); break;
            case 'fill':
                if (args.value === undefined) throw new Error('value required');
                await (await this.target(tab, args)).fill(args.value, { timeout }); break;
            case 'select':
                if (args.value === undefined) throw new Error('value required');
                await (await this.target(tab, args)).selectOption(args.value, { timeout }); break;
            case 'press':
                if (!args.key) throw new Error('key required');
                await (await this.target(tab, args)).press(args.key, { timeout }); break;
            case 'scroll':
                if (args.selector || args.ref) await (await this.target(tab, args)).scrollIntoViewIfNeeded({ timeout });
                else await page.evaluate(({ y, deltaY }) => y === undefined ? window.scrollBy(0, deltaY ?? 400) : window.scrollTo(0, y), { y: args.y, deltaY: args.deltaY });
                break;
            case 'waitFor':
                if (!args.selector) throw new Error('waitFor requires selector');
                await page.locator(args.selector).waitFor({ state: (args.state || 'visible') as 'visible' | 'attached' | 'hidden', timeout }); break;
            case 'assert': {
                if (args.assertion === 'hidden' && args.selector && await page.locator(args.selector).count() === 0) break;
                const el = await this.target(tab, args);
                let passed = false;
                if (args.assertion === 'visible') passed = await el.isVisible();
                else if (args.assertion === 'hidden') passed = !await el.isVisible();
                else if (args.assertion === 'textContains') passed = (await el.textContent() || '').includes(String(args.expected));
                else if (args.assertion === 'value') passed = await el.inputValue() === String(args.expected);
                else if (args.assertion === 'checked') passed = await el.isChecked() === (args.expected !== false);
                else throw new Error('Unknown assertion');
                if (!passed) throw new Error('Browser assertion failed: ' + args.assertion);
                break;
            }
            default: throw new Error('Unknown browser action');
        }
        return { ...metadata(), ok: true, action: args.action };
    }

    private async close(session: Session) {
        this.sessions.delete(session.id);
        await session.browser.close().catch(() => {});
    }
    async closeOwner(mcpSessionId: string) {
        this.revoked.add(mcpSessionId);
        // Bound tombstones; session ids are random and are never reused.
        if (this.revoked.size > 1000) this.revoked.delete(this.revoked.values().next().value!);
        await Promise.all([...this.sessions.values()].filter(s => s.owner.startsWith(mcpSessionId + '\n')).map(s => this.close(s)));
    }
    async prune(now = Date.now()) { await Promise.all([...this.sessions.values()].filter(s => !s.active && now - s.touched > IDLE_MS).map(s => this.close(s))); }
    async closeAll() { this.stopped = true; await Promise.all([...this.sessions.values()].map(s => this.close(s))); }
}

export const managedBrowsers = new ManagedBrowserManager();
