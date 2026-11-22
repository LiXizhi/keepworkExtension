const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

// Manual browser regression; no application server, accounts or SDK build.
// TEST_BROWSER_EXECUTABLE=/path/to/chrome node --test apps/aichat-rust/scripts/titlebar-layout.test.cjs
const repository = path.resolve(__dirname, '../../..');
const read = relative => fs.readFileSync(path.join(repository, relative), 'utf8');
const layouts = [
    ['Rust initialization', read('apps/aichat-rust/src-tauri/src/bridge.rs')
        .match(/offsetStyle\.textContent = "([^"]+)";/)[1].replaceAll('{{', '{').replaceAll('}}', '}')],
    ['TypeScript titlebar', read('apps/aichat-rust/src/titlebar.ts')
        .match(/pageOffsetStyle\.textContent = `([\s\S]*?)`;/)[1]],
    ['Electron preload', read('apps/aichat-desktop/src/preload.cjs')
        .match(/layout\.textContent = '([^']+)';/)[1]],
];

let browser;
test.before(async () => {
    browser = await chromium.launch({
        headless: true,
        ...(process.env.TEST_BROWSER_EXECUTABLE
            ? { executablePath: process.env.TEST_BROWSER_EXECUTABLE }
            : { channel: process.env.TEST_BROWSER_CHANNEL || 'chrome' }),
    });
});
test.after(async () => { await browser?.close(); });

async function geometry(page) {
    return page.evaluate(() => {
        const rect = selector => {
            const value = document.querySelector(selector).getBoundingClientRect();
            return { top: value.top, bottom: value.bottom, left: value.left, right: value.right, height: value.height };
        };
        return {
            body: rect('body'), shell: rect('.app-shell'), anchor: rect('#model'),
            picker: rect('#picker'), footer: rect('#manage'), corner: rect('#corner'), origin: rect('#origin'),
            top: parseFloat(document.querySelector('#picker').style.top),
            width: innerWidth, height: innerHeight,
            scrollHeight: document.documentElement.scrollHeight,
            scrollWidth: document.documentElement.scrollWidth,
        };
    });
}

for (const [name, css] of layouts) test(`${name}: titlebar offset preserves viewport coordinates for overlays`, async () => {
    const page = await browser.newPage({ viewport: { width: 963, height: 375 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
        await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
            <style>
                *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}
                .app-shell{height:100vh;padding:141px 0 0 154px}
                #model{height:30px;width:156px}#corner{position:absolute;bottom:0;right:0;width:1px;height:1px}
                #origin{position:absolute;top:0;left:0;width:1px;height:1px}
                #picker{position:fixed;width:min(400px,calc(100vw - 16px));border:1px solid #888;background:white;display:flex;flex-direction:column}
                #search{height:42px;flex-shrink:0}#list{min-height:0;overflow:auto;flex:1}#list button{display:block;width:100%;height:34px}
                #manage{min-height:38px;flex-shrink:0}#dialog{position:fixed;inset:0;background:#ddd}
                #dialog[hidden]{display:none}
                @media(max-width:720px){#picker{left:0!important;right:0!important;top:auto!important;bottom:0!important;width:100%!important;max-height:70vh}}
                ${css}
            </style>
            <div class="app-shell"><button id="model">keepwork-image</button></div><i id="corner"></i><i id="origin"></i>
            <section id="picker" hidden><input id="search" placeholder="Search models"><div id="list"></div><button id="manage">Other models</button></section>
            <section id="dialog" hidden>Model settings</section>
            <script>
                const picker=document.getElementById('picker'), model=document.getElementById('model');
                const search=document.getElementById('search'), list=document.getElementById('list');
                const names=['keepwork-image','keepwork-image-pro'];
                function position(){
                    const anchor=model.getBoundingClientRect(), height=picker.offsetHeight;
                    const below=innerHeight-anchor.bottom-8, above=anchor.top-8;
                    const up=below<height && above>below;
                    picker.style.left=Math.max(8,Math.min(anchor.left,innerWidth-picker.offsetWidth-8))+'px';
                    picker.style.top=(up?Math.max(8,anchor.top-height-4):Math.max(8,Math.min(anchor.bottom+4,innerHeight-height-8)))+'px';
                }
                function render(){
                    list.replaceChildren(...names.filter(name=>name.includes(search.value)).map(name=>{
                        const option=document.createElement('button'); option.textContent=name;
                        option.onclick=()=>{model.textContent=name;picker.hidden=true;picker.style.display='none';};
                        return option;
                    }));
                    position();
                }
                picker.style.display='none';
                model.onclick=()=>{picker.hidden=false;picker.style.display='flex';search.value='';render();};
                search.oninput=render;
                document.getElementById('manage').onclick=()=>{picker.style.display='none';document.getElementById('dialog').hidden=false;};
                addEventListener('resize',position);
            </script>`);
        await page.locator('#model').click();
        let bounds = await geometry(page);
        assert.equal(bounds.body.top, 34, 'the titlebar retains its reserved area');
        assert.equal(bounds.body.bottom, bounds.height);
        assert.equal(bounds.shell.top, 34);
        assert.equal(bounds.shell.bottom, bounds.height);
        assert.equal(bounds.corner.bottom, bounds.height, 'absolute content retains the same containing block');
        assert.equal(bounds.origin.top, bounds.body.top, 'absolute content retains the body origin below the titlebar');
        assert.equal(bounds.anchor.top, 175, 'the screenshot composer remains at its original location');
        assert.equal(bounds.picker.top, bounds.anchor.bottom + 4, 'fixed overlays use the same coordinates as their anchor');
        assert.equal(bounds.picker.top, bounds.top, 'the titlebar must not add a second offset');
        assert.ok(bounds.footer.bottom <= bounds.height, 'Other models stays visible');
        assert.equal(bounds.scrollHeight, bounds.height, 'an overlay must not extend the document below the window');
        await page.locator('#search').fill('-pro');
        assert.equal(await page.locator('#list button').count(), 1);
        await page.locator('#list button').click();
        assert.equal(await page.locator('#model').textContent(), 'keepwork-image-pro');
        await page.locator('#model').click();

        for (const viewport of [{ width: 963, height: 280 }, { width: 1000, height: 640 }, { width: 390, height: 700 }]) {
            await page.setViewportSize(viewport);
            await page.evaluate(() => new Promise(requestAnimationFrame));
            bounds = await geometry(page);
            assert.equal(bounds.body.top, 34);
            assert.equal(bounds.body.bottom, viewport.height);
            assert.equal(bounds.shell.bottom, viewport.height);
            assert.ok(bounds.picker.top >= 0 && bounds.picker.bottom <= viewport.height, JSON.stringify(bounds));
            assert.ok(bounds.footer.bottom <= viewport.height);
            assert.ok(bounds.picker.left >= 0 && bounds.picker.right <= viewport.width);
            assert.ok(bounds.scrollWidth <= viewport.width);
            assert.equal(bounds.scrollHeight, viewport.height);
            if (viewport.width > 720) assert.equal(bounds.picker.top, bounds.top, 'resize preserves viewport coordinates');
            else {
                assert.equal(bounds.picker.left, 0);
                assert.equal(bounds.picker.right, viewport.width);
                assert.equal(bounds.picker.bottom, viewport.height, 'the mobile bottom sheet remains attached to the viewport');
            }
        }
        await page.locator('#manage').click();
        const dialog = await page.locator('#dialog').boundingBox();
        assert.deepEqual(dialog, { x: 0, y: 0, width: 390, height: 700 }, 'full-window dialogs keep viewport-sized bounds');
        assert.deepEqual(errors, []);
    } finally { await page.close(); }
});

for (const [name, css] of [...layouts, ['Browser without desktop chrome', '']]) test(`${name}: onboarding controls are fully visible and clickable`, async () => {
    const page = await browser.newPage({ viewport: { width: 1366, height: 960 } });
    try {
        await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
            <style>${css}</style>
            <style>
                *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}
                #keepwork-desktop-titlebar{position:fixed;inset:0 0 auto;height:34px;background:#eee;z-index:2147483647}
                .brain-onboarding{position:fixed;inset:0;z-index:12000;display:grid;grid-template-columns:280px minmax(0,1fr)}
                .bo-sidebar{padding:20px 18px;overflow:auto}
                .bo-main{position:relative;display:flex;flex-direction:column;min-height:0}
                .bo-main>header{position:absolute;top:12px;right:16px;z-index:10;display:flex;gap:12px}
                .bo-main>header>button{height:44px}
                .bo-content{flex:1;overflow:auto;padding:64px 24px 24px}
                .brain-onboarding-side-open .brain-onboarding{right:320px}
                #chatSidePanel.chat-side-onboarding-mode{position:fixed;top:0;right:0;bottom:0;width:320px;z-index:12005}
                @media(max-width:760px){.brain-onboarding{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr)}}
            </style>
            ${css ? '<div id="keepwork-desktop-titlebar"></div>' : ''}
            <div id="brainOnboarding" class="brain-onboarding">
                <aside class="bo-sidebar"><div class="bo-brand">KeepWork 第二大脑</div></aside>
                <section class="bo-main"><header>
                    <button data-brain-action="finish">完成，开始使用</button>
                    <button data-brain-action="dismiss" aria-label="关闭指引">×</button>
                </header><div class="bo-content"><div style="height:1100px">配置大脑</div></div></section>
            </div>
            <section id="chatSidePanel" hidden>大脑助手</section>
            <script>
                document.querySelector('header').addEventListener('click', event => {
                    document.body.dataset.action = event.target.dataset.brainAction;
                });
            </script>`);
        const overlay = page.locator('#brainOnboarding');
        const header = page.locator('.bo-main > header');
        const top = css ? 34 : 0;
        for (const { width, height } of [{ width: 1366, height: 960 }, { width: 390, height: 375 }]) {
            await page.setViewportSize({ width, height });
            assert.deepEqual(await overlay.boundingBox(), { x: 0, y: top, width, height: height - top });
            assert.equal((await page.locator('.bo-brand').boundingBox()).y, top + 20);
            // The header is absolutely positioned inside .bo-main, so its own offset
            // must be measured from below the title bar, not from the viewport origin.
            const headerBox = await header.boundingBox();
            assert.ok(headerBox.y >= top, `wizard header stays below the title bar (y=${headerBox.y})`);
            for (const action of ['finish', 'dismiss']) {
                const button = page.locator(`[data-brain-action="${action}"]`);
                const bounds = await button.boundingBox();
                assert.ok(bounds.y >= top && bounds.y + bounds.height <= height,
                    `${action} stays clear of the title bar (y=${bounds.y}, top=${top})`);
                await button.click({ position: { x: 8, y: 5 }, timeout: 3000 });
                assert.equal(await page.locator('body').getAttribute('data-action'), action);
            }
            assert.ok(await page.locator('.bo-content').evaluate(el => {
                el.scrollTop = el.scrollHeight;
                return el.scrollTop > 0;
            }), 'onboarding content scrolls inside the available height');
        }
        await page.setViewportSize({ width: 1366, height: 960 });
        const panel = page.locator('#chatSidePanel');
        await panel.evaluate(el => {
            el.hidden = false;
            el.classList.add('chat-side-onboarding-mode');
            document.body.classList.add('brain-onboarding-side-open');
        });
        assert.deepEqual(await overlay.boundingBox(), { x: 0, y: top, width: 1046, height: 960 - top });
        assert.deepEqual(await panel.boundingBox(), { x: 1046, y: top, width: 320, height: 960 - top });
    } finally { await page.close(); }
});
