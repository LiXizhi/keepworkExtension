// Native pet-window smoke without building AIChat, packaging, MCP, accounts or live media.
const { _electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-pet-smoke-'));
  const source = path.resolve(__dirname, '../src');
  const entry = path.join(directory, 'main.cjs');
  fs.writeFileSync(entry, `
    const { app, BrowserWindow, ipcMain, screen, Menu } = require('electron');
    const { createPetWindow } = require(${JSON.stringify(path.join(source, 'petWindow.cjs'))});
    app.whenReady().then(() => {
      global.petState = { version: 1, context: 'smoke-chat', ready: true, title: '桌面宠物', draft: '', canCall: true, messages: [{ role: 'assistant', content: '你好！可以打字、语音输入，或打开 AIChat 继续。' }] };
      global.petCommands = [];
      const observedMenu = { buildFromTemplate(items) {
        global.petMenuItems = items; global.petMenu = Menu.buildFromTemplate(items);
        global.petMenu.on('menu-will-show', () => { global.menuShown = true; }); return global.petMenu;
      } };
      global.pet = createPetWindow({ BrowserWindow, ipcMain, screen, Menu: observedMenu }, ${JSON.stringify(source)}, {
        position: () => null, savePosition: value => { global.savedPetPosition = value; },
        preferences: () => global.savedPreferences,
        savePreferences: value => { global.savedPreferences = value; },
        appearance: () => { global.appearanceOpened = true; },
        hide: () => { global.petHidden = true; global.pet.hide(true); },
        quit: () => { global.quitRequested = (global.quitRequested || 0) + 1; },
        open: () => { global.opened = true; global.pet.hide(); },
        command: command => {
          global.petCommands.push(command.action);
          const state = global.petState;
          if (command.action === 'input' && global.rejectInput) { global.rejectInput = false; global.pet.result({ requestId: command.requestId, ok: false, error: 'Temporary input failure' }); return; }
          if (command.action === 'input') state.draft = command.text;
          if (command.action === 'send') { state.messages.push({ role: 'user', content: state.draft }); state.draft = ''; state.busy = true; }
          if (command.action === 'stop') state.busy = false;
          if (command.action === 'dictation') state.dictating = !state.dictating;
          if (command.action === 'call') state.voice = { active: !state.voice?.active, state: 'listening' };
          if (command.action === 'mute') state.voice.muted = !state.voice.muted;
          if (command.action === 'hide') { state.voice = { active: false }; state.dictating = false; }
          global.pet.update(state);
          if (command.requestId) global.pet.result({ requestId: command.requestId, ok: true,
            ...(command.action === 'exit-info' ? { data: [{ name: '工作助手', channels: ['飞书', '钉钉'] }, { name: '私人助手', channels: [] }] } : {}) });
        },
      });
      global.pet.update(global.petState); global.pet.show();
    });
    app.on('window-all-closed', () => app.quit());
  `);
  let application;
  try {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    application = await _electron.launch({ executablePath: require('electron'), args: [entry, `--user-data-dir=${path.join(directory, 'profile')}`], env });
    const page = await application.firstWindow(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.locator('#pet').waitFor();
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isAlwaysOnTop()), true);
    const bounds = await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]; global.resizeCount = 0;
      window.on('resize', () => { global.resizeCount++; }); return window.getBounds();
    });
    await page.locator('#pet').click(); await page.locator('#panel').waitFor({ state: 'visible' });
    assert.deepEqual(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds()), bounds);
    assert.equal(await application.evaluate(() => global.resizeCount), 0);
    assert.ok(await page.locator('#art').evaluate(el => el.getAnimations().length > 0), 'pet plays jelly animation');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('#collapse').click();
    await page.locator('#pet').evaluate(el => el.click());
    await page.locator('#panel').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.getElementById('art').getAnimations().length);
    assert.equal(await page.locator('#panel').evaluate(el => getComputedStyle(el).animationName), 'none');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.locator('#draft').fill('Pet smoke draft');
    await page.waitForFunction(() => document.getElementById('draft').value === 'Pet smoke draft');
    await page.locator('#send').click(); await page.waitForFunction(() => document.getElementById('send').textContent === '停止');
    assert.equal(await page.locator('#draft').inputValue(), '');
    await page.locator('#send').click();
    await application.evaluate(() => { global.rejectInput = true; });
    await page.locator('#draft').fill('Retained after failure');
    await page.waitForFunction(() => document.getElementById('error').textContent.includes('Temporary input failure'));
    assert.equal(await page.locator('#draft').inputValue(), 'Retained after failure');
    await page.locator('#send').click(); await page.waitForFunction(() => document.getElementById('send').textContent === '停止');
    await page.locator('#send').click();
    await page.locator('#dictation').click(); await page.getByRole('button', { name: '停止输入', exact: true }).waitFor();
    await page.locator('#dictation').click(); await page.locator('#call').click();
    await page.locator('#mute').waitFor({ state: 'visible' }); await page.locator('#mute').click();
    assert.equal(await page.locator('#mute').innerText(), '取消静音');
    // Replies are separate from the composer, including while it is collapsed.
    await application.evaluate(() => {
      global.petState.busy = true;
      global.petState.reply = { text: 'Thinking\n'.repeat(12), thinking: true, options: [] };
      global.pet.update(global.petState);
    });
    await page.locator('#collapse').click();
    await page.locator('#bubble').waitFor({ state: 'visible' });
    assert.ok(await page.locator('#reply').evaluate(el => el.clientHeight <= 60));
    await application.evaluate(() => {
      global.petState.busy = false;
      global.petState.reply = { text: Array.from({ length: 24 }, (_, i) => `Reply line ${i + 1}`).join('\n'), options: [{ icon: '▶️', text: 'Try again' }] };
      global.pet.update(global.petState);
    });
    await page.getByRole('button', { name: '▶️ Try again', exact: true }).waitFor();
    assert.equal(await page.locator('#reply').innerText(), Array.from({ length: 24 }, (_, i) => `Reply line ${i + 1}`).join('\n'));
    assert.ok(await page.locator('#reply').evaluate(el => el.clientHeight <= 200 && el.scrollHeight > el.clientHeight));
    assert.equal(await page.locator('#title').count(), 0);
    await page.getByRole('button', { name: '▶️ Try again', exact: true }).click();
    assert.equal(await application.evaluate(() => global.petState.messages.at(-1).content), 'Try again');
    await page.locator('#pet').click();
    if (process.env.PET_SCREENSHOT) await page.screenshot({ path: process.env.PET_SCREENSHOT });
    await application.evaluate(() => global.pet.hide(true));
    assert.equal(await application.evaluate(() => global.petState.voice.active), false);
    await application.evaluate(() => global.pet.show());
    await page.locator('#panel').waitFor({ state: 'hidden' });
    await page.locator('#pet').click({ button: 'right' });
    assert.equal(await application.evaluate(() => global.menuShown), true);
    assert.equal(await page.locator('#panel').isVisible(), false);
    await application.evaluate(() => {
      global.petMenu.closePopup(); global.petMenuItems.find(item => item.label === '完全退出…').click();
    });
    await page.getByRole('alertdialog').waitFor({ state: 'visible' });
    await page.getByText('工作助手（飞书、钉钉）', { exact: true }).waitFor();
    assert.equal(await application.evaluate(() => global.quitRequested || 0), 0);
    const exitBox = await page.locator('#exit-bubble').boundingBox(), petBox = await page.locator('#pet').boundingBox();
    assert.ok(exitBox.y + exitBox.height <= petBox.y, 'exit confirmation appears above pet');
    if (process.env.PET_EXIT_SCREENSHOT) await page.locator('#stack').screenshot({ path: process.env.PET_EXIT_SCREENSHOT });
    await page.getByRole('button', { name: '继续运行', exact: true }).click();
    await page.getByRole('alertdialog').waitFor({ state: 'hidden' });
    await application.evaluate(() => global.petMenuItems.find(item => item.label === '完全退出…').click());
    await page.getByRole('button', { name: '确认退出', exact: true }).click();
    assert.equal(await application.evaluate(() => global.quitRequested), 1);
    await application.evaluate(() => {
      global.petMenu.closePopup();
      global.petMenuItems.find(item => item.label === '大小').submenu.find(item => item.label.startsWith('2×')).click();
      global.petMenuItems.find(item => item.label === '外观').submenu.find(item => item.label === '抱抱龙').click();
    });
    await page.waitForFunction(() => document.getElementById('art').getBoundingClientRect().width === 224);
    assert.deepEqual(await application.evaluate(() => global.savedPreferences), { scale: 2, appearance: 'dragon' });
    await application.evaluate(() => global.petMenuItems.find(item => item.label === '隐藏桌面宠物').click());
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
    await application.evaluate(() => global.pet.show());
    await page.locator('#reply').click();
    assert.equal(await application.evaluate(() => !!global.opened), true);
    assert.deepEqual(errors, []);
    console.log('Native pet UI: stable click bounds, jelly/reduced motion, right-click menu, saved size/appearance, input, voice fixtures, hide/show and reopen passed.');
  } finally {
    if (application) await application.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
