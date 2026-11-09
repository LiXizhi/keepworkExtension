// Exercise macOS bundle language negotiation, including the stripped .lproj layout
// produced by packaging. Never launch or change the installed user's app/profile.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
if (process.platform !== 'darwin') { console.log('SKIP: macOS bundle locale smoke'); process.exit(0); }
const root = path.resolve(__dirname, '..');
const { _electron } = createRequire(path.resolve(root, '../mcp-runtime/package.json'))('playwright-core');
const config = require('../electron-builder.config.cjs');
const packagedApp = process.argv[2] ? path.resolve(process.argv[2]) : null;
async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-locale-smoke-'));
  let application;
  try {
    const app = path.join(temp, 'Electron.app');
    execFileSync('cp', ['-cR', packagedApp || path.join(root, 'node_modules/electron/dist/Electron.app'), app]);
    const resources = path.join(app, 'Contents/Resources');
    for (const name of fs.readdirSync(resources)) if (name.endsWith('.lproj')) fs.rmSync(path.join(resources, name), { recursive: true });
    const plist = path.join(app, 'Contents/Info.plist');
    const info = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' }));
    if (!packagedApp) {
      delete info.CFBundleLocalizations;
      if (config.mac.extendInfo.CFBundleLocalizations) info.CFBundleLocalizations = config.mac.extendInfo.CFBundleLocalizations;
    }
    fs.writeFileSync(plist, JSON.stringify(info));
    execFileSync('plutil', ['-convert', 'xml1', plist]);
    const fixture = path.join(temp, 'fixture.cjs');
    fs.writeFileSync(fixture, `const{app,BrowserWindow}=require('electron');app.whenReady().then(()=>{globalThis.window=new BrowserWindow({webPreferences:{contextIsolation:true,sandbox:true}});window.loadURL('data:text/html,<meta charset=utf-8><title>Locale fixture</title>');});`);
    if (packagedApp) {
      // Keep the packaged engine, helpers and Info.plist. Replace only the clone's
      // business entry so the test never starts the user's MCP or opens their data.
      const entry = path.join(temp, 'entry'); fs.mkdirSync(entry);
      fs.copyFileSync(fixture, path.join(entry, 'fixture.cjs'));
      fs.writeFileSync(path.join(entry, 'package.json'), JSON.stringify({ name: 'locale-smoke', version: '1.0.0', main: 'fixture.cjs' }));
      await require('@electron/asar').createPackage(entry, path.join(resources, 'app.asar'));
    }
    execFileSync('codesign', ['--force', '--sign', '-', '--entitlements', path.join(root, config.mac.entitlements), app], { stdio: 'pipe' });
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    for (const [language, expected] of [['zh-Hans-CN', /^zh/i], ['en-US', /^en/i]]) {
      application = await _electron.launch({ executablePath: path.join(app, 'Contents/MacOS', info.CFBundleExecutable), args: [fixture, `--user-data-dir=${path.join(temp, language)}`, '-AppleLanguages', `(${language})`], env });
      const page = await application.firstWindow(); await page.waitForLoadState();
      const native = await application.evaluate(({ app }) => ({ locale: app.getLocale(), preferred: app.getPreferredSystemLanguages() }));
      const browser = await page.evaluate(() => ({ language: navigator.language, languages: navigator.languages }));
      console.log(JSON.stringify({ requested: language, native, browser }));
      assert.match(native.preferred[0], expected, 'fixture must apply the requested OS language');
      assert.match(browser.language, expected, 'packaged locale must follow OS preference without a saved web preference');
      await application.close(); application = undefined;
    }
    console.log('PASS: packaged macOS Chinese/English default locale negotiation');
  } finally {
    if (application) await application.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
