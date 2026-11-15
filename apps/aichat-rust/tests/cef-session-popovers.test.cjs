const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const host = path.resolve(__dirname, '../windows/cef-host');
const read = name => fs.readFileSync(path.join(host, name), 'utf8');
const template = read('compatibility_script.h.in').match(/R"KW_POPOVER\(([\s\S]*?)\)KW_POPOVER"/)[1];
const production = template.replace('@KEEPWORK_POPOVER_SCRIPT@', read('vendor/popover.iife.min.js'))
  .replace('@KEEPWORK_SESSION_POPOVERS_SCRIPT@', read('session_popovers.js'));
const fixture = legacy => `<!doctype html><meta charset="utf-8"><style>
${legacy ? '@layer legacy-ua-fixture,popover-polyfill; @layer legacy-ua-fixture{:where([popover]){display:block}}' : ''}
*{box-sizing:border-box}body{margin:0;font:14px sans-serif;--bg-card:#fff;--text-primary:#222;--border-card:#ddd}
.topbar{position:relative;margin:20px 0 0 250px;backdrop-filter:blur(8px);z-index:95;background:#eee8}
.external-tool-tabs{display:flex;align-items:center;justify-content:flex-end;overflow:hidden;height:36px;padding-right:8px}
.session-tabs-list,.session-tab-add{width:28px;height:28px}.session-tab-add{position:absolute;right:8px;top:70px}
.session-pages-menu{position:fixed;inset:auto;margin:0;padding:6px;width:min(320px,calc(100vw - 16px));max-height:min(420px,60dvh);overflow-y:auto;border:1px solid #ddd;border-radius:12px;background:#fff;color:#222}
.session-pages-menu button{display:block;width:100%;padding:9px 12px;text-align:left;border:0;background:transparent;font:inherit;overflow-wrap:anywhere}
.session-add-menu{position:fixed;z-index:240;min-width:170px;max-width:calc(100vw - 24px);max-height:calc(100dvh - 24px);overflow-y:auto;padding:6px;border:1px solid #ddd;background:white}
.session-add-menu button{display:block;width:100%;padding:9px;text-align:left}
</style><div class="topbar"><div class="external-tool-tabs"><button class="session-tabs-list" aria-expanded="false">⌄</button>
<div class="session-pages-menu" popover="auto"><button class="active">Main chat</button><button>🌐 Web browser with a very long page name to wrap safely without horizontal clipping</button>${'<button>More pages</button>'.repeat(12)}</div></div></div>
<button class="session-tab-add">+</button><input id="draft" value="keep this draft"><button id="outside">Outside</button>
<script>
const menu=document.querySelector('.session-pages-menu'), trigger=document.querySelector('.session-tabs-list');
window.originalParent=menu.parentElement;window.selections=0;
menu.addEventListener('toggle',()=>trigger.setAttribute('aria-expanded',String(menu.matches(':popover-open'))));
trigger.addEventListener('click',()=>{if(menu.matches(':popover-open')){menu.hidePopover();return}
const rect=trigger.getBoundingClientRect(),width=Math.min(320,innerWidth-16);
menu.style.top=(rect.bottom+6)+'px';menu.style.left=Math.max(8,Math.min(rect.right-width,innerWidth-width-8))+'px';
menu.showPopover();menu.querySelector('.active').focus()});
menu.querySelector('.active').addEventListener('click',()=>{window.selections++;menu.hidePopover()});
</script>`;
async function pageFor(browser, legacy, shim) {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  await page.addInitScript({ content: `window.nativeShow=HTMLElement.prototype.showPopover;
    ${legacy ? "for(const key of ['popover','showPopover','hidePopover','togglePopover'])delete HTMLElement.prototype[key];" : ''}
    ${shim ? production : read('vendor/popover.iife.min.js')}` });
  await page.route('https://keepwork.com/chat', route => route.fulfill({ contentType: 'text/html', body: fixture(legacy) }));
  await page.goto('https://keepwork.com/chat');
  return page;
}
test('CEF session menus escape the blurred header without moving DOM nodes or changing native Popover', {
  skip: process.env.KEEPWORK_CEF_BROWSER_TESTS !== '1', timeout: 120000,
}, async t => {
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ channel: process.env.KEEPWORK_CEF_BROWSER_CHANNEL || 'chrome', headless: true });
  t.after(() => browser.close());
  const before = await pageFor(browser, true, false);
  await before.locator('.session-tabs-list').click();
  assert.ok((await before.locator('.session-pages-menu').boundingBox()).x > 650, 'actual blurred containing block reproduces the reported right-side displacement');
  await before.close();
  for (const legacy of [true, false]) {
    const page = await pageFor(browser, legacy, true);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    for (const width of [900, 600, 320]) {
      await page.setViewportSize({ width, height: 600 });
      await page.locator('.session-tabs-list').click();
      await page.waitForFunction(() => document.querySelector('.session-tabs-list').getAttribute('aria-expanded') === 'true');
      const box = await page.locator('.session-pages-menu').boundingBox();
      assert.ok(box.x >= 7.5 && box.x + box.width <= width - 7.5, `${legacy}:${width} horizontal viewport boundaries`);
      assert.ok(Math.abs(box.width - Math.min(320, width - 16)) < 1, 'menu keeps its full reference width');
      assert.equal(await page.evaluate(() => {
        const menu = document.querySelector('.session-pages-menu'), rect = menu.getBoundingClientRect();
        return menu.parentElement === originalParent && menu.contains(document.elementFromPoint(rect.left + 12, rect.top + 12));
      }), true, 'the real hit target escapes overflow while retaining its original DOM parent');
      assert.equal(await page.locator('.topbar').evaluate(el => el.style.backdropFilter), legacy ? 'none' : '');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.session-pages-menu').matches(':popover-open'));
      await page.waitForFunction(() => document.querySelector('.topbar').style.backdropFilter === '');
      assert.equal(await page.locator('#draft').inputValue(), 'keep this draft');
    }
    await page.locator('.session-tabs-list').click();
    await page.setViewportSize({ width: 420, height: 180 });
    await page.waitForTimeout(50);
    let box = await page.locator('.session-pages-menu').boundingBox();
    assert.ok(box.x >= 7.5 && box.x + box.width <= 412.5 && box.y >= 7.5 && box.y + box.height <= 172.5);
    await page.locator('.session-pages-menu .active').click();
    assert.equal(await page.evaluate(() => selections), 1, 'page action is preserved exactly once');
    if (legacy) {
      await page.locator('.session-tabs-list').click();
      await page.evaluate(() => {
        const menu = document.querySelector('.session-pages-menu'); menu.hidePopover(); menu.showPopover();
      });
      await page.waitForTimeout(30);
      assert.equal(await page.locator('.topbar').evaluate(el => el.style.backdropFilter), 'none', 'a stale close microtask cannot release a reopened menu');
      await page.evaluate(() => document.querySelector('.session-pages-menu').hidePopover());
      await page.locator('.session-tabs-list').click();
      await page.locator('.topbar').evaluate(el => el.style.setProperty('backdrop-filter', 'blur(2px)', 'important'));
      await page.evaluate(() => document.querySelector('.session-pages-menu').hidePopover());
      await page.waitForTimeout(30);
      assert.equal(await page.locator('.topbar').evaluate(el => el.style.backdropFilter), 'blur(2px)', 'closing cannot overwrite a newer page-owned inline style');
      await page.locator('.session-tabs-list').click();
      await page.evaluate(() => document.querySelector('.external-tool-tabs').replaceChildren());
      await page.waitForTimeout(30);
      assert.equal(await page.locator('.topbar').evaluate(el => el.style.backdropFilter), 'blur(2px)', 'rerender/removal releases ancestor overrides');
      await page.evaluate(() => {
        const menu = document.createElement('div');menu.className='session-add-menu';menu.style.left='410px';menu.style.top='170px';
        menu.innerHTML='<button>Files</button><button>Tools</button><button disabled>Terminal</button><button>Open browser</button>';
        document.body.append(menu);
      });
      await page.waitForTimeout(50);
      box = await page.locator('.session-add-menu').boundingBox();
      assert.ok(box.x >= 7.5 && box.x + box.width <= 412.5 && box.y >= 7.5 && box.y + box.height <= 172.5);
      assert.equal(await page.locator('.session-add-menu button').nth(2).isDisabled(), true, 'layout never fabricates terminal capabilities');
    } else assert.equal(await page.evaluate(() => HTMLElement.prototype.showPopover === nativeShow), true);
    assert.deepEqual(errors, []); await page.close();
  }
});
