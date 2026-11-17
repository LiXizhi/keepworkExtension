const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const host = path.resolve(__dirname, '../windows/cef-host');
const bridgeScript = fs.readFileSync(path.join(host, 'pet_bridge.js'), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let index = 0; index < 4; index++) await new Promise(setImmediate); };

function bridgeFixture({ accepted = true } = {}) {
  let dispatch;
  const calls = [], events = new Map();
  const window = {
    __keepworkPetTransport(kind, payload) {
      if (kind === 'register') dispatch = payload;
      else calls.push({ kind, payload });
      return kind !== 'pick-folder' || accepted;
    },
    addEventListener(type, listener) { events.set(type, listener); },
  };
  vm.runInNewContext(bridgeScript, { window });
  return {
    bridge: window.aichatDesktop, calls,
    connect: () => dispatch('connect', 'document-challenge'),
    picked: value => dispatch('folder-picked', typeof value === 'string' ? value : JSON.stringify({ path: '', error: '', ...value })),
    dispose: () => events.get('pagehide')(),
    requests: () => calls.filter(call => call.kind === 'pick-folder'),
  };
}

test('CEF folder picker advertises only path selection and requires its document connection', async () => {
  const f = bridgeFixture();
  assert.equal(f.bridge.version, 1);
  assert.equal(f.bridge.capabilities.nativeFolderPickerVersion, 1);
  assert.equal(f.bridge.capabilities.files, undefined, 'path selection cannot switch AIChat file IO to an unimplemented Bridge');
  assert.equal(f.bridge.roots, undefined);
  assert.equal(f.bridge.file, undefined);
  await assert.rejects(f.bridge.pickFolder());
  assert.deepEqual(f.requests(), []);
  f.connect();
  const pending = f.bridge.pickFolder();
  const requestId = f.requests()[0]?.payload;
  assert.equal(typeof requestId, 'string');
  assert.ok(requestId.length > 0 && requestId.length <= 160);
  const selected = 'C:\\用户资料\\My Brain';
  f.picked({ requestId, path: selected });
  assert.deepEqual(copy(await pending), { path: selected });
});

test('CEF folder picker has one pending native dialog and ignores unrelated or duplicate results', async () => {
  const f = bridgeFixture(); f.connect();
  let finished = false;
  const first = f.bridge.pickFolder();
  first.then(() => { finished = true; });
  const duplicate = f.bridge.pickFolder();
  // A second caller may receive the same result or an explicit busy rejection;
  // it must never open another native dialog while the first is pending.
  const second = Promise.resolve(duplicate).then(value => ({ value }), error => ({ error }));
  assert.equal(f.requests().length, 1);
  const requestId = f.requests()[0].payload;
  for (const value of ['not-json', {}, { requestId: 'other-document', path: 'C:\\wrong' }]) f.picked(value);
  await settle(); assert.equal(finished, false);
  f.picked({ requestId, path: '\\\\server\\team share\\脑' });
  assert.deepEqual(copy(await first), { path: '\\\\server\\team share\\脑' });
  await second;
  f.picked({ requestId, path: 'C:\\duplicate' });
  const next = f.bridge.pickFolder();
  assert.equal(f.requests().length, 2);
  assert.notEqual(f.requests()[1].payload, requestId);
  f.picked({ requestId, path: 'C:\\late-result' });
  f.picked({ requestId: f.requests()[1].payload, path: '' });
  assert.equal(await next, null);
});

test('CEF folder picker cancellation preserves null and native errors allow a fresh request', async () => {
  const f = bridgeFixture(); f.connect();
  const cancelled = f.bridge.pickFolder();
  f.picked({ requestId: f.requests()[0].payload, path: '' });
  assert.equal(await cancelled, null);
  const failed = f.bridge.pickFolder();
  const failure = assert.rejects(failed, /system dialog unavailable/);
  f.picked({ requestId: f.requests()[1].payload, error: 'system dialog unavailable' });
  await failure;
  const retry = f.bridge.pickFolder();
  f.picked({ requestId: f.requests()[2].payload, path: 'D:\\正常路径' });
  assert.deepEqual(copy(await retry), { path: 'D:\\正常路径' });
});

test('CEF folder picker native transport rejection releases its pending request', async () => {
  const f = bridgeFixture({ accepted: false }); f.connect();
  await assert.rejects(f.bridge.pickFolder());
  await assert.rejects(f.bridge.pickFolder());
  assert.equal(f.requests().length, 2, 'a failed dispatch must not retain the busy slot');
});

test('CEF navigation resolves a pending folder selection without accepting the old document result', async () => {
  const f = bridgeFixture(); f.connect();
  const pending = f.bridge.pickFolder(), requestId = f.requests()[0].payload;
  f.dispose();
  assert.equal(await pending, null);
  f.picked({ requestId, path: 'C:\\stale' });
  await assert.rejects(f.bridge.pickFolder());
  assert.equal(f.requests().length, 1);
});

// These IDs and nesting match the independently shipped AIChat workspace picker.
// Its existing validation handler is represented by a recorder: this fixture
// verifies adapter ownership and selected-path handoff, not live MCP file IO.
const pickerMarkup = `<!doctype html><meta charset="utf-8">
<style>.hidden,[hidden]{display:none!important}</style>
<div id="spacePickerModal" class="space-modal-overlay">
  <div class="space-modal-box"><div class="space-modal-head">
    <button id="spacePickerBack" type="button">返回</button>
    <h3 id="spacePickerTitle">工作空间 - 本地文件夹</h3>
    <button id="spacePickerClose" type="button">关闭</button>
  </div><div class="space-modal-body">
    <div id="spacePickerLevelLocal" class="space-level" data-space-panel="local">
      <span id="spacePickerLocalHead">本地文件夹「Existing」</span>
      <button id="spacePickerLocalBrowse" type="button">浏览本机文件夹…</button>
      <p id="spacePickerLocalIntro">在 AIChat 中浏览常用位置或已连接的文件夹。</p>
      <div id="spacePickerLocalCompanion" hidden></div>
      <details id="spacePickerLocalManual"><summary>手动填写路径</summary>
        <input id="spacePickerLocalAbsPath" value="C:\\Existing">
        <p id="spacePickerLocalAbsHelp">路径由 MCP 验证</p>
        <p id="spacePickerLocalAbsHint" hidden></p>
        <div id="spacePickerLocalAbsError" style="display:none"></div>
        <button id="spacePickerLocalUse" type="button">保存路径并使用</button>
      </details>
    </div>
  </div></div>
</div>`;

test('CEF native folder adapter handles real user clicks and discards stale workspace selections', {
  skip: process.env.KEEPWORK_CEF_BROWSER_TESTS !== '1', timeout: 60000,
}, async t => {
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ channel: process.env.KEEPWORK_CEF_BROWSER_CHANNEL || 'chrome', headless: true });
  t.after(() => browser.close());
  const adapter = fs.readFileSync(path.join(host, 'folder_picker.js'), 'utf8');
  async function pageFixture({ incomplete = false, verificationError = '' } = {}) {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://keepwork.com/**', route => route.fulfill({ contentType: 'text/html', body: pickerMarkup }));
    await page.goto('https://keepwork.com/chat');
    await page.evaluate(({ incomplete, verificationError }) => {
      window.folderFixture = { calls: 0, webCalls: 0, applied: [], verified: [], inputEvents: 0, verificationError };
      window.aichatDesktop = Object.freeze({ version: 1,
        capabilities: Object.freeze({ nativeFolderPickerVersion: 1 }),
        pickFolder() {
          folderFixture.calls++;
          return new Promise((resolve, reject) => { folderFixture.complete = resolve; folderFixture.fail = reject; });
        },
      });
      document.querySelector('#spacePickerLocalBrowse').addEventListener('click', () => folderFixture.webCalls++);
      const input = document.querySelector('#spacePickerLocalAbsPath');
      input.addEventListener('input', () => folderFixture.inputEvents++);
      document.querySelector('#spacePickerLocalUse').addEventListener('click', async () => {
        // Preserve the published handler's order: verify the selected absolute
        // path through MCP before mutating its workspace binding.
        const path = input.value;
        folderFixture.verified.push(path);
        await Promise.resolve();
        if (folderFixture.verificationError) {
          const error = document.querySelector('#spacePickerLocalAbsError');
          error.textContent = folderFixture.verificationError; error.style.display = '';
          return;
        }
        folderFixture.applied.push(path);
      });
      if (incomplete) document.querySelector('#spacePickerLocalUse').remove();
    }, { incomplete, verificationError });
    await page.addScriptTag({ content: adapter });
    return { page, errors };
  }
  const selected = async (page, path) => {
    await page.evaluate(path => folderFixture.complete(path ? { path } : null), path);
    await page.evaluate(async () => { await Promise.resolve(); await Promise.resolve(); });
  };

  await t.test('selection replaces the draft path and invokes existing validation without input-change side effects', async () => {
    const { page, errors } = await pageFixture();
    await page.locator('#spacePickerLocalBrowse').click();
    assert.deepEqual(await page.evaluate(() => ({ calls: folderFixture.calls, webCalls: folderFixture.webCalls })), { calls: 1, webCalls: 0 });
    const path = 'C:\\用户资料\\My Brain';
    await selected(page, path);
    assert.deepEqual(await page.evaluate(() => ({ paths: folderFixture.applied, inputs: folderFixture.inputEvents })), { paths: [path], inputs: 0 });
    assert.equal(await page.locator('#spacePickerLocalBrowse').isDisabled(), false);
    assert.deepEqual(errors, []); await page.close();
  });
  await t.test('cancellation keeps the existing binding and re-enables the browse button', async () => {
    const { page, errors } = await pageFixture();
    await page.locator('#spacePickerLocalBrowse').click();
    await selected(page, null);
    assert.equal(await page.locator('#spacePickerLocalAbsPath').inputValue(), 'C:\\Existing');
    assert.deepEqual(await page.evaluate(() => folderFixture.applied), []);
    assert.equal(await page.locator('#spacePickerLocalBrowse').isDisabled(), false);
    assert.deepEqual(errors, []); await page.close();
  });
  await t.test('existing MCP verification failure stays visible and prevents workspace binding', async () => {
    const { page, errors } = await pageFixture({ verificationError: '文件夹不存在：C:\\missing' });
    await page.locator('#spacePickerLocalBrowse').click();
    await selected(page, 'C:\\missing');
    assert.deepEqual(await page.evaluate(() => ({ verified: folderFixture.verified, applied: folderFixture.applied })), {
      verified: ['C:\\missing'], applied: [],
    });
    await page.locator('#spacePickerLocalAbsError').waitFor({ state: 'visible' });
    assert.match(await page.locator('#spacePickerLocalAbsError').textContent(), /文件夹不存在/);
    assert.deepEqual(errors, []); await page.close();
  });
  await t.test('native dialog failure remains visible and a subsequent click can retry', async () => {
    const { page, errors } = await pageFixture();
    await page.locator('#spacePickerLocalBrowse').click();
    await page.evaluate(() => folderFixture.fail(Error('System folder picker unavailable')));
    await page.locator('#spacePickerLocalAbsError').waitFor({ state: 'visible' });
    assert.match(await page.locator('#spacePickerLocalAbsError').textContent(), /System folder picker unavailable/);
    assert.equal(await page.locator('#spacePickerLocalBrowse').isDisabled(), false);
    await page.locator('#spacePickerLocalBrowse').click();
    assert.equal(await page.evaluate(() => folderFixture.calls), 2);
    await selected(page, 'D:\\retry');
    assert.deepEqual(await page.evaluate(() => folderFixture.applied), ['D:\\retry']);
    assert.deepEqual(errors, []); await page.close();
  });
  for (const change of ['health-notice', 'intro', 'details', 'visual-styles', 'same-target-preparation']) {
    for (const outcome of ['selection', 'native-error']) {
      await t.test(`${change} updates preserve a pending native ${outcome}`, async () => {
        const { page, errors } = await pageFixture();
        await page.locator('#spacePickerLocalBrowse').click();
        await page.evaluate(change => {
          const $ = id => document.getElementById(id);
          if (change === 'health-notice') {
            // A delayed refreshLocalCompanionNotice() only changes status UI.
            $('spacePickerLocalCompanion').innerHTML = '<strong>本地服务已连接</strong>';
            $('spacePickerLocalCompanion').hidden = false;
          } else if (change === 'intro') {
            $('spacePickerLocalIntro').textContent = '在 AIChat 中浏览常用位置或已连接的文件夹。';
          } else if (change === 'details') {
            $('spacePickerLocalManual').open = true;
          } else if (change === 'visual-styles') {
            $('spacePickerModal').classList.add('is-updating');
            $('spacePickerLevelLocal').style.borderColor = 'rgb(1, 2, 3)';
          } else {
            // prepareLocalPanel() refreshes these nodes even if the target and
            // path remain identical. Their new text nodes are presentation IO.
            $('spacePickerLocalHead').textContent = '本地文件夹「Existing」';
            $('spacePickerLocalUse').className = 'prompt-ghost-btn';
            $('spacePickerLocalUse').textContent = '保存路径并使用';
          }
        }, change);
        if (outcome === 'selection') {
          const path = 'D:\\用户资料\\My Brain';
          await selected(page, path);
          assert.deepEqual(await page.evaluate(() => ({ verified: folderFixture.verified, applied: folderFixture.applied })), {
            verified: [path], applied: [path],
          }, 'presentation changes cannot discard the user-selected path');
        } else {
          await page.evaluate(() => folderFixture.fail(Error('System folder picker unavailable')));
          await page.locator('#spacePickerLocalAbsError').waitFor({ state: 'visible' });
          assert.match(await page.locator('#spacePickerLocalAbsError').textContent(), /System folder picker unavailable/);
          assert.deepEqual(await page.evaluate(() => folderFixture.applied), []);
        }
        assert.equal(await page.locator('#spacePickerLocalBrowse').isDisabled(), false);
        assert.deepEqual(errors, []); await page.close();
      });
    }
  }
  await t.test('a pending path validation explains the busy state and browsing can retry after it finishes', async () => {
    const { page, errors } = await pageFixture();
    await page.evaluate(() => document.querySelector('#spacePickerLocalUse').disabled = true);
    await page.locator('#spacePickerLocalBrowse').click();
    assert.deepEqual(await page.evaluate(() => ({ calls: folderFixture.calls, webCalls: folderFixture.webCalls })), { calls: 0, webCalls: 0 });
    await page.locator('#spacePickerLocalAbsError').waitFor({ state: 'visible' });
    assert.match(await page.locator('#spacePickerLocalAbsError').textContent(), /验证|处理|稍候|稍后|忙/);
    assert.equal(await page.locator('#spacePickerLocalBrowse').isDisabled(), false);
    await page.evaluate(() => document.querySelector('#spacePickerLocalUse').disabled = false);
    await page.locator('#spacePickerLocalBrowse').click();
    assert.equal(await page.evaluate(() => folderFixture.calls), 1);
    await selected(page, 'D:\\retry');
    assert.deepEqual(await page.evaluate(() => folderFixture.applied), ['D:\\retry']);
    assert.deepEqual(errors, []); await page.close();
  });
  await t.test('a selection arriving during path validation stays visible for explicit validation after the busy operation', async () => {
    const { page, errors } = await pageFixture();
    await page.locator('#spacePickerLocalBrowse').click();
    await page.evaluate(() => document.querySelector('#spacePickerLocalUse').disabled = true);
    const path = 'D:\\用户资料\\Selected';
    await selected(page, path);
    assert.equal(await page.locator('#spacePickerLocalAbsPath').inputValue(), path);
    assert.equal(await page.locator('#spacePickerLocalUse').isDisabled(), true, 'the adapter cannot release another operation\'s busy state');
    assert.deepEqual(await page.evaluate(() => ({ verified: folderFixture.verified, applied: folderFixture.applied })), { verified: [], applied: [] });
    await page.locator('#spacePickerLocalAbsError').waitFor({ state: 'visible' });
    assert.match(await page.locator('#spacePickerLocalAbsError').textContent(), /路径已选中|验证/);
    await page.evaluate(() => document.querySelector('#spacePickerLocalUse').disabled = false);
    await page.locator('#spacePickerLocalUse').click();
    assert.deepEqual(await page.evaluate(() => folderFixture.applied), [path]);
    assert.deepEqual(errors, []); await page.close();
  });
  await t.test('an async preparation changing the target explains the discarded result and allows a fresh selection', async () => {
    const { page, errors } = await pageFixture();
    await page.evaluate(() => document.querySelector('#spacePickerLocalHead').textContent = '📁 选择本地文件夹');
    await page.locator('#spacePickerLocalBrowse').click();
    await page.evaluate(() => {
      document.querySelector('#spacePickerLocalHead').textContent = '📁 本地文件夹「Existing」';
      document.querySelector('#spacePickerLocalUse').textContent = '保存路径并使用';
    });
    await selected(page, 'C:\\stale');
    assert.deepEqual(await page.evaluate(() => folderFixture.applied), []);
    assert.equal(await page.locator('#spacePickerLocalAbsPath').inputValue(), 'C:\\Existing');
    await page.locator('#spacePickerLocalAbsError').waitFor({ state: 'visible' });
    assert.match(await page.locator('#spacePickerLocalAbsError').textContent(), /工作空间|路径已变化|重新选择/);
    await page.locator('#spacePickerLocalBrowse').click();
    await selected(page, 'D:\\retry');
    assert.deepEqual(await page.evaluate(() => folderFixture.applied), ['D:\\retry']);
    assert.deepEqual(errors, []); await page.close();
  });
  for (const change of ['close-and-reopen', 'back', 'back-and-return', 'visibility', 'edit-target', 'edit-target-roundtrip', 'workspace-id', 'input', 'replace-controls', 'replace-validation-control', 'pagehide']) {
    await t.test(`a pending native result cannot bind after ${change}`, async () => {
      const { page, errors } = await pageFixture();
      await page.locator('#spacePickerLocalBrowse').click();
      await page.evaluate(change => {
        const modal = document.querySelector('#spacePickerModal');
        if (change === 'close-and-reopen') {
          modal.classList.add('hidden'); modal.classList.remove('hidden');
        } else if (change === 'back') {
          document.querySelector('#spacePickerBack').click();
          document.querySelector('#spacePickerLevelLocal').classList.add('hidden');
        } else if (change === 'back-and-return') {
          const panel = document.querySelector('#spacePickerLevelLocal');
          panel.classList.add('hidden'); panel.classList.remove('hidden');
        } else if (change === 'visibility') {
          document.querySelector('#spacePickerLevelLocal').style.visibility = 'hidden';
        } else if (change === 'edit-target') {
          document.querySelector('#spacePickerLocalHead').textContent = '本地文件夹「Another」';
        } else if (change === 'edit-target-roundtrip') {
          const head = document.querySelector('#spacePickerLocalHead');
          const original = head.textContent;
          head.textContent = '本地文件夹「Another」'; head.textContent = original;
        } else if (change === 'workspace-id') {
          modal.dataset.workspaceId = 'another-workspace';
        } else if (change === 'input') {
          document.querySelector('#spacePickerLocalAbsPath').value = 'C:\\Other workspace';
        } else if (change === 'replace-controls') {
          modal.replaceWith(modal.cloneNode(true));
        } else if (change === 'replace-validation-control') {
          const use = document.querySelector('#spacePickerLocalUse');
          use.replaceWith(use.cloneNode(true));
        } else window.dispatchEvent(new PageTransitionEvent('pagehide'));
      }, change);
      await selected(page, 'C:\\stale');
      assert.deepEqual(await page.evaluate(() => folderFixture.applied), []);
      assert.notEqual(await page.locator('#spacePickerLocalAbsPath').inputValue(), 'C:\\stale');
      assert.deepEqual(errors, []); await page.close();
    });
  }
  await t.test('unknown page controls and synthetic clicks keep the existing page handler', async () => {
    for (const incomplete of [false, true]) {
      const { page, errors } = await pageFixture({ incomplete });
      if (incomplete) await page.locator('#spacePickerLocalBrowse').click();
      else await page.evaluate(() => document.querySelector('#spacePickerLocalBrowse').click());
      assert.deepEqual(await page.evaluate(() => ({ calls: folderFixture.calls, webCalls: folderFixture.webCalls })), { calls: 0, webCalls: 1 });
      assert.deepEqual(errors, []); await page.close();
    }
  });
});
