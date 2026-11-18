const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const host = path.resolve(__dirname, '../windows/cef-host');
const read = name => fs.readFileSync(path.join(host, name), 'utf8');
const polyfill = () => read('vendor/popover.iife.min.js');

test('vendored Popover implementation retains its pinned upstream identity and BSD license', () => {
  const provenance = JSON.parse(read('vendor/provenance.json'));
  assert.equal(provenance.name, '@oddbird/popover-polyfill');
  assert.equal(provenance.version, '0.7.3');
  assert.equal(provenance.license, 'BSD-3-Clause');
  assert.equal(crypto.createHash('sha256').update(polyfill()).digest('hex'), provenance.scriptSha256);
  assert.equal(provenance.scriptSha256, '4f9e822461fff46ab3ce3c37148b900a8d2f29ee84217e0c467bf78d0bff9088');
  assert.match(read('vendor/LICENSE.txt'), /Redistribution and use in source and binary forms/);
  assert.match(read('CMakeLists.txt'), /popover-polyfill-LICENSE\.txt/,
    'binary CEF distribution must retain third-party attribution');
});

test('Windows autocrlf checkout preserves the pinned Popover bytes with an unprotected negative control', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-popover-checkout-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const relative = 'apps/aichat-rust/windows/cef-host/vendor';
  const attributes = fs.readFileSync(path.resolve(__dirname, '../../../.gitattributes'));
  const expectedHash = JSON.parse(read('vendor/provenance.json')).scriptSha256;
  for (const protectedBytes of [true, false]) {
    const repository = path.join(temporary, protectedBytes ? 'protected' : 'control');
    fs.mkdirSync(repository);
    fs.writeFileSync(path.join(repository, '.gitattributes'), protectedBytes ? attributes : '# no upstream byte protection\n');
    fs.cpSync(path.join(host, 'vendor'), path.join(repository, relative), { recursive: true });
    const git = args => execFileSync('git', ['-c', 'core.autocrlf=true', '-c', 'core.safecrlf=false', ...args],
      { cwd: repository, stdio: ['ignore', 'pipe', 'pipe'] });
    git(['init', '--quiet']);
    git(['add', '--', '.gitattributes', relative]);
    fs.rmSync(path.join(repository, relative), { recursive: true });
    git(['checkout-index', '--all', '--force']);
    const checkedOut = path.join(repository, relative);
    const script = fs.readFileSync(path.join(checkedOut, 'popover.iife.min.js'));
    const digest = crypto.createHash('sha256').update(script).digest('hex');
    if (protectedBytes) {
      assert.equal(digest, expectedHash);
      for (const name of fs.readdirSync(path.join(host, 'vendor')))
        assert.deepEqual(fs.readFileSync(path.join(checkedOut, name)), fs.readFileSync(path.join(host, 'vendor', name)), name);
    } else {
      assert.ok(script.includes(Buffer.from('\r\n')));
      assert.notEqual(digest, expectedHash, 'the pinned integrity gate must reject rewritten bytes');
    }
  }
});

test('Windows bootstrap and legacy CEF embed a real multiresolution Keepwork icon', () => {
  const icon = fs.readFileSync(path.resolve(__dirname, '../src-tauri/icons/icon.ico'));
  assert.equal(icon.readUInt16LE(0), 0);
  assert.equal(icon.readUInt16LE(2), 1, 'ICO rather than a renamed bitmap');
  const sizes = [];
  for (let index = 0; index < icon.readUInt16LE(4); index++) {
    const offset = 6 + index * 16;
    const size = icon.readUInt32LE(offset + 8), start = icon.readUInt32LE(offset + 12);
    assert.ok(size > 0 && start + size <= icon.length, 'each resolution has actual image bytes');
    sizes.push(icon[offset] || 256);
  }
  for (const size of [16, 32, 48, 256]) assert.ok(sizes.includes(size), `missing ${size}px shell icon`);
  for (const resource of ['../launcher.rc.in', 'keepwork-cef.rc.in']) {
    assert.match(read(resource), /101\s+ICON\s+"[^"\n]*icon\.ico"/,
      `${resource} must embed the product icon as the first icon group`);
  }
  const bootstrap = read('../CMakeLists.txt'), cef = read('CMakeLists.txt');
  assert.match(bootstrap, /launcher\.rc/);
  assert.match(bootstrap, /add_executable\(Keepwork[^)]*launcher\.rc/s, 'launcher resource must enter the EXE');
  assert.match(cef, /add_executable\(\$\{CEF_TARGET\}[^)]*keepwork-cef\.rc/s);
  assert.doesNotMatch(read('window_frame.h'), /LoadIconW\(nullptr,\s*IDI_APPLICATION\)/,
    'the actual CEF window must not request the generic Windows application icon');
});

test('CEF 109 installs the compatibility script in the renderer before page scripts, within the main Keepwork document', () => {
  const source = read('main.cpp');
  assert.match(source, /CefRenderProcessHandler/);
  const context = source.match(/void OnContextCreated\([\s\S]*?\n  \}/)?.[0];
  assert.ok(context, 'renderer context callback is required; load-end injection is too late');
  assert.match(context, /CEF_VERSION_MAJOR\s*==\s*109/, 'modern CEF keeps its native implementation');
  assert.match(context, /browser->IsPopup\(\)/);
  assert.match(context, /frame->IsMain\(\)/);
  assert.match(context, /Https\(/);
  assert.match(context, /host\s*[!=]=\s*"keepwork\.com"/);
  assert.match(context, /ExecuteJavaScript\([^;]*kPopoverScript/s);
  assert.match(source, /CefExecuteProcess\(args,\s*(?!nullptr)[a-zA-Z_][\w]*,\s*sandbox_info\)/,
    'renderer subprocesses must receive the render-process handler');
  assert.doesNotMatch(polyfill(), /aichatDesktop|__TAURI_INTERNALS__|CefMessageRouter|nativeCall/,
    'web compatibility cannot introduce desktop privileges');
  const cmake = read('CMakeLists.txt');
  assert.match(cmake, /popover\.iife\.min\.js/);
  assert.match(cmake, /configure_file\([^)]*compatibility_script\.h/s);
});

const browserFixture = `<!doctype html><meta charset="utf-8"><style>
  body { margin:0; background:#181818; color:white; font:14px sans-serif; }
  header { display:flex; align-items:center; height:46px; gap:8px; }
  #trigger { margin-left: 240px; }
  .session-pages-menu { position:fixed; inset:auto; margin:0; padding:6px;
    width:min(320px,calc(100vw - 16px)); border:1px solid #555; border-radius:12px; background:#333; }
  .session-pages-menu button { display:block; width:100%; padding:9px; }
</style><header><span>New chat</span><button id="trigger">All pages</button>
  <div id="pages" class="session-pages-menu" popover="auto"><button id="select">Chat page</button></div>
</header><input id="composer" value="keep this draft"><button id="outside">Outside</button>`;

test('Popover compatibility hides the empty header panel, supports page selection and leaves native browsers intact', {
  skip: process.env.KEEPWORK_CEF_BROWSER_TESTS !== '1', timeout: 60000,
}, async t => {
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({
    channel: process.env.KEEPWORK_CEF_BROWSER_CHANNEL || 'chrome', headless: true,
  });
  t.after(() => browser.close());
  for (const legacy of [false, true]) {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(browserFixture);
    await page.evaluate(legacy => {
      window.__beforeShow = HTMLElement.prototype.showPopover;
      window.__beforeMatches = Element.prototype.matches;
      window.__events = [];
      if (!legacy) return;
      for (const property of ['popover', 'showPopover', 'hidePopover', 'togglePopover']) {
        delete HTMLElement.prototype[property];
      }
      // An old browser has neither the UA popover hiding rule nor its selector.
      // Restore ordinary block rendering before installing the production shim.
      const style = document.createElement('style');
      style.textContent = '@layer legacy-ua-fixture, popover-polyfill; @layer legacy-ua-fixture { :where([popover]) { display:block } }';
      document.head.append(style);
      const rejectUnsupported = original => function(selector, ...args) {
        if (selector.includes(':popover-open') && !selector.includes('\\:popover-open')) {
          throw new DOMException('Unsupported :popover-open selector', 'SyntaxError');
        }
        return original.call(this, selector, ...args);
      };
      for (const [prototype, methods] of [
        [Element.prototype, ['matches', 'closest', 'querySelector', 'querySelectorAll']],
        [Document.prototype, ['querySelector', 'querySelectorAll']],
        [DocumentFragment.prototype, ['querySelector', 'querySelectorAll']],
      ]) for (const method of methods) prototype[method] = rejectUnsupported(prototype[method]);
    }, legacy);
    if (legacy) {
      assert.equal(await page.locator('#pages').isVisible(), true,
        'fixture must reproduce the unexpected header panel before the shim');
    }
    await page.addScriptTag({ content: polyfill() });
    await page.evaluate(() => { window.__installedShow = HTMLElement.prototype.showPopover; });
    await page.addScriptTag({ content: polyfill() });
    assert.equal(await page.evaluate(() => window.__installedShow === HTMLElement.prototype.showPopover), true,
      'a repeated context setup cannot double-install handlers or methods');
    await page.evaluate(() => {
      const menu = document.querySelector('#pages'), trigger = document.querySelector('#trigger');
      menu.addEventListener('toggle', event => window.__events.push(event.newState));
      trigger.addEventListener('click', () => {
        if (menu.matches(':popover-open')) { menu.hidePopover(); return; }
        menu.style.left = '200px'; menu.style.top = '52px';
        menu.showPopover(); menu.querySelector('button').focus();
      });
      document.querySelector('#select').addEventListener('click', () => {
        menu.hidePopover(); window.__selected = (window.__selected || 0) + 1;
      });
    });
    assert.equal(await page.locator('#pages').isVisible(), false, `${legacy ? 'legacy' : 'native'}: closed panel cannot occupy the header`);
    await page.locator('#trigger').click();
    assert.equal(await page.locator('#pages').isVisible(), true);
    assert.equal(await page.evaluate(() => document.querySelectorAll('.session-pages-menu:popover-open').length), 1);
    await page.locator('#select').click();
    assert.equal(await page.locator('#pages').isVisible(), false);
    assert.equal(await page.evaluate(() => window.__selected), 1, 'selection executes exactly once');
    await page.locator('#trigger').click();
    await page.locator('#outside').click();
    assert.equal(await page.locator('#pages').isVisible(), false, 'outside click dismisses auto popovers');
    await page.locator('#trigger').click();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#pages').isVisible(), false, 'Escape dismisses auto popovers');
    assert.equal(await page.locator('#composer').inputValue(), 'keep this draft');
    const state = await page.evaluate(() => ({
      nativeShowUnchanged: window.__beforeShow === HTMLElement.prototype.showPopover,
      nativeMatchesUnchanged: window.__beforeMatches === Element.prototype.matches,
      bridge: typeof window.aichatDesktop,
      events: window.__events,
    }));
    if (!legacy) {
      assert.equal(state.nativeShowUnchanged, true);
      assert.equal(state.nativeMatchesUnchanged, true);
    }
    assert.equal(state.bridge, 'undefined');
    assert.ok(state.events.includes('open') && state.events.includes('closed'));
    assert.deepEqual(errors, [], legacy ? 'legacy compatibility errors' : 'native compatibility errors');
    await page.screenshot({ path: path.join(os.tmpdir(), `keepwork-cef-popover-${legacy ? 'fallback' : 'native'}.png`) });
    await page.close();
  }
  const early = await browser.newPage();
  const earlyErrors = [];
  early.on('pageerror', error => earlyErrors.push(error.message));
  await early.addInitScript({ content: `
    for (const property of ['popover', 'showPopover', 'hidePopover', 'togglePopover']) {
      delete HTMLElement.prototype[property];
    }
    window.__headMissingAtInjection = document.head === null;
    ${polyfill()}
  ` });
  await early.goto('data:text/html,' + encodeURIComponent(`<!doctype html><script>
    window.__firstPageScriptHasPopover = typeof HTMLElement.prototype.showPopover === 'function';
  </script><div popover="auto" id="early-menu"></div>`));
  assert.deepEqual(await early.evaluate(() => ({
    beforeHead: window.__headMissingAtInjection,
    pageHasApi: window.__firstPageScriptHasPopover,
    closed: getComputedStyle(document.querySelector('#early-menu')).display === 'none',
    bridge: typeof window.aichatDesktop,
  })), { beforeHead: true, pageHasApi: true, closed: true, bridge: 'undefined' },
  'context-created injection works before document.head or application scripts exist');
  assert.deepEqual(earlyErrors, []);
  await early.close();
});
