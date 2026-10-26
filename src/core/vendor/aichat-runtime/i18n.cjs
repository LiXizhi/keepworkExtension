"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeLanguage = normalizeLanguage;
exports.resolveLanguage = resolveLanguage;
exports.createI18n = createI18n;
// Dictionary-free translation helper. Each host/tool creates its own isolated instance.
function normalizeLanguage(value) {
    if (/^en(?:[-_]|$)/i.test(value || ''))
        return 'en';
    if (/^zh(?:[-_]|$)/i.test(value || ''))
        return 'zh-CN';
    return '';
}
function resolveLanguage({ host = '', query = '', saved = '', browser = '' } = {}) {
    return normalizeLanguage(host) || normalizeLanguage(query) || normalizeLanguage(saved) || normalizeLanguage(browser) || 'zh-CN';
}
function createI18n(en = {}, { storageKey = '', eventName = 'tool:language-changed' } = {}) {
    let hostLanguage = '';
    let preference = '';
    try {
        if (storageKey)
            preference = localStorage.getItem(storageKey) || '';
    }
    catch { }
    function queryLanguage() {
        try {
            const q = new URLSearchParams(location.search);
            return q.get('locale') || q.get('lang') || '';
        }
        catch {
            return '';
        }
    }
    function getLanguage() {
        return resolveLanguage({ host: hostLanguage, query: queryLanguage(), saved: preference, browser: globalThis.window?.navigator?.language });
    }
    function getLanguagePreference() { return preference || 'auto'; }
    function notify() {
        if (typeof document === 'undefined')
            return;
        document.documentElement.lang = getLanguage();
        document.dispatchEvent(new CustomEvent(eventName, { detail: { language: getLanguage() } }));
    }
    function setHostLanguage(value) {
        const before = getLanguage();
        hostLanguage = normalizeLanguage(value);
        if (before !== getLanguage())
            notify();
    }
    function setLanguage(value) {
        preference = normalizeLanguage(value);
        try {
            if (storageKey && preference)
                localStorage.setItem(storageKey, preference);
            else if (storageKey)
                localStorage.removeItem(storageKey);
        }
        catch { }
        notify();
    }
    function uiText(key, values = {}) {
        const source = String(key ?? '');
        const translated = getLanguage() === 'en' && Object.hasOwn(en, source) ? en[source] : source;
        return translated.replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(values, name) ? String(values[name]) : match);
    }
    const t = uiText;
    // Only explicitly marked application chrome is updated. Never traverse message,
    // Markdown, editor, or iframe content to guess which text belongs to the app.
    function refreshTranslations(root = document) {
        for (const element of root.querySelectorAll('[data-i18n], [data-i18n-title], [data-i18n-placeholder], [data-i18n-aria-label]')) {
            if (element.closest('.md-body, pre, code, [contenteditable="true"], [data-no-i18n]'))
                continue;
            if (element.hasAttribute('data-i18n'))
                element.textContent = uiText(element.dataset.i18n);
            for (const attr of ['title', 'placeholder', 'aria-label']) {
                const key = element.getAttribute(`data-i18n-${attr}`);
                if (key !== null)
                    element.setAttribute(attr, uiText(key));
            }
        }
    }
    if (typeof document !== 'undefined')
        document.addEventListener(eventName, () => refreshTranslations());
    if (typeof document !== 'undefined')
        document.documentElement.lang = getLanguage();
    return { getLanguage, getLanguagePreference, setHostLanguage, setLanguage, uiText, t, refreshTranslations };
}
