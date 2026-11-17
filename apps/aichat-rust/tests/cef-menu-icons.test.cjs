const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const host = path.resolve(__dirname, '../windows/cef-host');
const read = name => fs.readFileSync(path.join(host, name), 'utf8');
const script = () => read('menu_icons.js');

test('legacy menu icons are embedded before page boot without native privileges or external assets', () => {
  assert.doesNotThrow(() => new vm.Script(script()));
  const template = read('compatibility_script.h.in');
  assert.ok(template.indexOf('@KEEPWORK_MENU_ICONS_SCRIPT@') < template.indexOf('const nativePopover'),
    'the icon fallback is independent of Popover support');
  assert.match(read('CMakeLists.txt'), /file\(READ[^\n]*menu_icons\.js[^\n]*KEEPWORK_MENU_ICONS_SCRIPT/);
  assert.doesNotMatch(script(), /aichatDesktop|__TAURI_INTERNALS__|nativeCall|CefMessageRouter|fetch\(|url\(/,
    'the visual fallback requires no native bridge, font download, or network request');
});

const fixture = `<!doctype html><meta charset="utf-8"><style>
  *{box-sizing:border-box}body{margin:24px;font:14px Arial,sans-serif;background:#f4f4f8;color:#4b4b58}
  .user-menu-dropdown,.file-menu-dropdown{display:inline-block;vertical-align:top;background:white;border-radius:10px;padding:8px;width:225px}
  .user-menu-item,.file-menu-item{display:flex;align-items:center;gap:8px;width:100%;padding:9px;border:0;background:transparent;color:inherit;font:inherit;text-align:left}
  .user-menu-item:hover{background:#eef0f7;color:#6657ed}.danger{color:#ff5555}.vip{margin-left:auto;background:#eef0f7;color:#6657ed}
  body.dark{background:#181818;color:#ddd}body.dark .user-menu-dropdown,body.dark .file-menu-dropdown{background:#282828}
</style>
<div id="userMenuDropdown" class="user-menu-dropdown">
 <button id="userMenuProfileBtn" class="user-menu-item" role="menuitem">👤 testv10 <span id="vip" class="vip">VIP</span></button>
 <button id="userMenuWorkspaceBtn" class="user-menu-item disabled" role="menuitem">🗂️ Workspace files</button>
 <button id="userMenuCalendarBtn" class="user-menu-item" role="menuitem">📅 Calendar</button>
 <button id="userMenuAutomationsBtn" class="user-menu-item" role="menuitem">⏰ Automations</button>
 <button id="userMenuSettingsBtn" class="user-menu-item" role="menuitem">⚙️ Settings</button>
 <button id="userMenuSkinsBtn" class="user-menu-item" role="menuitem">🎨 Theme store</button>
 <button id="userMenuLoginBtn" class="user-menu-item" role="menuitem" style="display:none">🔑 Sign in</button>
 <button id="userMenuLogoutBtn" class="user-menu-item danger" role="menuitem">🚪 Sign out</button>
 <button id="future" class="user-menu-item">🚀 Future action</button>
 <button id="native" class="user-menu-item"><svg width="16" height="16"><path d="M1 1L15 15"/></svg> Profile</button>
 <button id="nativeAfterLabel" class="user-menu-item">👤 Native profile <svg width="16" height="16"><path d="M1 1L15 15"/></svg></button>
 <button id="wrapped" class="user-menu-item"><span>👤 Wrapped profile</span></button>
 <button id="unspaced" class="user-menu-item">👤Alice</button>
 <div><button id="nested" class="user-menu-item">👤 Nested action</button></div>
 <button id="wrongClass">👤 Other action</button>
</div>
<div id="fileMenuDropdown" class="file-menu-dropdown">
 <button id="menuCalendarBtn" class="file-menu-item">📅 日历</button>
 <button id="menuAutomationsBtn" class="file-menu-item" disabled>⏰ 定时任务</button>
</div>
<button id="outsideMenu" class="user-menu-item">👤 Outside menu</button>
<div id="message">👤 🗂️ 📅 ⏰ ⚙️ 🎨 🔑 🚪 Message emojis</div><input id="draft" value="👤 Keep my draft">
<script>
 window.actions=0;window.profile=document.querySelector('#userMenuProfileBtn');window.vip=document.querySelector('#vip');
 for(const button of document.querySelectorAll('button'))button.addEventListener('click',()=>window.actions++);
</script>`;

test('font-independent menu icons preserve labels, events, themes and independently shipped page contracts', {
  skip: process.env.KEEPWORK_CEF_BROWSER_TESTS !== '1', timeout:60000,
}, async t => {
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ channel:process.env.KEEPWORK_CEF_BROWSER_CHANNEL || 'chrome', headless:true });
  t.after(() => browser.close());
  const makePage = async (pathname = '/chat', inject = true) => {
    const page = await browser.newPage({ viewport:{ width:850, height:900 } });
    const errors = [];page.on('pageerror', error => errors.push(error.message));
    if(inject)await page.addInitScript({ content:`window.headMissingAtInjection=document.head===null;${script()}` });
    await page.route('https://keepwork.com/**', route => route.fulfill({ contentType:'text/html', body:fixture }));
    await page.goto('https://keepwork.com' + pathname);
    return { page, errors };
  };
  const before = await makePage('/chat', false);
  assert.equal(await before.page.locator('.keepwork-menu-icon').count(), 0);
  assert.match(await before.page.locator('#userMenuProfileBtn').textContent(), /^👤 /,
    'the negative control retains the font-dependent decorative emoji');
  await before.page.close();
  for(const pathname of ['/chat', '/chat/']) {
    const { page, errors } = await makePage(pathname);
    await page.waitForFunction(() => document.querySelectorAll('.keepwork-menu-icon').length===10);
    assert.equal(await page.evaluate(() => headMissingAtInjection), true,
      'context-created installation supports a document without head or body');
    assert.equal(await page.evaluate(() => profile===document.querySelector('#userMenuProfileBtn') && vip===document.querySelector('#vip')), true,
      'page-owned button nodes and badges retain their identities');
    assert.equal(await page.locator('#userMenuProfileBtn').textContent(), 'testv10 VIP');
    assert.equal(await page.locator('#userMenuCalendarBtn').textContent(), 'Calendar');
    assert.equal(await page.locator('#menuCalendarBtn').textContent(), '日历');
    assert.equal(await page.locator('#menuAutomationsBtn').isDisabled(), true);
    assert.equal(await page.locator('#userMenuWorkspaceBtn').getAttribute('class'), 'user-menu-item disabled');
    assert.equal(await page.locator('#userMenuLoginBtn').evaluate(el => el.style.display), 'none');
    assert.equal(await page.locator('#userMenuProfileBtn').getAttribute('role'), 'menuitem');
    for(const id of ['future','native','nativeAfterLabel','wrapped','unspaced','nested','wrongClass','outsideMenu'])
      assert.equal(await page.locator('#'+id+' .keepwork-menu-icon').count(), 0, `${id}: unknown or already structured markup is untouched`);
    assert.equal(await page.locator('#native svg').count(), 1);
    assert.equal(await page.locator('#message').textContent(), '👤 🗂️ 📅 ⏰ ⚙️ 🎨 🔑 🚪 Message emojis');
    assert.equal(await page.locator('#draft').inputValue(), '👤 Keep my draft');
    const icons = await page.locator('.keepwork-menu-icon').evaluateAll(nodes => nodes.map(node => ({
      tag:node.tagName,hidden:node.getAttribute('aria-hidden'),focusable:node.getAttribute('focusable'),
      width:node.getBoundingClientRect().width,height:node.getBoundingClientRect().height,
      widthAttribute:node.getAttribute('width'),heightAttribute:node.getAttribute('height'),
      visible:getComputedStyle(node.parentElement).display!=='none',
      stroke:getComputedStyle(node).stroke,color:getComputedStyle(node.parentElement).color,
    })));
    for(const icon of icons) {
      assert.equal(icon.tag.toLowerCase(), 'svg');assert.equal(icon.hidden,'true');assert.equal(icon.focusable,'false');
      assert.equal(icon.widthAttribute,'16');assert.equal(icon.heightAttribute,'16');
      if(icon.visible){assert.equal(icon.width,16);assert.equal(icon.height,16);}
      assert.equal(icon.stroke,icon.color);
    }
    await page.locator('#userMenuProfileBtn .keepwork-menu-icon').click();
    assert.equal(await page.evaluate(() => actions),1,'clicking the decoration reaches the original action exactly once');
    await page.locator('#userMenuSettingsBtn').hover();
    assert.equal(await page.locator('#userMenuSettingsBtn .keepwork-menu-icon').evaluate(el=>getComputedStyle(el).stroke),'rgb(102, 87, 237)');
    await page.evaluate(() => document.body.classList.add('dark'));
    assert.equal(await page.locator('#userMenuCalendarBtn .keepwork-menu-icon').evaluate(el=>getComputedStyle(el).stroke),'rgb(221, 221, 221)');
    assert.equal(await page.locator('#userMenuLogoutBtn .keepwork-menu-icon').evaluate(el=>getComputedStyle(el).stroke),'rgb(255, 85, 85)');
    await page.addScriptTag({ content:script() });
    await page.addScriptTag({ content:script() });
    assert.equal(await page.locator('.keepwork-menu-icon').count(),10,'repeat installation cannot duplicate icons');
    await page.evaluate(() => {
      document.querySelector('#userMenuSettingsBtn').lastChild.nodeValue='⚙️ 偏好设置';
    });
    await page.waitForFunction(() => document.querySelector('#userMenuSettingsBtn').textContent==='偏好设置');
    assert.equal(await page.locator('#userMenuSettingsBtn .keepwork-menu-icon').count(),1,
      'replacing an existing direct text label cannot duplicate its retained decoration');
    await page.evaluate(() => {
      profile.textContent='👤 🌟 新名字';
      document.querySelector('#userMenuCalendarBtn').innerHTML='📅 日历';
      document.querySelector('#future').firstChild.nodeValue='🔑 New sign in';
    });
    await page.waitForFunction(() => document.querySelector('#userMenuProfileBtn').textContent==='🌟 新名字');
    await page.waitForFunction(() => document.querySelector('#future .keepwork-menu-icon'));
    assert.equal(await page.locator('#userMenuCalendarBtn').textContent(),'日历');
    assert.equal(await page.locator('.keepwork-menu-icon').count(),11,'textContent, innerHTML and direct characterData refreshes converge');
    for(const [source,label] of [['👤 👤 Ada','👤 Ada'],['👤 🎨 用户','🎨 用户']]) {
      await page.evaluate(source => { profile.textContent=source; },source);
      await page.waitForFunction(label => document.querySelector('#userMenuProfileBtn').textContent===label,label);
      await page.evaluate(async () => {
        await Promise.resolve();await Promise.resolve();
        document.querySelector('#message').append(document.createTextNode(' '));
      });
      await page.waitForTimeout(30);
      assert.equal(await page.locator('#userMenuProfileBtn').textContent(),label,
        'observer delivery never peels a genuine leading username emoji');
      assert.equal(await page.locator('#userMenuProfileBtn .keepwork-menu-icon').count(),1);
    }
    await page.evaluate(() => {
      document.querySelector('#userMenuDropdown').innerHTML='<button class="user-menu-item" id="newAction">🗂️ Later workspace</button>';
    });
    await page.waitForFunction(() => document.querySelector('#newAction .keepwork-menu-icon'));
    assert.equal(await page.locator('#newAction').textContent(),'Later workspace');
    assert.equal(await page.locator('.keepwork-menu-icon').count(),3,'a full menu rerender is handled without stale nodes');
    await page.screenshot({ path:path.join(os.tmpdir(),'keepwork-cef-menu-icons.png') });
    assert.deepEqual(errors,[]);await page.close();
  }
  for(const pathname of ['/other','/chat/index.html','/chatter']) {
    const unrelated=await makePage(pathname);
    assert.equal(await unrelated.page.locator('.keepwork-menu-icon').count(),0,
      `${pathname}: other same-origin tools retain their own menu presentation`);
    assert.deepEqual(unrelated.errors,[]);await unrelated.page.close();
  }
});
