const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

// Serve the actual embedded dashboard through isolated browser routes. No
// daemon, browser profile or user persona directory is opened by this test.
test('Rust dashboard distinguishes persisted identities and accepts legacy snapshots', async t => {
  const source = fs.readFileSync(path.join(__dirname, '../crates/keepwork-mcp/src/dashboard.rs'), 'utf8');
  const html = source.match(/const DASHBOARD_HTML: &str = r###"([\s\S]*?)"###;/)[1];
  const browser = await chromium.launch(process.env.KEEPWORK_TEST_BROWSER
    ? { executablePath: process.env.KEEPWORK_TEST_BROWSER, headless: true }
    : { channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let snapshot = {
    stats: { total: 3, ownerGroups: 2 },
    personas: [
      { id: 'default-persona', name: '我的分身', ownerGroup: 'a'.repeat(64), root: '/brain', state: 'idle', executor: 'keepwork', messages: 0, unread: 0 },
      { id: 'default-persona', name: '我的分身', ownerGroup: 'b'.repeat(64), root: '/brain', state: 'done', executor: 'keepwork', messages: 2, unread: 1 },
      { id: 'bot', name: '<img src=x onerror=alert(1)>', ownerGroup: 'a'.repeat(64), root: '', state: 'idle', executor: 'keepwork', messages: 0, unread: 0 },
    ],
  };
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:18089') return route.abort();
    if (url.pathname === '/dashboard') return route.fulfill({ contentType: 'text/html', body: html });
    if (url.pathname === '/admin/status') return route.fulfill({ json: { clients: [] } });
    if (url.pathname === '/admin/personas') return route.fulfill({ json: snapshot });
    return route.abort();
  });
  await page.goto('http://127.0.0.1:18089/dashboard#personas');
  await page.locator('#personas tbody tr').first().waitFor();
  await t.test('same ID under separate identities remains distinguishable', async () => {
    assert.match(await page.locator('#persona-summary').textContent(), /3 条分身记录，属于 2 组浏览器身份/);
    assert.match(await page.locator('#persona-summary').textContent(), /不代表在线分身数量/);
    const rows = await page.locator('#personas tbody tr').allTextContents();
    assert.equal(rows.length, 3);
    const defaults = rows.filter(row => row.includes('default-persona'));
    assert.equal(defaults.length, 2);
    assert.ok(defaults.some(row => row.includes('a'.repeat(12))));
    assert.ok(defaults.some(row => row.includes('b'.repeat(12))));
    assert.equal(await page.locator('#personas img').count(), 0);
    assert.ok(rows.some(row => row.includes('<img src=x onerror=alert(1)>')));
  });
  await t.test('legacy optional metadata stays unknown and ordinary navigation works', async () => {
    snapshot = { personas: [{ id: 'default-persona', name: 'Legacy', state: 'idle', executor: 'keepwork', messages: 2, unread: 0 }] };
    await page.reload();
    await page.getByRole('cell', { name: 'Legacy', exact: true }).waitFor();
    assert.match(await page.locator('#persona-summary').textContent(), /1 条分身记录；身份组数未提供/);
    const cells = await page.locator('#personas tbody tr td').allTextContents();
    assert.equal(cells[1], '未提供');
    assert.equal(cells[3], '未提供');
    await page.getByRole('link', { name: 'Clients', exact: true }).click();
    await page.locator('#view-clients').waitFor({ state: 'visible' });
    assert.match(await page.locator('#clients').textContent(), /No connected AIChat sessions/);
  });
  await t.test('empty snapshot reports zero records without inventing identities', async () => {
    snapshot = { personas: [] };
    await page.goto('http://127.0.0.1:18089/dashboard#personas');
    await page.getByText('No personas. / 还没有分身', { exact: true }).waitFor();
    assert.match(await page.locator('#persona-summary').textContent(), /0 条分身记录，属于 0 组浏览器身份/);
  });
  assert.deepEqual(errors, []);
});
