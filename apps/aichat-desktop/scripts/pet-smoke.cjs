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
    const { app, BrowserWindow, ipcMain, screen } = require('electron');
    const { createPetWindow } = require(${JSON.stringify(path.join(source, 'petWindow.cjs'))});
    app.whenReady().then(() => {
      global.petState = { version: 1, context: 'smoke-chat', ready: true, title: '桌面宠物', draft: '', canCall: true, messages: [{ role: 'assistant', content: '你好！可以打字、语音输入，或打开 AIChat 继续。' }] };
      global.petCommands = [];
      global.pet = createPetWindow({ BrowserWindow, ipcMain, screen }, ${JSON.stringify(source)}, {
        position: () => null, savePosition: value => { global.savedPetPosition = value; },
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
          if (command.requestId) global.pet.result({ requestId: command.requestId, ok: true });
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
    await page.locator('#pet').click(); await page.locator('#panel').waitFor({ state: 'visible' });
    await page.locator('#draft').fill('Pet smoke draft');
    await page.waitForFunction(() => document.getElementById('draft').value === 'Pet smoke draft');
    await page.locator('#send').click(); await page.getByText('Pet smoke draft', { exact: true }).waitFor();
    assert.equal(await page.locator('#draft').inputValue(), '');
    await page.locator('#send').click();
    await application.evaluate(() => { global.rejectInput = true; });
    await page.locator('#draft').fill('Retained after failure');
    await page.waitForFunction(() => document.getElementById('error').textContent.includes('Temporary input failure'));
    assert.equal(await page.locator('#draft').inputValue(), 'Retained after failure');
    await page.locator('#send').click(); await page.getByText('Retained after failure', { exact: true }).waitFor();
    await page.locator('#send').click();
    await page.locator('#dictation').click(); await page.getByRole('button', { name: '停止输入', exact: true }).waitFor();
    await page.locator('#dictation').click(); await page.locator('#call').click();
    await page.locator('#mute').waitFor({ state: 'visible' }); await page.locator('#mute').click();
    assert.equal(await page.locator('#mute').innerText(), '取消静音');
    if (process.env.PET_SCREENSHOT) await page.screenshot({ path: process.env.PET_SCREENSHOT });
    await application.evaluate(() => global.pet.hide(true));
    assert.equal(await application.evaluate(() => global.petState.voice.active), false);
    await application.evaluate(() => global.pet.show());
    await page.locator('#panel').waitFor({ state: 'hidden' });
    await page.locator('#pet').click(); await page.locator('#open').click();
    assert.equal(await application.evaluate(() => !!global.opened), true);
    assert.deepEqual(errors, []);
    console.log('Native pet UI: transparency/topmost configuration, expand/collapse, input, send/stop, voice controls (fixture), hide/show and reopen passed.');
  } finally {
    if (application) await application.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
