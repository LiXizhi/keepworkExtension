const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const { chromium, _electron: electron } = require('playwright-core');
const fs = require('node:fs/promises');
const path = require('node:path');
const execute = promisify(execFile);

module.exports = async function verifyChromiumEditor(host, diagnostic, electronFixture) {
  const marker = 'keepwork-fixture-' + randomUUID();
  let owner;
  try {
    let page;
    if (electronFixture) {
      const { executablePath, directory } = electronFixture;
      const main = path.join(directory, 'editor.cjs');
      await fs.writeFile(main, `const { app, BrowserWindow } = require('electron');
        app.whenReady().then(() => { global.fixture = new BrowserWindow({show: true});
        fixture.loadURL('about:blank'); fixture.show(); fixture.focus(); });`);
      owner = await electron.launch({ executablePath, args: ['--user-data-dir=' + directory,
        ...(electronFixture.cold ? [] : ['--force-renderer-accessibility']), main] });
      page = await owner.firstWindow();
      await owner.evaluate(({ app, BrowserWindow }) => {
        app.focus({ steal: true });
        BrowserWindow.getAllWindows()[0].focus();
      });
    } else {
      // launchServer uses a fresh temporary profile and exposes the exact
      // browser PID that the native fixture may address.
      owner = await chromium.launchServer({
        channel: 'chrome', headless: false, args: ['--force-renderer-accessibility'],
      });
      const browser = await chromium.connect(owner.wsEndpoint());
      page = await browser.newPage();
    }
    await page.setContent(`<div id="editor" class="ProseMirror" contenteditable="true" role="textbox" aria-label="${marker}" aria-multiline="true">
      <p>Before <strong>selected</strong> text</p><p>Second paragraph</p></div>
      <output id="draft"></output><input id="other" value="untouched">
      <script>
        const model = {text: editor.innerText};
        const render = () => { draft.textContent = model.text; };
        render();
        window.edits = [];
        editor.addEventListener('input', e => {
          edits.push([e.isTrusted, e.inputType]);
          model.text = editor.innerText;
          render();
        });
      </script>`);
    await page.bringToFront();
    if (electronFixture?.paste) {
      const ack = path.join(electronFixture.directory, 'paste-ack');
      await page.exposeFunction('ackPaste', () => fs.writeFile(ack, ''));
      await page.evaluate(() => {
        editor.replaceChildren();
        editor.focus();
        editor.addEventListener('paste', event => {
          // The actual native Cmd+V must reach this editor. Supply test text
          // without observing or modifying the user's general pasteboard.
          event.preventDefault();
          if (event.isTrusted && document.activeElement === editor) {
            document.execCommand('insertText', false, 'Dictated without a click');
            window.ackPaste();
          }
        }, { once: true });
      });
      const result = await execute(host, [electronFixture.wrapper ? 'paste-back-wrapper' : 'paste-back',
        String(owner.process().pid), marker, electronFixture.immediate ? 'in-flight' : ack], { timeout: 9000 });
      diagnostic(result.stderr.trim() + "\n" + result.stdout.trim());
      const after = await page.evaluate(() => ({ model: draft.textContent.trim(), dom: editor.innerText.trim(),
        events: window.edits, focus: document.activeElement === editor, other: other.value }));
      assert.deepEqual(after, {model: '', dom: '', events: [[true,'insertText'],[true,'deleteContentBackward']],
        focus: true, other: 'untouched'}, 'real paste followed immediately by Back, without clicking');
      assert.match(result.stdout, /Chrome Back status 0/);
      await page.keyboard.press('Meta+z');
      assert.equal(await page.locator('#draft').textContent().then(text => text.trim()), 'Dictated without a click');
      return;
    }
    await page.locator('#editor').click();
    await page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('strong'));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    });
    const state = () => page.evaluate(() => ({
      dom: editor.innerText.trim(), model: draft.textContent.trim(), events: window.edits,
      selection: getSelection().toString(), focused: document.activeElement === editor, sentinel: other.value,
    }));
    const before = await state();
    assert.equal(before.selection, 'selected');
    assert.equal(before.model, before.dom);
    assert.ok(before.model.includes('Second paragraph') && before.focused);
    const back = () => execute(host, [electronFixture?.cold ? 'cold-chromium' : 'chrome', String(owner.process().pid), marker], { timeout: 9000 });
    const result = await back();
    diagnostic(result.stderr.trim() + '\n' + result.stdout.trim());
    await page.waitForFunction(() => !editor.innerText.trim() && !draft.textContent.trim(), undefined, { timeout: 1500 })
      .catch(() => {});
    const after = await state();
    assert.deepEqual({model: after.model, dom: after.dom, focused: after.focused, sentinel: after.sentinel},
      {model: '', dom: '', focused: true, sentinel: 'untouched'}, 'Back clears the whole editor and updates its draft model');
    assert.deepEqual(after.events, [[true, 'deleteContentBackward']], 'the editor receives one trusted deletion');
    const again = await back();
    assert.match(again.stdout, /Chrome Back status 0/, 'an already empty rich editor stays empty');
    assert.deepEqual((await state()).events, after.events, 'a second Back generates no additional input event');
    await page.keyboard.press('Meta+z');
    await page.waitForFunction(text => draft.textContent.trim() === text, before.model, { timeout: 1500 });
    assert.equal((await state()).dom, before.dom, 'one Undo restores the full draft');
    assert.match(result.stdout, /Chrome Back status 0/);
    await page.keyboard.press('Meta+a');
    await page.keyboard.type('x');
    assert.equal((await state()).model, 'x');
    const single = await back();
    assert.match(single.stdout, /Chrome Back status 0/, 'one character of real text is cleared');
    assert.equal((await state()).model, '');
    await page.keyboard.press('Meta+z');
    assert.equal((await state()).model, 'x');
  } finally {
    await owner?.close();
  }
};
