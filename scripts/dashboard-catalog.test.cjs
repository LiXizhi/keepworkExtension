const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText, file);
const { mcpCatalog } = require('../src/mcp/mcpCatalog.ts');
const { createMcpServer } = require('../src/mcp/server.ts');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

test('dashboard catalog matches MCP discovery, including conditional tools', async () => {
    for (const messaging of [undefined, {}]) {
        const runtime = { port: 8089, root: process.cwd(), startedAt: new Date().toISOString(), requireAuth: false, messaging };
        const catalog = await mcpCatalog(runtime);
        const server = createMcpServer(runtime), client = new Client({ name: 'catalog-test', version: '1' });
        const [a, b] = InMemoryTransport.createLinkedPair();
        try {
            await server.connect(a); await client.connect(b);
            assert.deepEqual(catalog.tools, (await client.listTools()).tools.sort((a, b) => a.name.localeCompare(b.name)));
            assert.equal(catalog.tools.some(tool => tool.name === 'listen_dingtalk_messages'), !!messaging);
            const resources = (await client.listResources()).resources;
            const exposed = [...catalog.skills, ...catalog.references];
            for (const resource of resources) assert.deepEqual(exposed.find(entry => entry.uri === resource.uri), resource);
            assert.ok(!resources.some(resource => resource.uri.startsWith('keepwork://skills/agent-cli-verify/')));
            assert.equal(exposed.filter(resource => !resource.uri.startsWith('keepwork://skills/agent-cli-verify/')).length, resources.length + 1);
        } finally { await client.close(); await server.close(); }
    }
});

test('dashboard renders and filters tool descriptions, schemas and skills safely', async t => {
    const { chromium } = require('playwright-core');
    const { resolveBrowser } = require('../src/core/headless.ts');
    const { dashboardHtml } = require('../src/mcp/dashboard.ts');
    const executablePath = resolveBrowser();
    if (!executablePath) { t.skip('System Edge/Chrome unavailable'); return; }
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
        const page = await browser.newPage();
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        const catalog = await mcpCatalog({ port: 8089, root: process.cwd(), startedAt: '', requireAuth: false });
        catalog.tools.push({ name: 'unsafe-fixture', description: '<img src=x onerror=alert(1)>', inputSchema: { type: 'object' } });
        await page.route('**/*', route => {
            const pathname = new URL(route.request().url()).pathname;
            if (pathname === '/dashboard') return route.fulfill({ contentType: 'text/html', body: dashboardHtml() });
            if (pathname === '/admin/status') return route.fulfill({ json: { clients: [], uptimeMs: 0 } });
            if (pathname === '/admin/api-docs') return route.fulfill({ json: { ...catalog, description: 'Catalog', endpoints: [] } });
            return route.fulfill({ status: 404, body: '{}' });
        });
        await page.goto('http://127.0.0.1:8080/dashboard#tools-skills');
        await page.locator('.catalog-tools').first().waitFor();
        const catalogLink = page.getByRole('link', { name: 'Tools & skills', exact: true });
        assert.equal(await catalogLink.getAttribute('aria-current'), 'page');
        await page.getByRole('link', { name: 'API docs', exact: true }).click();
        await page.locator('#view-api-docs').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#view-tools-skills').isVisible(), false);
        assert.equal(await page.locator('#api-docs .catalog-tools').count(), 0);
        await catalogLink.click();
        await page.locator('#view-tools-skills').waitFor({ state: 'visible' });
        assert.equal(await page.locator('.catalog-tools').count(), catalog.tools.length);
        assert.equal(await page.locator('.catalog-skills').count(), 3);
        assert.equal(await page.locator('#tools-skills img').count(), 0);
        await page.locator('#catalog-filter').fill('run_terminal');
        assert.equal(await page.locator('.catalog-tools').count(), catalog.tools.filter(tool => JSON.stringify(tool).toLowerCase().includes('run_terminal')).length);
        const terminal = page.locator('.catalog-tools').filter({ has: page.getByText('run_terminal', { exact: true }) });
        await terminal.locator('summary').click();
        assert.match(await terminal.locator('pre').innerText(), /"command"/);
        await page.locator('#catalog-filter').fill('editable voxel');
        assert.match(await page.locator('.catalog-skills').innerText(), /paracraft-create/);
        await page.locator('#catalog-filter').fill('keepwork-mcp-assistant');
        await page.locator('.catalog-skills summary').click();
        assert.match(await page.locator('.catalog-skills pre').innerText(), /\/dashboard\/skills\/keepwork-mcp-assistant\/SKILL.md/);
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.locator('#catalog-filter').fill('no-such-catalog-entry');
        assert.equal(await page.locator('#tools-skills').innerText(), 'No matching tools or skills.');
        assert.deepEqual(errors, []);
    } finally { await browser.close(); }
});


test('CLI setup resources are opt-in and remain readable in configuration contexts', async () => {
    for (const includeSetupGuides of [false, true]) {
        const server = createMcpServer({ port: 8089, root: process.cwd(), startedAt: '', requireAuth: false, includeSetupGuides });
        const client = new Client({ name: 'setup-context-test', version: '1' });
        const [a, b] = InMemoryTransport.createLinkedPair();
        try {
            await server.connect(a); await client.connect(b);
            const resources = (await client.listResources()).resources;
            const setup = resources.filter(resource => resource.uri.startsWith('keepwork://skills/agent-cli-verify/'));
            if (!includeSetupGuides) {
                assert.equal(setup.length, 0);
                assert.equal((await client.listResourceTemplates()).resourceTemplates.length, 0);
            } else {
                const { AGENT_BACKENDS } = require('../src/core/agentCliBackends.ts');
                assert.equal(setup.length, AGENT_BACKENDS.length + 3);
                for (const resource of setup) {
                    const result = await client.readResource({ uri: resource.uri });
                    assert.ok(result.contents[0].text.length > 0);
                }
            }
        } finally { await client.close(); await server.close(); }
    }
});
