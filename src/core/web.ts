import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const FETCH_TIMEOUT_MS = 15_000;
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const DEFAULT_SEARCH_COUNT = 8;
const MAX_SEARCH_COUNT = 12;
const SNIPPET_CAP = 160;
const DEFAULT_TEXT_CHARS = 8000;
const MAX_TEXT_CHARS = 16_000;

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const ACCEPT_LANG = 'zh-CN,zh;q=0.9,en;q=0.8';

export interface SearchHit {
    title: string;
    url: string;
    snippet: string;
}

export interface WebSearchOk {
    engine: 'bing' | 'ddg' | 'baidu';
    query: string;
    results: SearchHit[];
}

export interface FetchPageOk {
    url: string;
    finalUrl: string;
    title: string;
    text: string;
    truncated: boolean;
}

export interface JsonError {
    error: string;
    detail?: string;
}

const SKIP_HOST_RE = /\.(local|internal|localhost)$/i;
const SKIP_HOSTS = new Set([
    'localhost',
    '0.0.0.0',
    '::1',
    'metadata.google.internal',
    'metadata.google.com',
    'kubernetes.default.svc',
]);

const SKIP_URL_RE = /(?:bing\.com\/aclk|duckduckgo\.com\/y\.js|baidu\.com\/baidu\.php|googleadservices\.com)/i;

export class WebBlockedError extends Error {
    readonly code: string;
    readonly detail: string;
    constructor(detail: string, code = 'blocked') {
        super(detail);
        this.name = 'WebBlockedError';
        this.code = code;
        this.detail = detail;
    }
}

function jsonError(error: string, detail?: string): JsonError {
    return detail ? { error, detail } : { error };
}

function clampCount(n?: number): number {
    if (!Number.isFinite(n) || n === undefined) return DEFAULT_SEARCH_COUNT;
    return Math.min(MAX_SEARCH_COUNT, Math.max(1, Math.floor(n)));
}

function clampTextChars(n?: number): number {
    if (!Number.isFinite(n) || n === undefined) return DEFAULT_TEXT_CHARS;
    return Math.min(MAX_TEXT_CHARS, Math.max(200, Math.floor(n)));
}

function hasCjk(s: string): boolean {
    return /[\u3000-\u9fff]/.test(s);
}

function ipv4ToInt(ip: string): number | null {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    let n = 0;
    for (const p of parts) {
        if (!/^\d{1,3}$/.test(p)) return null;
        const v = Number(p);
        if (v < 0 || v > 255) return null;
        n = (n << 8) + v;
    }
    return n >>> 0;
}

function isPrivateV4(ip: string): boolean {
    const n = ipv4ToInt(ip);
    if (n === null) return true;
    if ((n >>> 24) === 0) return true;
    if ((n >>> 24) === 10) return true;
    if ((n >>> 24) === 127) return true;
    if ((n >>> 16) === ((169 << 8) | 254)) return true;
    if ((n >>> 20) === ((172 << 4) | 1)) return true;
    if ((n >>> 16) === ((192 << 8) | 168)) return true;
    if ((n >>> 22) === ((100 << 2) | 1)) return true;
    if ((n >>> 24) >= 224) return true;
    return false;
}

function isPrivateV6(ip: string): boolean {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped) return isPrivateV4(mapped[1]);
    const hex = lower.replace(/^\[|\]$/g, '');
    if (hex.startsWith('fc') || hex.startsWith('fd')) return true;
    if (/^fe[89ab]/i.test(hex)) return true;
    return false;
}

function isPrivateAddress(ip: string): boolean {
    const ver = isIP(ip);
    if (ver === 4) return isPrivateV4(ip);
    if (ver === 6) return isPrivateV6(ip);
    return true;
}

export async function assertPublicUrl(raw: string): Promise<URL> {
    let u: URL;
    try {
        u = new URL(String(raw || '').trim());
    } catch {
        throw new WebBlockedError('invalid-url', 'invalid');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new WebBlockedError(u.protocol.replace(':', ''), 'blocked');
    }
    if (u.username || u.password) throw new WebBlockedError('credentials', 'blocked');
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!host || SKIP_HOSTS.has(host) || SKIP_HOST_RE.test(host)) {
        throw new WebBlockedError('private-host', 'blocked');
    }
    if (isIP(host)) {
        if (isPrivateAddress(host)) throw new WebBlockedError('private-ip', 'blocked');
        return u;
    }
    let records: Array<{ address: string }>;
    try {
        records = await lookup(host, { all: true });
    } catch {
        throw new WebBlockedError('dns', 'blocked');
    }
    if (!records.length) throw new WebBlockedError('dns', 'blocked');
    for (const rec of records) {
        if (isPrivateAddress(rec.address)) throw new WebBlockedError('private-ip', 'blocked');
    }
    return u;
}

function decodeEntities(s: string): string {
    return String(s || '')
        .replace(/&nbsp;|&ensp;|&emsp;|&thinsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
            const n = parseInt(h, 16);
            return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
        })
        .replace(/&#(\d+);/g, (_, d) => {
            const n = Number(d);
            return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
        });
}

function stripTags(html: string): string {
    return String(html || '').replace(/<[^>]+>/g, ' ');
}

function collapseWs(s: string): string {
    return String(s || '').replace(/\s+/g, ' ').trim();
}

function extractTitle(html: string): string {
    const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return m ? collapseWs(decodeEntities(stripTags(m[1]))) : '';
}

function htmlToText(html: string): string {
    const cleaned = String(html || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
        .replace(/<(nav|footer|header|aside|form)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ');
    return collapseWs(decodeEntities(stripTags(cleaned)));
}

function decodeBody(buf: Buffer, contentType: string): string {
    const head = buf.subarray(0, 4096).toString('latin1');
    let charset = '';
    const ct = String(contentType || '').match(/charset\s*=\s*["']?([^\s"';]+)/i);
    if (ct) charset = ct[1].toLowerCase();
    if (!charset) {
        const meta = head.match(/<meta[^>]+charset\s*=\s*["']?([^\s"';>]+)/i)
            || head.match(/<meta[^>]+content=["'][^"']*charset=([^\s"';]+)/i);
        if (meta) charset = meta[1].toLowerCase();
    }
    if (!charset) charset = 'utf-8';
    if (charset === 'gb2312' || charset === 'gbk' || charset === 'gb-2312') charset = 'gbk';
    try {
        return new TextDecoder(charset).decode(buf);
    } catch {
        return new TextDecoder('utf-8').decode(buf);
    }
}

function contentKind(contentType: string, body: string): 'html' | 'text' | 'json' | 'reject' {
    const ct = String(contentType || '').split(';')[0].trim().toLowerCase();
    if (!ct) {
        if (/^\s*</.test(body)) return 'html';
        return 'text';
    }
    if (ct === 'text/html' || ct === 'application/xhtml+xml') return 'html';
    if (ct === 'application/json' || ct.endsWith('+json')) return 'json';
    if (ct.startsWith('text/') || ct === 'application/xml' || ct === 'application/javascript') return 'text';
    return 'reject';
}

function normalizeHitUrl(raw: string, base: string): string {
    try {
        const u = new URL(decodeEntities(raw), base);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
        u.hash = '';
        return u.href;
    } catch {
        return '';
    }
}

function unwrapDdg(href: string): string {
    try {
        const u = new URL(href, 'https://html.duckduckgo.com/');
        const uddg = u.searchParams.get('uddg');
        return uddg || u.href;
    } catch {
        return href;
    }
}

function pushHit(out: SearchHit[], seen: Set<string>, title: string, url: string, snippet: string) {
    if (!title || !url || SKIP_URL_RE.test(url)) return;
    const key = url.replace(/\/+$/, '');
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
        title: title.slice(0, 200),
        url,
        snippet: snippet.slice(0, SNIPPET_CAP),
    });
}

export function parseBingHtml(html: string, base = 'https://www.bing.com/'): SearchHit[] {
    const out: SearchHit[] = [];
    const seen = new Set<string>();
    const chunks = String(html || '').split(/<li[^>]*class="[^"]*\bb_algo\b[^"]*"/i);
    for (let i = 1; i < chunks.length && out.length < MAX_SEARCH_COUNT + 4; i++) {
        const block = chunks[i].slice(0, 6000);
        const a = block.match(/<h2[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
            || block.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
        if (!a) continue;
        const url = normalizeHitUrl(a[1], base);
        const title = collapseWs(decodeEntities(stripTags(a[2])));
        const sn = block.match(/<(?:p|div)[^>]*(?:b_lineclamp|b_caption|b_algoSlug)[^>]*>([\s\S]*?)<\/(?:p|div)>/i)
            || block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
        const snippet = sn ? collapseWs(decodeEntities(stripTags(sn[1]))) : '';
        pushHit(out, seen, title, url, snippet);
    }
    return out;
}

export function parseDdgHtml(html: string): SearchHit[] {
    const out: SearchHit[] = [];
    const seen = new Set<string>();
    const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m: RegExpExecArray | null;
    const src = String(html || '');
    while ((m = re.exec(src)) && out.length < MAX_SEARCH_COUNT + 4) {
        const url = normalizeHitUrl(unwrapDdg(decodeEntities(m[1])), 'https://duckduckgo.com/');
        const title = collapseWs(decodeEntities(stripTags(m[2])));
        const after = src.slice(m.index, m.index + 1800);
        const sn = after.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|span|td|div)/i);
        const snippet = sn ? collapseWs(decodeEntities(stripTags(sn[1]))) : '';
        pushHit(out, seen, title, url, snippet);
    }
    return out;
}

export function parseBaiduHtml(html: string): SearchHit[] {
    const out: SearchHit[] = [];
    const seen = new Set<string>();
    const re = /<h3[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m: RegExpExecArray | null;
    const src = String(html || '');
    while ((m = re.exec(src)) && out.length < MAX_SEARCH_COUNT + 4) {
        const url = normalizeHitUrl(decodeEntities(m[1]), 'https://www.baidu.com/');
        if (!url || /baidu\.com\/(?:s\?|index)/i.test(url)) continue;
        const title = collapseWs(decodeEntities(stripTags(m[2])));
        const after = src.slice(m.index, m.index + 2000);
        const sn = after.match(/class="[^"]*(?:c-abstract|content-right_8Zs40)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span)/i);
        const snippet = sn ? collapseWs(decodeEntities(stripTags(sn[1]))) : '';
        pushHit(out, seen, title, url, snippet);
    }
    return out;
}

interface FetchedDoc {
    finalUrl: string;
    contentType: string;
    body: string;
    status: number;
}

async function readLimitedBody(res: Response): Promise<Buffer> {
    const len = Number(res.headers.get('content-length') || '');
    if (Number.isFinite(len) && len > MAX_DOWNLOAD_BYTES) {
        throw new WebBlockedError('too-large', 'invalid');
    }
    if (!res.body) {
        const ab = await res.arrayBuffer();
        const buf = Buffer.from(ab);
        if (buf.length > MAX_DOWNLOAD_BYTES) throw new WebBlockedError('too-large', 'invalid');
        return buf;
    }
    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        size += chunk.length;
        if (size > MAX_DOWNLOAD_BYTES) {
            try { await reader.cancel(); } catch { /* ignore */ }
            throw new WebBlockedError('too-large', 'invalid');
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

async function fetchPublicDoc(startUrl: string, extraHeaders?: Record<string, string>): Promise<FetchedDoc> {
    let current = String(startUrl || '').trim();
    let lastType = '';
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const parsed = await assertPublicUrl(current);
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
        let res: Response;
        try {
            res = await fetch(parsed.href, {
                method: 'GET',
                redirect: 'manual',
                signal: ac.signal,
                headers: {
                    'User-Agent': USER_AGENT,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
                    'Accept-Language': ACCEPT_LANG,
                    ...extraHeaders,
                },
            });
        } catch (err) {
            if (String((err as Error)?.name || '') === 'AbortError') {
                throw new WebBlockedError('timeout', 'timeout');
            }
            throw new WebBlockedError(String((err as Error)?.message || err).slice(0, 80), 'network');
        } finally {
            clearTimeout(timer);
        }
        lastType = String(res.headers.get('content-type') || '');
        if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get('location');
            if (!loc) throw new WebBlockedError(`http-${res.status}`, 'network');
            current = new URL(loc, parsed.href).href;
            continue;
        }
        if (!res.ok) throw new WebBlockedError(`http-${res.status}`, 'network');
        const buf = await readLimitedBody(res);
        return {
            finalUrl: parsed.href,
            contentType: lastType,
            body: decodeBody(buf, lastType),
            status: res.status,
        };
    }
    throw new WebBlockedError('too-many-redirects', 'network');
}

function caughtToError(err: unknown): JsonError {
    if (err instanceof WebBlockedError) return jsonError(err.code, err.detail);
    return jsonError('network', String((err as Error)?.message || err).slice(0, 80));
}

/** Tokens that should appear in a relevant SERP (ignore single CJK chars like 帕). */
export function distinctiveTokens(query: string): string[] {
    const q = String(query || '');
    const tokens = [
        ...(q.match(/[A-Za-z][A-Za-z0-9]{2,}/g) || []).map((s) => s.toLowerCase()),
        ...(q.match(/[\u4e00-\u9fff]{2,}/g) || []),
    ];
    return [...new Set(tokens)];
}

export function resultsRelevant(query: string, results: SearchHit[]): boolean {
    if (!results.length) return false;
    const tokens = distinctiveTokens(query);
    if (!tokens.length) return true;
    const blob = results.map((r) => `${r.title}\n${r.url}\n${r.snippet}`).join('\n').toLowerCase();
    return tokens.some((t) => blob.includes(t.toLowerCase()));
}

function bingSearchUrl(query: string): { url: string; headers: Record<string, string>; base: string } {
    const encoded = encodeURIComponent(query);
    if (hasCjk(query)) {
        return {
            url: `https://cn.bing.com/search?q=${encoded}&ensearch=0&setmkt=zh-CN&setlang=zh-Hans&cc=CN`,
            base: 'https://cn.bing.com/',
            headers: {
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                Referer: 'https://cn.bing.com/',
                Cookie: '_EDGE_S=ui=zh-cn&mkt=zh-cn; SRCHHPGUSR=SRCHLANG=zh-Hans',
            },
        };
    }
    return {
        url: `https://www.bing.com/search?q=${encoded}`,
        base: 'https://www.bing.com/',
        headers: {},
    };
}

export async function webSearch(query: string, count?: number): Promise<WebSearchOk | JsonError> {
    const q = String(query || '').trim();
    if (!q) return jsonError('invalid', 'query-required');
    const limit = clampCount(count);
    const encoded = encodeURIComponent(q);
    const bing = bingSearchUrl(q);
    const cjk = hasCjk(q);
    const attempts: Array<{
        engine: WebSearchOk['engine'];
        url: string;
        parse: (html: string) => SearchHit[];
        headers?: Record<string, string>;
    }> = [
        { engine: 'bing', url: bing.url, parse: (html) => parseBingHtml(html, bing.base), headers: bing.headers },
    ];
    if (cjk) {
        attempts.push({ engine: 'baidu', url: `https://www.baidu.com/s?wd=${encoded}`, parse: parseBaiduHtml });
        attempts.push({ engine: 'ddg', url: `https://html.duckduckgo.com/html/?q=${encoded}`, parse: parseDdgHtml });
    } else {
        attempts.push({ engine: 'ddg', url: `https://html.duckduckgo.com/html/?q=${encoded}`, parse: parseDdgHtml });
        attempts.push({ engine: 'baidu', url: `https://www.baidu.com/s?wd=${encoded}`, parse: parseBaiduHtml });
    }
    const failures: string[] = [];
    for (const attempt of attempts) {
        try {
            const doc = await fetchPublicDoc(attempt.url, attempt.headers);
            const results = attempt.parse(doc.body).slice(0, limit);
            if (!results.length) {
                failures.push(`${attempt.engine}:empty`);
                continue;
            }
            if (!resultsRelevant(q, results)) {
                failures.push(`${attempt.engine}:irrelevant`);
                continue;
            }
            return { engine: attempt.engine, query: q, results };
        } catch (err) {
            const e = caughtToError(err);
            failures.push(`${attempt.engine}:${e.detail || e.error}`);
        }
    }
    return jsonError('empty', failures.join(',') || 'no-results');
}

export async function fetchUrl(url: string, maxChars?: number): Promise<FetchPageOk | JsonError> {
    const raw = String(url || '').trim();
    if (!raw) return jsonError('invalid', 'url-required');
    const cap = clampTextChars(maxChars);
    try {
        const doc = await fetchPublicDoc(raw);
        const kind = contentKind(doc.contentType, doc.body);
        if (kind === 'reject') {
            return jsonError('unsupported', (doc.contentType || 'unknown').split(';')[0] || 'unknown');
        }
        let title = '';
        let text = '';
        if (kind === 'html') {
            title = extractTitle(doc.body);
            text = htmlToText(doc.body);
        } else if (kind === 'json') {
            title = '';
            text = collapseWs(doc.body);
        } else {
            title = extractTitle(doc.body) || '';
            text = collapseWs(doc.body);
        }
        const truncated = text.length > cap;
        if (truncated) text = text.slice(0, cap);
        return {
            url: raw,
            finalUrl: doc.finalUrl,
            title,
            text,
            truncated,
        };
    } catch (err) {
        return caughtToError(err);
    }
}
