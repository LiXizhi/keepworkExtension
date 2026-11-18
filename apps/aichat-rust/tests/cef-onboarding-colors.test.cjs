const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const host = path.resolve(__dirname, '../windows/cef-host');
const read = name => fs.readFileSync(path.join(host, name), 'utf8');
const colors = () => read('onboarding_colors.js');
function production() {
  return [...read('compatibility_script.h.in').matchAll(/R"([A-Za-z0-9_]*)\(([\s\S]*?)\)\1"/g)]
    .map(match => match[2]).join('')
    .replace('@KEEPWORK_POPOVER_SCRIPT@', read('vendor/popover.iife.min.js'))
    .replace('@KEEPWORK_SESSION_POPOVERS_SCRIPT@', read('session_popovers.js'))
    .replace('@KEEPWORK_ONBOARDING_COLORS_SCRIPT@', colors())
    .replace('@KEEPWORK_MENU_ICONS_SCRIPT@', read('menu_icons.js'));
}

test('legacy onboarding colors remain independent of the Popover capability and renderer privileges', () => {
  const script = production();
  assert.ok(script.indexOf(colors()) < script.indexOf('const nativePopover'),
    'color fallback must run even when the page already provides Popover');
  assert.doesNotMatch(script, /@KEEPWORK_[A-Z_]+@/, 'all configured production sources are present');
  assert.doesNotMatch(colors(), /aichatDesktop|__TAURI_INTERNALS__|nativeCall|CefMessageRouter|fetch\(/,
    'a visual fallback cannot add native privileges or network requests');
});

test('legacy color installation is limited to chat documents and browsers without color-mix', () => {
  for (const pathname of ['/chat', '/chat/', '/chat/index.html', '/other', '/chatter']) {
    for (const nativeColors of [false, true]) {
      const installed = [];
      const head = { appendChild: node => installed.push(node), append: node => installed.push(node) };
      const document = {
        head, documentElement: head,
        getElementById: id => installed.find(node => node.id === id),
        createElement: tag => ({ tagName: tag.toUpperCase() }),
        addEventListener: () => {},
      };
      const globals = { document, location: { pathname }, CSS: { supports: () => nativeColors } };
      globals.window = globals;
      const context = vm.createContext(globals);
      vm.runInContext(colors(), context);
      vm.runInContext(colors(), context);
      const chat = pathname === '/chat' || pathname === '/chat/';
      assert.equal(installed.length, chat && !nativeColors ? 1 : 0,
        `${pathname}, native color-mix=${nativeColors}: install once only at the feature boundary`);
      if (installed.length) assert.equal(installed[0].id, 'keepwork-onboarding-colors');
    }
  }
});

test('context-created color installation waits for head and releases its observer on install or navigation', () => {
  for (const navigating of [false, true]) {
    const installed = [], events = new Map();
    let callback, disconnected = false;
    const document = { head:null,
      getElementById: id => installed.find(node => node.id === id),
      createElement: tag => ({ tagName:tag.toUpperCase() }),
    };
    const globals = { document, location:{ pathname:'/chat' },
      MutationObserver:class {
        constructor(fn) { callback = fn; }
        observe(target, options) { assert.equal(target, document); assert.ok(options.childList && options.subtree); }
        disconnect() { disconnected = true; }
      },
      addEventListener: (name, fn) => events.set(name, fn),
      removeEventListener: (name, fn) => { if (events.get(name) === fn) events.delete(name); },
    };
    globals.window = globals;
    vm.runInNewContext(colors(), globals);
    assert.equal(installed.length, 0);
    assert.equal(disconnected, false);
    if (navigating) events.get('pagehide')();
    else { document.head = { append:node => installed.push(node) }; callback(); }
    assert.equal(installed.length, navigating ? 0 : 1);
    assert.equal(disconnected, true);
    assert.equal(events.size, 0);
  }
});

// The relevant independently shipped AIChat rules. The later var()-containing
// background declaration becomes invalid at computed-value time in CEF109,
// resetting the earlier opaque background to transparent. An unknown function
// reproduces that CSS engine behavior in current Chrome without changing CSSOM.
const originalCss = `
* { box-sizing:border-box; margin:0; }
:root { --bg-base:#181818; --bg-sidebar:#2b2b2b; --bg-pill:#4a4a4a; --text-primary:#e8e8e8; --accent:#6366f1; --border-card:#5a5a5a; }
body.light { --bg-base:#fff; --bg-sidebar:#f2f3f7; --bg-pill:#eef0f6; --text-primary:#1a1a2e; --border-card:#dde0ea; }
body { font:15px sans-serif; background:var(--bg-base); color:var(--text-primary); }
.underlay { position:fixed; inset:0; display:flex; background:#f00; color:#0f0; }
.underlay aside { width:280px; }.underlay main { padding:90px; }
.brain-onboarding { position:fixed; inset:0; z-index:12000; display:grid; grid-template-columns:280px minmax(0,1fr); background:var(--bg-base); color:var(--text-primary); }
.brain-onboarding.bo-simple-start { grid-template-columns:minmax(0,1fr); }
.bo-sidebar { padding:20px 18px; background:var(--bg-sidebar); }
.bo-main { position:relative; padding:50px; }.bo-guide-message h2 { margin:14px 0; }
.bo-btn { border:1px solid var(--border-card); background:var(--bg-pill); color:var(--text-primary); border-radius:9px; padding:9px 16px; min-height:40px; }
.bo-primary { background:color-mix(in srgb,var(--accent) 85%,black); border-color:var(--accent); color:white; }
.bo-primary:hover { background:color-mix(in srgb,var(--accent) 85%,black); }
.brain-onboarding { background:radial-gradient(ellipse at 82% 14%,color-mix(in srgb,var(--accent) 8%,transparent),transparent 55%),var(--bg-base); }
.bo-sidebar { background:color-mix(in srgb,var(--bg-sidebar) 96%,var(--accent)); }
.bo-card.bo-setup-alert { background:#fff1cc; color:#78350f; padding:20px; margin:24px 0; }
.bo-setup-alert .bo-btn.bo-primary { background:#92400e; border-color:#92400e; color:#fff; }
.bo-setup-alert .bo-btn.bo-primary:hover { background:#78350f; border-color:#78350f; }
@media(max-width:760px) { .brain-onboarding { grid-template-columns:1fr; grid-template-rows:auto minmax(0,1fr); } }
`;
function fixture({ legacy, light, onboarding = true }) {
  const css = legacy ? originalCss.replaceAll('color-mix(', 'unsupported-color-mix(') : originalCss;
  return `<!doctype html><meta charset="utf-8"><style>${css}</style><body class="${light ? 'light' : ''}">
  <div class="underlay"><aside>KeepWork<br>New chat<br>No matching chats</aside><main>What would you like to discuss?</main></div>
  <button id="unrelated" class="bo-primary">Unrelated primary</button><input id="draft" value="Keep my draft">
  ${onboarding ? `<section class="brain-onboarding"><aside class="bo-sidebar"><h2>Step by step,<br>connect your<br>knowledge.</h2></aside>
  <main class="bo-main"><div class="bo-guide-message"><span>Your brain setup guide</span><h2>Welcome back, testv10</h2></div>
  <button id="next" class="bo-btn bo-primary">Choose your AI assistant</button>
  <div class="bo-card bo-setup-alert"><button id="warning" class="bo-btn bo-primary">Resolve setup issue</button></div>
  <button id="close">Close guide</button></main></section>` : ''}
  <script>window.actions=0;document.querySelector('#next')?.addEventListener('click',()=>window.actions++);
  document.querySelector('#close')?.addEventListener('click',()=>document.querySelector('.brain-onboarding').remove());</script>`;
}

test('legacy onboarding is opaque and readable across themes while native colors and warning semantics survive', {
  skip: process.env.KEEPWORK_CEF_BROWSER_TESTS !== '1', timeout: 60000,
}, async t => {
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ channel: process.env.KEEPWORK_CEF_BROWSER_CHANNEL || 'chrome', headless:true });
  t.after(() => browser.close());
  const makePage = async ({ legacy, shim = true, light = true, pathname = '/chat', onboarding = true }) => {
    const page = await browser.newPage({ viewport: { width:1000, height:700 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    if (shim) await page.addInitScript({ content:`
      ${legacy ? `const originalSupports = CSS.supports.bind(CSS); CSS.supports = (...args) => args.some(arg => String(arg).includes('color-mix(')) ? false : originalSupports(...args);` : ''}
      ${production()}` });
    await page.route('https://keepwork.com/**', route => route.fulfill({ contentType:'text/html', body:fixture({ legacy, light, onboarding }) }));
    await page.goto('https://keepwork.com' + pathname);
    return { page, errors };
  };
  const before = await makePage({ legacy:true, shim:false });
  for (const selector of ['.brain-onboarding', '.bo-sidebar', '#next']) {
    assert.equal(await before.page.locator(selector).evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)',
      `${selector}: negative control reproduces the screenshot's missing backgrounds`);
  }
  await before.page.close();
  for (const legacy of [true, false]) {
    const { page, errors } = await makePage({ legacy });
    assert.equal(await page.locator('#keepwork-onboarding-colors').count(), legacy ? 1 : 0);
    for (const light of [true, false, true]) {
      await page.evaluate(light => document.body.classList.toggle('light', light), light);
      const state = await page.locator('.brain-onboarding').evaluate(el => {
        const read = node => ({ background:getComputedStyle(node).backgroundColor, image:getComputedStyle(node).backgroundImage,
          color:getComputedStyle(node).color });
        return { canvas:read(el), sidebar:read(el.querySelector('.bo-sidebar')), button:read(el.querySelector('#next')) };
      });
      assert.equal(state.canvas.background, light ? 'rgb(255, 255, 255)' : 'rgb(24, 24, 24)');
      assert.notEqual(state.sidebar.background, 'rgba(0, 0, 0, 0)');
      assert.notEqual(state.button.background, 'rgba(0, 0, 0, 0)');
      assert.equal(state.button.color, 'rgb(255, 255, 255)');
      if (legacy) {
        assert.equal(state.canvas.image, 'none');
        assert.equal(state.sidebar.background, light ? 'rgb(242, 243, 247)' : 'rgb(43, 43, 43)');
        assert.equal(state.button.background, 'rgb(99, 102, 241)');
      } else assert.match(state.canvas.image, /radial-gradient/, 'native browsers retain the original visual treatment');
      await page.locator('#next').hover();
      if (legacy) assert.equal(await page.locator('#next').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(99, 102, 241)');
    }
    assert.equal(await page.locator('#warning').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(146, 64, 14)');
    await page.locator('#warning').hover();
    assert.equal(await page.locator('#warning').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(120, 53, 15)',
      'warning-specific brown control is not repainted with the ordinary primary accent');
    await page.locator('#next').click();
    assert.equal(await page.evaluate(() => window.actions), 1, 'the original action runs once');
    const normalLayout = await page.locator('.brain-onboarding').evaluate(el => getComputedStyle(el).gridTemplateColumns);
    assert.equal(normalLayout, '280px 720px', 'desktop guide keeps its sidebar and content columns');
    await page.locator('.brain-onboarding').evaluate(el => el.classList.add('bo-simple-start'));
    assert.equal(await page.locator('.brain-onboarding').evaluate(el => getComputedStyle(el).gridTemplateColumns), '1000px',
      'simple-start mode keeps its published single-column layout');
    await page.locator('.brain-onboarding').evaluate(el => el.classList.remove('bo-simple-start'));
    await page.setViewportSize({ width:640, height:700 });
    assert.equal(await page.locator('.brain-onboarding').evaluate(el => getComputedStyle(el).gridTemplateColumns), '640px',
      'narrow windows keep the responsive single-column layout');
    await page.setViewportSize({ width:1000, height:700 });
    if (legacy) {
      await page.evaluate(() => { document.body.style.setProperty('--accent', '#087f5b'); });
      assert.equal(await page.locator('#next').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(8, 127, 91)', 'theme variables remain live');
      await page.addScriptTag({ content:colors() });
      assert.equal(await page.locator('#keepwork-onboarding-colors').count(), 1, 'repeat injection is idempotent');
    }
    await page.screenshot({ path:path.join(os.tmpdir(), `keepwork-cef-onboarding-${legacy ? 'fallback' : 'native'}.png`) });
    await page.locator('#close').click();
    assert.equal(await page.locator('.brain-onboarding').count(), 0);
    assert.equal(await page.locator('#draft').inputValue(), 'Keep my draft');
    if (legacy) assert.equal(await page.locator('#unrelated').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)', 'fallback remains scoped to the guide');
    assert.deepEqual(errors, []);
    await page.close();
  }
  const late = await makePage({ legacy:true, onboarding:false });
  await late.page.evaluate(() => {
    const guide = document.createElement('section');guide.className='brain-onboarding';
    guide.innerHTML='<aside class="bo-sidebar">Loaded later</aside><button class="bo-primary">Continue</button>';
    document.body.append(guide);
  });
  assert.equal(await late.page.locator('.brain-onboarding').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)',
    'context-created installation covers guides added after page boot');
  await late.page.evaluate(() => {
    for (const style of document.querySelectorAll('style:not(#keepwork-onboarding-colors)'))
      style.textContent = style.textContent.replace(/--(?:bg-base|bg-sidebar|accent):[^;]+;/g, '');
  });
  for (const selector of ['.brain-onboarding', '.bo-sidebar'])
    assert.equal(await late.page.locator(selector).evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)',
      `${selector}: older pages without theme tokens remain opaque`);
  assert.equal(await late.page.locator('.brain-onboarding .bo-primary').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(99, 102, 241)',
    'older pages without an accent still have a readable primary button');
  assert.deepEqual(late.errors, []); await late.page.close();
  const unrelated = await makePage({ legacy:true, pathname:'/other' });
  assert.equal(await unrelated.page.locator('#keepwork-onboarding-colors').count(), 0, 'a same-origin tool page is unaffected');
  await unrelated.page.close();
});
