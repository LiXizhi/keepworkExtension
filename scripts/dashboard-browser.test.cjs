const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');

test('dashboard navigation, API filter, history paging and responsive layout', async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(process.env.DASHBOARD_URL || 'http://127.0.0.1:8089/dashboard');
        const serviceControls = page.getByRole('navigation', { name: 'Service controls' });
        assert.equal(await serviceControls.isVisible(), true);
        assert.equal(await page.locator('#chat-frame').getAttribute('src'), null);
        await page.route('https://keepwork.com/chat?*', route => route.fulfill({ contentType: 'text/html', body: '<h1>Chat fixture</h1>' }));
        await page.getByRole('link', { name: 'AI 对话', exact: true }).click();
        await page.locator('#view-chat').waitFor({ state: 'visible' });
        assert.equal(await serviceControls.isVisible(), false);
        const chatUrl = new URL(await page.locator('#chat-frame').getAttribute('src'));
        assert.equal(await page.locator('#view-title').isVisible(), false);
        assert.equal(await page.locator('#new-chat, #chat-external').count(), 0);
        for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
            await page.setViewportSize(viewport);
            const geometry = await page.evaluate(() => {
                const frame = document.getElementById('chat-frame').getBoundingClientRect();
                const sidebar = document.querySelector('aside').getBoundingClientRect();
                return { top: frame.top, bottom: frame.bottom, left: frame.left, right: frame.right, sidebarRight: sidebar.right };
            });
            assert.equal(geometry.top, 0);
            assert.equal(geometry.bottom, viewport.height);
            assert.equal(geometry.left, geometry.sidebarRight);
            assert.equal(geometry.right, viewport.width);
            await page.screenshot({ path: path.join(os.tmpdir(), `dashboard-chat-${viewport.width}.png`) });
        }
        await page.setViewportSize({ width: 1280, height: 900 });
        assert.equal(chatUrl.origin, 'https://keepwork.com');
        assert.equal(chatUrl.searchParams.get('persist'), '0');
        assert.equal(chatUrl.searchParams.get('chat'), 'new');
        assert.equal(chatUrl.searchParams.get('skill'), 'keepwork-mcp-assistant');
        assert.equal(chatUrl.searchParams.has('token'), false);
        assert.ok(chatUrl.searchParams.get('skillUrl').endsWith('/dashboard/skills/keepwork-mcp-assistant/SKILL.md'));
        await page.getByRole('link', { name: 'API docs', exact: true }).click();
        await page.locator('.api-item').first().waitFor();
        assert.equal(await serviceControls.isVisible(), false);
        await page.locator('#api-filter').fill('query_scene');
        assert.equal(await page.locator('.api-item').count(), 1);
        await page.locator('.api-item summary').click();
        await page.screenshot({ path: path.join(os.tmpdir(), 'dashboard-desktop.png') });
        await page.getByRole('link', { name: 'Paracrafts', exact: true }).click();
        await page.locator('#paracrafts > *').waitFor();
        await page.getByRole('link', { name: 'Clients', exact: true }).click();
        assert.equal(await page.locator('#chat-frame').getAttribute('src'), chatUrl.href);
        await page.locator('#view-clients').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#view-clients').isVisible(), true);
        await page.route('**/admin/history?*', route => {
            const offset = Number(new URL(route.request().url()).searchParams.get('offset'));
            return route.fulfill({ json: { total: 21, hasMore: offset === 0, history: [{ time: 'test', sessionId: 'test', tool: 'fetch_url', summary: '<img src=x onerror=alert(1)>', ok: true, durationMs: 1 }] } });
        });
        await page.getByRole('link', { name: 'History', exact: true }).click();
        await page.getByRole('button', { name: 'Older', exact: true }).click();
        await page.getByText('21-21 of 21', { exact: true }).waitFor();
        assert.equal(await page.locator('#history img').count(), 0);
        await page.setViewportSize({ width: 390, height: 844 });
        await page.getByRole('link', { name: 'Overview / 概览', exact: true }).click();
        await page.locator('#view-overview').waitFor({ state: 'visible' });
        assert.equal(await serviceControls.isVisible(), true);
        const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, historyHidden: document.getElementById('view-history').hidden }));
        assert.ok(layout.scroll <= layout.width, JSON.stringify(layout));
        assert.equal(layout.historyHidden, true);
        await page.screenshot({ path: path.join(os.tmpdir(), 'dashboard-mobile.png') });
        assert.deepEqual(errors, []);
    } finally {
        await browser.close();
    }
});