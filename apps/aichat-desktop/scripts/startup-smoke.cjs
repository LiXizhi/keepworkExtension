// Exercise the real desktop entry with an isolated profile and a slow optional image.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { _electron } = require('playwright-core');
async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-startup-perf-'));
  const timers = new Set();
  const server = http.createServer((req, res) => {
    if (req.url === '/optional.svg') {
      const timer = setTimeout(() => {
        timers.delete(timer); res.setHeader('Content-Type', 'image/svg+xml');
        res.end('<svg xmlns="http://www.w3.org/2000/svg"/>');
      }, 6000);
      timers.add(timer); return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Startup timing fixture</title><h1>AIChat ready</h1><img src="/optional.svg">');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, AICHAT_DESKTOP_DISABLE_MCP: '1', AICHAT_DESKTOP_DEV_URL: `http://127.0.0.1:${server.address().port}/AIChat.html` };
  delete env.ELECTRON_RUN_AS_NODE;
  let application;
  try {
    const started = Date.now();
    application = await _electron.launch({ executablePath: require('electron'), args: [path.resolve(__dirname, '..'), `--user-data-dir=${home}`], env });
    const page = await application.firstWindow();
    await page.waitForURL(env.AICHAT_DESKTOP_DEV_URL, { waitUntil: 'domcontentloaded' });
    const domMs = Date.now() - started;
    const visible = await application.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(w => w.getTitle() === 'KeepWork 第二大脑');
      const deadline = Date.now() + 1800;
      while (!win.isVisible() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
      return win.isVisible();
    });
    console.log(JSON.stringify({ scenario: 'slow optional image', domMs, checkedMs: Date.now() - started, visible }));
    assert.equal(visible, true, 'Usable page remains hidden while an optional resource loads');
    // The native show event can reach Playwright before connectInitial resumes
    // and writes its receipt (notably on Windows). Wait for that separate event.
    const actualHome = await application.evaluate(({ app }) => app.getPath('userData'));
    assert.equal(fs.realpathSync(actualHome).toLowerCase(), fs.realpathSync(home).toLowerCase());
    const reportFile = path.join(actualHome, 'startup-timing.json');
    const reportDeadline = Date.now() + 3000;
    while (!fs.existsSync(reportFile) && Date.now() < reportDeadline) await new Promise(resolve => setTimeout(resolve, 25));
    const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    assert.equal(report.outcome, 'ready');
    assert.ok(report.stagesMs.windowReady >= report.stagesMs.pageStart);
    assert.ok(report.stagesMs.windowReady - report.stagesMs.pageStart < 1800);
    assert.equal(JSON.stringify(report).includes('http'), false);
    await page.waitForLoadState();
    console.log('PASS: usable window is visible before optional resources finish');
  } finally {
    if (application) await application.close();
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
