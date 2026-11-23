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
        .match(/offsetStyle\.textContent = (["`])([\s\S]*?)\1;/)[2].replaceAll('{{', '{').replaceAll('}}', '}')],
    ['TypeScript titlebar', read('apps/aichat-rust/src/titlebar.ts')
        .match(/pageOffsetStyle\.textContent = `([\s\S]*?)`;/)[1]],
    ['Electron preload', read('apps/aichat-desktop/src/preload.cjs')
        .match(/layout\.textContent = (['`])([\s\S]*?)\1;/)[2]],
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

for (const [name, css] of [...layouts, ['Browser without desktop chrome', '']]) test(`${name}: image viewer starts below the title bar and can be closed from the top edge`, async () => {
    const page = await browser.newPage({ viewport: { width: 1288, height: 871 } });
    try {
        await page.setContent(`<!doctype html><style>${css}</style><style>
            #keepwork-desktop-titlebar{position:fixed;inset:0 0 auto;height:34px;background:#eee;z-index:2147483647}
            .image-viewer{position:fixed;inset:0;z-index:99999;background:#222}
            .image-viewer-stage{position:absolute;inset:0;overflow:hidden}
            .image-viewer-close{position:fixed;top:calc(14px + env(safe-area-inset-top,0px));right:16px;width:38px;height:38px}
            .image-viewer-toolbar{position:fixed;bottom:26px;left:50%}
            </style>
            ${css ? '<div id="keepwork-desktop-titlebar"></div>' : ''}
            <button id="open">Open image</button>
            <template id="viewer">
                <div class="image-viewer" role="dialog">
                    <div class="image-viewer-stage"></div>
                    <button class="image-viewer-close" aria-label="Close">×</button>
                    <div class="image-viewer-toolbar">100%</div>
                </div>
            </template>
            <script>
                document.querySelector('#open').onclick = () => {
                    const viewer = document.querySelector('#viewer').content.firstElementChild.cloneNode(true);
                    viewer.querySelector('.image-viewer-close').onclick = () => viewer.remove();
                    document.body.append(viewer);
                };
            </script>`);
        const viewer = page.locator('.image-viewer');
        for (const { width, height } of [{ width: 1288, height: 871 }, { width: 390, height: 375 }]) {
            await page.setViewportSize({ width, height });
            await page.locator('#open').click();
            const top = css ? 34 : 0;
            const expectedBounds = { x: 0, y: top, width, height: height - top };
            assert.deepEqual(await viewer.boundingBox(), expectedBounds);
            assert.deepEqual(await viewer.locator('.image-viewer-stage').boundingBox(), expectedBounds);
            const toolbar = await viewer.locator('.image-viewer-toolbar').boundingBox();
            assert.ok(toolbar.y >= top && toolbar.y + toolbar.height <= height);
            const close = viewer.getByRole('button', { name: 'Close' });
            assert.deepEqual(await close.boundingBox(), { x: width - 54, y: top + 14, width: 38, height: 38 });
            await close.click({ position: { x: 19, y: 2 }, timeout: 3000 });
            assert.equal(await viewer.count(), 0);
        }
    } finally { await page.close(); }
});

for (const [name, css] of [...layouts, ['Browser without desktop chrome', '']]) test(`${name}: Git and conversation changes stay within the client area`, async () => {
    const desktop = { width: 1360, height: 900 };
    const narrow = { width: 390, height: 375 };
    const top = css ? 34 : 0;
    const page = await browser.newPage({ viewport: desktop });
    try {
        await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
            <style>${css}</style><style>
                *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}
                #keepwork-desktop-titlebar{position:fixed;inset:0 0 auto;height:34px;background:#eee;z-index:2147483647}
                .workspace-git-overlay{position:fixed;inset:0;z-index:10000;padding:18px;background:#0006;display:flex}
                .workspace-git-overlay[hidden]{display:none}
                .workspace-git{display:flex;flex-direction:column;width:100%;overflow:hidden;background:white;border:1px solid}
                .workspace-git>header,.chat-changes-dialog>header{display:flex;align-items:center;justify-content:space-between;padding:8px 14px}
                .git-diff,.chat-changes-records{flex:1;min-height:0;overflow:auto}
                @media(max-width:650px){.workspace-git-overlay{padding:0}}
                .chat-changes-dialog{
                    --chat-changes-inset:clamp(8px,1.4vw,20px);
                    width:min(1600px,calc(100% - 2 * var(--chat-changes-inset)));
                    height:calc(100dvh - 2 * var(--chat-changes-inset));max-width:none;max-height:none;
                    padding:0;margin:auto;border:1px solid;
                }
                .chat-changes-dialog[open]{display:flex;flex-direction:column;overflow:hidden}
                .chat-changes-dialog::backdrop{background:#0006}
                .chat-changes-close{width:44px;height:44px}
            </style>
            ${css ? '<div id="keepwork-desktop-titlebar"></div>' : ''}
            <button id="open-git">Git changes</button><button id="open-chat">Conversation changes</button>
            <div class="workspace-git-overlay" hidden><section class="workspace-git" role="dialog" aria-modal="true">
                <header><strong>Git changes</strong><button data-action="close" aria-label="Close Git changes">×</button></header>
                <div class="git-diff"><div style="height:1500px">Git diff</div></div>
            </section></div>
            <dialog class="chat-changes-dialog">
                <header><strong>Conversation changes</strong><button class="chat-changes-close" autofocus aria-label="Close conversation changes">×</button></header>
                <div class="chat-changes-records"><div style="height:1500px">Conversation diff</div></div>
            </dialog>
            <script>
                const git = document.querySelector('.workspace-git-overlay');
                const dialog = document.querySelector('.chat-changes-dialog');
                document.querySelector('#open-git').onclick = () => { git.hidden = false; };
                document.querySelector('[data-action="close"]').onclick = () => { git.hidden = true; };
                document.querySelector('#open-chat').onclick = () => dialog.showModal();
                document.querySelector('.chat-changes-close').onclick = () => dialog.close();
            </script>`);

        const overlay = page.locator('.workspace-git-overlay');
        const git = page.locator('.workspace-git');
        const dialog = page.locator('.chat-changes-dialog');
        const scrolls = locator => locator.evaluate(el => {
            el.scrollTop = el.scrollHeight;
            return el.scrollTop > 0;
        });

        await page.locator('#open-git').click();
        for (const { width, height } of [desktop, narrow]) {
            await page.setViewportSize({ width, height });
            const inset = width <= 650 ? 0 : 18;
            assert.deepEqual(await overlay.boundingBox(), { x: 0, y: top, width, height: height - top });
            assert.deepEqual(await git.boundingBox(), {
                x: inset, y: top + inset, width: width - 2 * inset, height: height - top - 2 * inset,
            });
            assert.ok(await scrolls(git.locator('.git-diff')));
        }
        await git.getByRole('button', { name: 'Close Git changes' }).click({ position: { x: 6, y: 2 }, timeout: 3000 });
        assert.equal(await overlay.isVisible(), false);

        await page.setViewportSize(desktop);
        await page.locator('#open-chat').click();
        assert.equal(await dialog.evaluate(el => el.matches(':modal')), true);
        for (const { width, height } of [desktop, narrow]) {
            await page.setViewportSize({ width, height });
            const inset = Math.max(8, Math.min(width * 0.014, 20));
            const box = await dialog.boundingBox();
            assert.ok(Math.abs(box.y - top - inset) < 0.1, `dialog top at ${box.y}, expected ${top + inset}`);
            assert.ok(Math.abs(box.y + box.height - (height - inset)) < 0.1, `dialog bottom at ${box.y + box.height}`);
            assert.ok(await scrolls(dialog.locator('.chat-changes-records')));
        }
        assert.equal(await dialog.evaluate(el => getComputedStyle(el, '::backdrop').top), `${top}px`);
        await dialog.getByRole('button', { name: 'Close conversation changes' }).click({ position: { x: 6, y: 2 }, timeout: 3000 });
        assert.equal(await dialog.isVisible(), false);
        await page.locator('#open-chat').click();
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden' });
        assert.equal(await page.locator('#open-chat').evaluate(el => el === document.activeElement), true);
    } finally { await page.close(); }
});

for (const [name, css] of [...layouts, ['Browser without desktop chrome', '']]) test(`${name}: Global Settings fits below the title bar`, async () => {
    const desktop = { width: 1360, height: 900 };
    const narrow = { width: 390, height: 375 };
    const top = css ? 34 : 0;
    const page = await browser.newPage({ viewport: desktop });
    try {
        await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
            <style>${css}</style><style>
                *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}
                #keepwork-desktop-titlebar{position:fixed;inset:0 0 auto;height:34px;background:#eee;z-index:2147483647}
                .gs-overlay{position:fixed;inset:0;z-index:9998;background:#0008;display:flex;align-items:center;justify-content:center}
                .gs-box{display:flex;flex-direction:column;width:960px;max-width:95vw;max-height:calc(100dvh - 24px);
                    border:1px solid;border-radius:12px;background:white;font:15px/1.5 system-ui}
                .gs-head,.gs-tabs,.gs-foot{flex-shrink:0;display:flex}
                .gs-head{align-items:center;padding:14px 18px;border-bottom:1px solid}
                .gs-title{margin:0;font-size:17px;flex:1}
                .gs-close{font-size:22px;line-height:1;padding:0 4px;border:0}
                .gs-tabs{gap:4px;padding:10px 18px 0;border-bottom:1px solid}
                .gs-tab{font:inherit;border:0;border-bottom:2px solid transparent;padding:8px 12px;margin-bottom:-1px}
                .gs-body{height:min(75dvh,720px);max-height:min(75dvh,720px);min-height:0;overflow-y:auto;padding:16px 18px}
                .gs-box.is-packages .gs-body{overflow:hidden}
                .gs-panel[hidden]{display:none}
                #gsPanelPackages{height:100%;overflow:auto}
                .gs-foot{justify-content:flex-end;padding:12px 18px;border-top:1px solid}
                .gs-btn{font:inherit;border:0;padding:8px 16px}
            </style>
            ${css ? '<div id="keepwork-desktop-titlebar"></div>' : ''}
            <button id="open-settings">Open Global Settings</button>
            <template id="settings">
                <div id="aichatGlobalSettingsModal" class="gs-overlay">
                    <div class="gs-box" role="dialog" aria-label="全局设置">
                        <div class="gs-head"><h3 class="gs-title">全局设置</h3><button class="gs-close" data-gs-close>×</button></div>
                        <div class="gs-tabs" role="tablist">
                            <button class="gs-tab" data-gs-tab="packages" role="tab" aria-selected="false">扩展包与配置</button>
                            <button class="gs-tab" data-gs-tab="common" role="tab" aria-selected="true">常用</button>
                            <button class="gs-tab" data-gs-tab="advanced" role="tab" aria-selected="false">高级</button>
                        </div>
                        <div class="gs-body">
                            <div id="gsPanelPackages" class="gs-panel" role="tabpanel" data-gs-panel="packages" hidden><div style="height:1500px">扩展包</div></div>
                            <div class="gs-panel" role="tabpanel" data-gs-panel="common"><div style="height:1500px">界面与体验</div></div>
                            <div class="gs-panel" role="tabpanel" data-gs-panel="advanced" hidden><div style="height:1500px">高级设置</div></div>
                        </div>
                        <div class="gs-foot"><button class="gs-btn" data-gs-close>关闭</button></div>
                    </div>
                </div>
            </template>
            <script>
                document.querySelector('#open-settings').onclick = () => {
                    const overlay = document.querySelector('#settings').content.firstElementChild.cloneNode(true);
                    overlay.querySelectorAll('[data-gs-close]').forEach(button => { button.onclick = () => overlay.remove(); });
                    overlay.querySelectorAll('[data-gs-tab]').forEach(tab => {
                        tab.onclick = () => {
                            const selected = tab.dataset.gsTab;
                            overlay.querySelector('.gs-box').classList.toggle('is-packages', selected === 'packages');
                            overlay.querySelectorAll('[data-gs-tab]').forEach(button => button.setAttribute('aria-selected', button === tab));
                            overlay.querySelectorAll('[data-gs-panel]').forEach(panel => { panel.hidden = panel.dataset.gsPanel !== selected; });
                        };
                    });
                    document.body.append(overlay);
                };
            </script>`);

        const open = page.locator('#open-settings');
        const overlay = page.locator('#aichatGlobalSettingsModal');
        const dialog = overlay.getByRole('dialog', { name: '全局设置' });
        const scrolls = locator => locator.evaluate(el => {
            el.scrollTop = el.scrollHeight;
            return el.scrollTop > 0;
        });

        async function checkSettings({ width, height }, legacy = false) {
            await page.setViewportSize({ width, height });
            const box = await dialog.boundingBox();
            assert.ok(box.y >= top + 12, `settings top ${box.y} must clear the title bar and gutter (${top + 12})`);
            assert.ok(box.y + box.height <= height - 12, 'settings footer stays above the bottom gutter');
            assert.ok(Math.abs(2 * box.y + box.height - (height + top)) < 0.1, 'settings stays centered in the client area');
            assert.deepEqual(await overlay.boundingBox(), { x: 0, y: top, width, height: height - top });
            if (width === narrow.width) assert.equal(box.height, height - top - 24, 'settings shrinks on a short window');
            const footer = await dialog.locator('.gs-foot').boundingBox();
            assert.ok(footer.y + footer.height <= box.y + box.height, 'footer fits inside the settings dialog');

            for (const [tabName, panel, scrollContainer] of [
                ['常用', 'common', '.gs-body'],
                ['扩展包与配置', 'packages', '#gsPanelPackages'],
                ['高级', 'advanced', '.gs-body'],
            ]) {
                const tab = dialog.getByRole('tab', { name: tabName });
                await tab.click({ position: { x: 8, y: 3 }, timeout: 3000 });
                assert.equal(await tab.getAttribute('aria-selected'), 'true');
                assert.equal(await dialog.locator(`[data-gs-panel="${panel}"]`).isVisible(), true);
                assert.ok(await scrolls(dialog.locator(legacy ? '.gs-body' : scrollContainer)), `${tabName} content scrolls inside settings`);
            }
        }

        await open.click();
        await checkSettings(desktop);
        await checkSettings(narrow);
        await dialog.locator('.gs-head [data-gs-close]').click({ position: { x: 6, y: 2 }, timeout: 3000 });
        assert.equal(await overlay.count(), 0);
        await open.click();
        await dialog.locator('.gs-foot [data-gs-close]').click({ position: { x: 6, y: 2 }, timeout: 3000 });
        assert.equal(await overlay.count(), 0);

        if (css) {
            // Older AIChat pages use the same modal ID with a block layout and one scroll container.
            await page.addStyleTag({ content: `
                .gs-box{display:block;width:480px;max-height:none}
                .gs-head,.gs-tabs,.gs-foot{flex-shrink:1}
                .gs-body{height:auto;max-height:min(70vh,520px);min-height:auto}
                .gs-box.is-packages .gs-body{overflow-y:auto}
                #gsPanelPackages{height:auto;overflow:visible}
            ` });
            await open.click();
            await checkSettings(narrow, true);
            await dialog.locator('.gs-foot [data-gs-close]').click({ position: { x: 6, y: 2 }, timeout: 3000 });
            assert.equal(await overlay.count(), 0);
        }
    } finally { await page.close(); }
});
