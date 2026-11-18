const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const { chromium } = require('playwright-core');
const harness = require('../../../scripts/contract/harness.cjs');

function dashboardHtml() {
  const source = fs.readFileSync(path.join(__dirname, '../crates/keepwork-mcp/src/dashboard.rs'), 'utf8');
  const html = source.match(/const DASHBOARD_HTML: &str = r###"([\s\S]*?)"###;/)[1];
  const shared = fs.readFileSync(path.join(__dirname, '../../../src/mcp/dashboardCli.ts'), 'utf8');
  const compiled = ts.transpileModule(shared, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  new Function('exports', compiled)(exports);
  return html
    .replace('/* KEEPWORK_CLI_STYLES */', exports.dashboardCliStyles)
    .replace('<!-- KEEPWORK_CLI_HTML -->', exports.dashboardCliHtml)
    .replace('/* KEEPWORK_CLI_SCRIPT */', exports.dashboardCliScript);
}

function launch() {
  const executablePath = process.env.KEEPWORK_TEST_BROWSER || process.env.DASHBOARD_BROWSER;
  return chromium.launch(executablePath ? { executablePath, headless: true } : { channel: 'chrome', headless: true });
}

test('Rust dashboard exposes the shared Claude configuration workflow with stable owner, native fallback and no mutation replay', { timeout: 60000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [], requests = [], mutations = [];
  let state = { version: 1, activeProfileId: null, profiles: [] }, failActivate = false;
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.pathname === '/dashboard') return route.fulfill({ contentType: 'text/html', body: dashboardHtml() });
    if (url.pathname === '/admin/status') return route.fulfill({ json: { clients: [] } });
    if (url.pathname.startsWith('/agents/')) requests.push({ method, path: url.pathname, headers: request.headers() });
    if (url.pathname === '/agents/accounts') return route.fulfill({ json: {
      claude: { name: 'Claude Code', available: true, cli: { path: '/fixture/claude' }, actions: {} },
    } });
    if (url.pathname === '/agents/backends') return route.fulfill({ json: { claude: { available: true, authenticated: true, account: { type: 'apiKey' } } } });
    if (url.pathname === '/agents/claude/config' && method === 'GET') return route.fulfill({ json: state });
    if (url.pathname.startsWith('/agents/claude/config/')) {
      const body = method === 'DELETE' ? undefined : request.postDataJSON();
      mutations.push({ method, path: url.pathname, body });
      if (url.pathname.endsWith('/activate')) {
        if (failActivate) return route.abort('failed');
        state = { ...state, activeProfileId: body.profileId };
      } else if (method === 'POST') {
        const { secret, ...profile } = body;
        state = { ...state, profiles: [{ id: 'provider-1', ...profile, hasSecret: !!secret }] };
      } else if (method === 'PATCH') {
        const { secret, ...profile } = body;
        state = { ...state, profiles: state.profiles.map(saved => ({ ...saved, ...profile, ...(secret ? { hasSecret: true } : {}) })) };
      } else if (method === 'DELETE') state = { ...state, profiles: [] };
      return route.fulfill({ json: state });
    }
    return route.abort();
  });

  await page.goto('http://127.0.0.1:18089/dashboard#cli-accounts');
  await page.locator('#claude-config-open').click();
  await page.locator('#claude-profile-new').click();
  await page.locator('#claude-profile-name').fill('<img src=x onerror=alert(1)>');
  await page.locator('#claude-profile-base-url').fill('https://gateway.example.test/anthropic');
  await page.locator('#claude-profile-auth-type').selectOption('authToken');
  await page.locator('#claude-profile-secret').fill('fixture-dashboard-only-secret');
  await page.locator('#claude-profile-model').fill('provider-model');
  await page.locator('#claude-profile-form summary').click();
  await page.locator('#claude-profile-sonnet-model').fill('provider-sonnet');
  await page.locator('#claude-profile-opus-model').fill('provider-opus');
  await page.locator('#claude-profile-haiku-model').fill('provider-haiku');
  await page.locator('#claude-profile-save').click();
  const row = page.locator('[data-profile-id="provider-1"]');
  await row.waitFor();
  assert.equal(await row.locator('img').count(), 0);
  assert.equal(await page.locator('#claude-profile-secret').inputValue(), '');
  assert.ok(!(await page.locator('#claude-config-panel').innerText()).includes('fixture-dashboard-only-secret'));
  assert.deepEqual(mutations[0].body, {
    name: '<img src=x onerror=alert(1)>', baseUrl: 'https://gateway.example.test/anthropic', authType: 'authToken',
    secret: 'fixture-dashboard-only-secret', model: 'provider-model', sonnetModel: 'provider-sonnet', opusModel: 'provider-opus', haikuModel: 'provider-haiku',
  });

  await row.getByRole('button', { name: '启用', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#claude-profile-current').textContent.includes('<img'));
  assert.equal(await row.getByRole('button', { name: '删除', exact: true }).isDisabled(), true);
  await row.getByRole('button', { name: '编辑', exact: true }).click();
  assert.equal(await page.locator('#claude-profile-secret').inputValue(), '');
  await page.locator('#claude-profile-name').fill('Renamed provider');
  await page.locator('#claude-profile-save').click();
  await page.waitForFunction(() => document.querySelector('#claude-profile-list').textContent.includes('Renamed provider'));
  assert.equal('secret' in mutations.find(change => change.method === 'PATCH').body, false);
  await page.locator('#claude-profile-native').click();
  await page.waitForFunction(() => document.querySelector('#claude-profile-current').textContent.includes('本机默认配置'));

  failActivate = true;
  await row.getByRole('button', { name: '启用', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#claude-config-notice').textContent.includes('未自动重试'));
  const mutationCount = mutations.length;
  await page.waitForTimeout(120);
  assert.equal(mutations.length, mutationCount);
  assert.equal(await page.locator('#claude-profile-new').isDisabled(), true);
  assert.equal(await row.getByRole('button', { name: '启用', exact: true }).isDisabled(), true);
  failActivate = false;
  await page.locator('#claude-config-refresh').click();
  await page.waitForFunction(() => !document.querySelector('#claude-profile-new').disabled);
  await row.getByRole('button', { name: '删除', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-profile-id]'));
  await page.locator('[data-cli="claude"]').getByRole('button', { name: '检测账号', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-cli="claude"]').dataset.status === 'online');

  const ownerKeys = new Set(requests.map(request => request.headers['x-agent-owner']));
  assert.equal(ownerKeys.size, 1);
  assert.match([...ownerKeys][0], /^[\w-]{32,128}$/);
  const sameOriginGet = requests.find(request => request.path === '/agents/claude/config' && request.method === 'GET');
  assert.equal(sameOriginGet.headers.origin, undefined, 'native browser same-origin GET omits Origin; server must use its bounded dashboard-source adapter');
  assert.equal(sameOriginGet.headers.referer, 'http://127.0.0.1:18089/dashboard');
  assert.equal(requests.filter(request => request.path === '/agents/accounts').length, 1, 'navigation does not repeatedly probe installed CLIs');
  await page.getByRole('link', { name: 'Clients', exact: true }).click();
  await page.locator('#view-clients').waitFor({ state: 'visible' });
  await page.getByRole('link', { name: 'CLI 账号', exact: true }).click();
  await page.locator('#view-cli-accounts').waitFor({ state: 'visible' });
  assert.deepEqual(errors, []);
});

test('Rust dashboard keeps ordinary CLI checks usable with older or unknown Claude configuration contracts', { timeout: 30000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  let unknownVersion = false, mutations = 0;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/dashboard') return route.fulfill({ contentType: 'text/html', body: dashboardHtml() });
    if (url.pathname === '/admin/status') return route.fulfill({ json: { clients: [] } });
    if (url.pathname === '/agents/accounts') return route.fulfill({ json: { claude: { name: 'Claude Code', available: true, actions: {} } } });
    if (url.pathname === '/agents/backends') return route.fulfill({ json: { claude: { available: true, authenticated: true } } });
    if (url.pathname === '/agents/claude/config') return unknownVersion
      ? route.fulfill({ json: { version: 99, activeProfileId: null, profiles: [] } })
      : route.fulfill({ status: 404, json: { error: 'Unknown agent endpoint' } });
    if (url.pathname.startsWith('/agents/claude/config/')) mutations++;
    return route.abort();
  });
  await page.goto('http://127.0.0.1:18089/dashboard#cli-accounts');
  await page.locator('#claude-config-open').click();
  await page.waitForFunction(() => document.querySelector('#claude-config-notice').textContent.includes('暂不可用'));
  assert.equal(await page.locator('#claude-profile-new').isDisabled(), true);
  unknownVersion = true;
  await page.locator('#claude-config-refresh').click();
  await page.waitForFunction(() => document.querySelector('#claude-config-notice').textContent.includes('不支持此版本'));
  assert.equal(await page.locator('#claude-profile-new').isDisabled(), true);
  await page.locator('[data-cli="claude"]').getByRole('button', { name: '检测账号', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-cli="claude"]').dataset.status === 'online');
  assert.equal(mutations, 0);
  assert.deepEqual(errors, []);
});

test('Rust dashboard Claude configuration reaches real Rust HTTP with browser source checks and an isolated synthetic CLI', {
  timeout: 60000,
  skip: process.env.KEEPWORK_MCP_TEST_BIN ? false : 'Set KEEPWORK_MCP_TEST_BIN to a freshly built Rust daemon for the real HTTP browser smoke.',
}, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-dashboard-claude-http-'));
  const home = path.join(directory, 'home'), root = path.join(directory, 'workspace');
  fs.mkdirSync(home); fs.mkdirSync(root); fs.mkdirSync(path.join(home, '.claude'));
  const nativeSettings = path.join(home, '.claude/settings.json');
  const nativeBody = JSON.stringify({ permissions: { defaultMode: 'plan' }, env: { FIXTURE_UNRELATED_SETTING: 'preserved' } });
  fs.writeFileSync(nativeSettings, nativeBody);
  const cli = path.join(directory, 'claude fixture.cjs'), log = path.join(directory, 'native.log');
  fs.copyFileSync(path.join(harness.repoRoot, 'scripts/contract/fixtures/claude-agent-cli.cjs'), cli);
  const environment = {
    KEEPWORK_MCP_ROOT: root, KEEPWORK_MCP_REQUIRE_AUTH: '0', KEEPWORK_CLAUDE_PATH: cli,
    KEEPWORK_CLAUDE_FIXTURE_PROFILE_MODE: '1', KEEPWORK_CLAUDE_FIXTURE_AUTH: 'out', KEEPWORK_AGENT_FIXTURE_LOG: log,
  };
  for (const backend of ['CODEX', 'WORKBUDDY', 'CODEBUDDY', 'COPILOT', 'CURSOR', 'TRAE', 'QWEN', 'GEMINI', 'ANTIGRAVITY', 'KIMI', 'OPENCODE', 'DEEPSEEK']) {
    environment['KEEPWORK_' + backend + '_PATH'] = path.join(directory, 'missing-cli');
  }
  let daemon, browser;
  t.after(async () => {
    await browser?.close();
    await daemon?.stop();
    await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  daemon = await harness.startRust({ home, env: environment });
  assert.equal(daemon.health.runtimeEngine, 'rust');
  assert.equal(daemon.health.claudeConfigApi, 'profiles-v1');
  browser = await launch();
  const page = await browser.newPage(), errors = [], failedResponses = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  page.on('response', response => {
    if (new URL(response.url()).pathname.startsWith('/agents/') && !response.ok()) failedResponses.push({ status: response.status(), path: new URL(response.url()).pathname });
  });
  // No browser routes or fetch mocks: the compiled dashboard, source adaptation,
  // owner/auth dispatch, provider storage and child stdio all run for real.
  await page.goto(daemon.base + '/dashboard#cli-accounts');
  await page.locator('#claude-config-open').click();
  await page.locator('#claude-profile-new').click();
  await page.locator('#claude-profile-name').fill('Real HTTP fixture');
  await page.locator('#claude-profile-base-url').fill('https://fixture-first.example.test/anthropic');
  await page.locator('#claude-profile-auth-type').selectOption('apiKey');
  await page.locator('#claude-profile-secret').fill('fixture-first-secret');
  await page.locator('#claude-profile-model').fill('fixture-first');
  await page.locator('#claude-profile-save').click();
  const row = page.locator('[data-profile-id]');
  await row.waitFor();
  await row.getByRole('button', { name: '启用', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#claude-profile-current').textContent.includes('Real HTTP fixture'));
  await page.locator('[data-cli="claude"]').getByRole('button', { name: '检测账号', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-cli="claude"]').dataset.status === 'online');
  const info = await page.evaluate(() => cliStates.get('claude'));
  assert.equal(info.authenticated, true);
  assert.ok(info.models.some(model => model.id === 'fixture-first'));
  assert.equal(await row.getByRole('button', { name: '删除', exact: true }).isDisabled(), true);
  assert.equal(await page.locator('#claude-profile-secret').inputValue(), '');
  assert.ok(!(await page.locator('#claude-config-panel').innerText()).includes('fixture-first-secret'));
  await row.getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator('#claude-profile-name').fill('Edited real HTTP fixture');
  await page.locator('#claude-profile-save').click();
  await page.waitForFunction(() => document.querySelector('#claude-profile-current').textContent.includes('Edited real HTTP fixture'));
  await page.locator('#claude-profile-native').click();
  await page.waitForFunction(() => document.querySelector('#claude-profile-current').textContent.includes('本机默认配置'));
  await row.getByRole('button', { name: '删除', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-profile-id]'));
  assert.deepEqual(await page.evaluate(() => ({ version: claudeConfig.version, activeProfileId: claudeConfig.activeProfileId, profiles: claudeConfig.profiles })), {
    version: 1, activeProfileId: null, profiles: [],
  });
  assert.equal(fs.readFileSync(nativeSettings, 'utf8'), nativeBody);
  const rows = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(rows.some(row => row.type === 'launch' && row.provider?.credentialKind === 'apiKey' && row.provider?.model === 'fixture-first'));
  assert.ok(rows.every(row => !row.args?.some(arg => arg.includes('fixture-first-secret'))));
  assert.deepEqual(failedResponses, []);
  assert.deepEqual(errors, []);
});
