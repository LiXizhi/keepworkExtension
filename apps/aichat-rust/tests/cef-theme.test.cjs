const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = path.resolve(__dirname, '..');
const template = fs.readFileSync(path.join(app, 'windows/cef-host/theme_script.h.in'), 'utf8');
const sampler = fs.readFileSync(path.join(app, 'src/chromeTheme.js'), 'utf8')
  .replace('export function', 'function');
const script = template.match(/R"KW_THEME\(([\s\S]*?)\)KW_THEME"/)[1]
  .replace('@KEEPWORK_CHROME_THEME_SCRIPT@', sampler);

test('CEF production theme wrapper reports live CSS colors without retaining its native reporter', {
  skip: process.env.KEEPWORK_CEF_BROWSER_TESTS !== '1', timeout: 60000,
}, async t => {
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({
    channel: process.env.KEEPWORK_CEF_BROWSER_CHANNEL || 'chrome', headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent('<!doctype html><body class="light" style="--bg-sidebar:#f2f3f7;--text-primary:#1a1a2e;--bg-pill-hover:#e2e6ef"><input value="keep this draft"></body>');
  await page.evaluate(() => {
    window.__themeReports = [];
    window.__keepworkChromeColors = (...colors) => window.__themeReports.push(colors);
  });
  await page.evaluate(script);
  await page.waitForFunction(() => window.__themeReports.length === 1);
  assert.deepEqual(await page.evaluate(() => window.__themeReports), [['#f2f3f7', '#1a1a2e', '#e2e6ef']]);
  assert.deepEqual(await page.evaluate(() => ({
    nativeReporter: typeof window.__keepworkChromeColors,
    bridge: typeof window.aichatDesktop,
    domTitlebar: !!document.getElementById('keepwork-desktop-titlebar'),
  })), { nativeReporter: 'undefined', bridge: 'undefined', domTitlebar: false });

  await page.evaluate(() => {
    document.body.className = 'dark';
    for (const [name, color] of [['--bg-sidebar', '#18181f'], ['--text-primary', '#d4d4dc'], ['--bg-pill-hover', '#282834']]) {
      document.body.style.setProperty(name, color);
    }
    document.dispatchEvent(new Event('aichat:theme-changed'));
  });
  await page.waitForFunction(() => window.__themeReports.length === 2);
  assert.deepEqual(await page.evaluate(() => window.__themeReports.at(-1)), ['#18181f', '#d4d4dc', '#282834']);

  await page.evaluate(() => {
    const skin = document.createElement('style');
    skin.textContent = ':root{--skin-bg:rgb(16,32,48);--skin-text:#eeddcc;--skin-hover:rgb(68,85,102)}';
    document.head.appendChild(skin);
    document.body.style.setProperty('--bg-sidebar', 'var(--skin-bg)');
    document.body.style.setProperty('--text-primary', 'var(--skin-text)');
    document.body.style.setProperty('--bg-pill-hover', 'var(--skin-hover)');
    document.dispatchEvent(new Event('aichat:skin-changed'));
  });
  await page.waitForFunction(() => window.__themeReports.length === 3);
  assert.deepEqual(await page.evaluate(() => window.__themeReports.at(-1)), ['#102030', '#eeddcc', '#445566'],
    'real browser CSS resolves inherited var() values before native RGB reporting');

  await page.evaluate(() => document.body.style.setProperty('--bg-pill-hover', '#778899'));
  await page.waitForFunction(() => window.__themeReports.length === 4);
  assert.deepEqual(await page.evaluate(() => window.__themeReports.at(-1)), ['#102030', '#eeddcc', '#778899'],
    'hover-only mutations cannot be lost to the shared sampler invoke deduplication');
  await page.evaluate(() => {
    for (const target of [document, window]) {
      for (const type of ['aichat:theme-changed', 'aichat:skin-changed', 'aichat:experience-changed']) {
        target.dispatchEvent(new Event(type));
      }
    }
    document.body.style.setProperty('--bg-pill-hover', '#778899');
  });
  assert.equal(await page.evaluate(async () => {
    await Promise.resolve();
    await Promise.resolve();
    return window.__themeReports.length;
  }), 4, 'unchanged colors are not repeatedly sent over native IPC');

  await page.evaluate(() => {
    const skin = document.createElement('link');
    skin.rel = 'stylesheet';
    skin.href = 'data:text/css,' + encodeURIComponent(':root{--skin-bg:#112233;--skin-text:#fafbfc;--skin-hover:#456789}');
    document.head.appendChild(skin);
  });
  await page.waitForFunction(() => window.__themeReports.length === 5);
  assert.deepEqual(await page.evaluate(() => window.__themeReports.at(-1)), ['#112233', '#fafbfc', '#778899'],
    'a late stylesheet load refreshes colors even without a theme event or body mutation');
  assert.equal(await page.locator('input').inputValue(), 'keep this draft');
  assert.deepEqual(errors, []);

  const early = await browser.newPage();
  const earlyErrors = [];
  early.on('pageerror', error => earlyErrors.push(error.message));
  await early.addInitScript({ content: `
    window.__bodyMissingAtThemeInjection = document.body === null;
    window.__themeReports = [];
    window.__keepworkChromeColors = (...colors) => window.__themeReports.push(colors);
    ${script}
    window.__reporterRemovedBeforePageScripts = typeof window.__keepworkChromeColors === 'undefined';
  ` });
  await early.goto('data:text/html,' + encodeURIComponent('<!doctype html><body class="light" style="--bg-sidebar:#f4f5f6;--text-primary:#102030;--bg-pill-hover:#ddeeff"></body>'));
  await early.waitForFunction(() => window.__themeReports.length === 1);
  assert.deepEqual(await early.evaluate(() => ({
    bodyMissing: window.__bodyMissingAtThemeInjection,
    reporterRemoved: window.__reporterRemovedBeforePageScripts,
    reports: window.__themeReports,
    bridge: typeof window.aichatDesktop,
  })), { bodyMissing: true, reporterRemoved: true, reports: [['#f4f5f6', '#102030', '#ddeeff']], bridge: 'undefined' },
  'CEF context-created injection waits for a delayed body and hides the reporter immediately');
  assert.deepEqual(earlyErrors, []);
});
