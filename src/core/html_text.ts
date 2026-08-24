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

function collapseInline(s: string): string {
    return String(s || '').replace(/[ \t\f\v]+/g, ' ').replace(/ *\n */g, '\n').trim();
}

export function extractTitle(html: string): string {
    const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const og = String(html || '').match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)
        || String(html || '').match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
    const raw = m?.[1] || og?.[1] || '';
    return collapseInline(decodeEntities(raw.replace(/<[^>]+>/g, ' ')));
}

function stripChrome(html: string): string {
    return String(html || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
        .replace(/<template[\s\S]*?<\/template>/gi, ' ')
        .replace(/<iframe[\s\S]*?<\/iframe>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<(nav|footer|aside|form|header)[\s\S]*?<\/\1>/gi, ' ');
}

function pickMainHtml(html: string): string {
    const body = (String(html || '').match(/<body[^>]*>([\s\S]*?)<\/body>/i) || [null, html])[1] || html;
    const cleaned = stripChrome(body);
    const candidates = [
        /<article\b[^>]*>([\s\S]*?)<\/article>/i,
        /<main\b[^>]*>([\s\S]*?)<\/main>/i,
        /<div[^>]*role=["']main["'][^>]*>([\s\S]*?)<\/div>/i,
        /<div[^>]*class=["'][^"']*(?:article|post-content|entry-content|markdown-body|article-content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    ];
    let best = '';
    for (const re of candidates) {
        const m = cleaned.match(re);
        if (!m) continue;
        const text = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (text.length > best.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length) {
            best = m[1];
        }
    }
    const bestLen = best.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;
    const fullLen = cleaned.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;
    if (best && bestLen >= 120 && bestLen >= Math.min(400, fullLen * 0.25)) return best;
    return cleaned;
}

function tagsToText(html: string): string {
    let s = String(html || '');
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<hr\s*\/?>/gi, '\n');
    for (let i = 1; i <= 6; i++) {
        const hashes = '#'.repeat(i);
        s = s.replace(new RegExp(`<h${i}\\b[^>]*>`, 'gi'), `\n\n${hashes} `);
        s = s.replace(new RegExp(`</h${i}>`, 'gi'), '\n\n');
    }
    s = s.replace(/<li\b[^>]*>/gi, '\n- ');
    s = s.replace(/<tr\b[^>]*>/gi, '\n');
    s = s.replace(/<\/t[dh]>/gi, ' | ');
    s = s.replace(/<(p|div|section|article|blockquote|ul|ol|table|pre|figcaption)\b[^>]*>/gi, '\n\n');
    s = s.replace(/<\/(p|div|section|article|blockquote|ul|ol|table|pre|figcaption|li|tr)>/gi, '\n');
    s = s.replace(/<[^>]+>/g, '');
    return decodeEntities(s);
}

/** Structured readable text from HTML. Never returns markup. */
export function htmlToStructuredText(html: string): string {
    const main = pickMainHtml(html);
    const raw = tagsToText(main);
    const lines = raw.split(/\n/).map((line) => line.replace(/[ \t]+/g, ' ').trim());
    const out: string[] = [];
    let blank = 0;
    for (const line of lines) {
        if (!line) {
            blank += 1;
            if (blank === 1 && out.length) out.push('');
            continue;
        }
        blank = 0;
        const prev = out[out.length - 1];
        if (line === '|' || /^(\|\s*)+$/.test(line) || /^[-*•]\s*$/.test(line)) continue;
        if (line.startsWith('- ') && prev && !prev.startsWith('- ') && prev !== '') out.push('');
        out.push(line.replace(/(?:\s*\|\s*)+$/g, '').trim());
    }
    return out.join('\n').trim();
}
