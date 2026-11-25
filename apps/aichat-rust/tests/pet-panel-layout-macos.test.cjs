const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);

// This runs in WKWebView. Use the actual pet markup and styles, including
// the macOS scroll container's overflowing padding calculation.
function measurePanel(html, css) {
    const style = document.createElement('style');
    style.textContent = css + '\n#art { background-image:none !important } #panel { animation:none }';
    document.head.append(style);
    const source = new DOMParser().parseFromString(html, 'text/html');
    source.querySelectorAll('script').forEach(node => node.remove());
    document.body.replaceChildren(...source.body.children);
    const element = id => document.getElementById(id);
    const panel = element('panel'), stack = element('stack');
    panel.hidden = false;
    stack.style.top = '6px';
    stack.style.bottom = 'auto';
    element('remote-voice-indicator').hidden = false;
    element('remote-voice-indicator').dataset.icon = 'link';
    element('remote-voice-label').textContent = '正在连接遥控器…';
    element('target').dataset.kind = 'session';
    element('target-title').textContent = '会话 · ' + '课堂问答'.repeat(18);
    element('target-detail').textContent = '技能：课堂助教 · 文件夹：未绑定';
    const rect = id => element(id).getBoundingClientRect();
    for (const [width, zoom, calling] of [[348, 1, false], [266, 1, false], [220, 1, false],
        [348, 2, false], [220, 1.25, true], [266, 0.75, true]]) {
        stack.style.width = width + 'px';
        stack.style.zoom = zoom;
        element('mute').hidden = !calling;
        element('call').classList.toggle('alternate-action', calling);
        element('call-label').textContent = calling ? '结束通话' : '通话';
        for (const station of [false, true]) {
            panel.classList.toggle('remote-voice-station', station);
            const check = (condition, detail) => {
                if (!condition) throw Error(width + 'px at ' + zoom + '×, calling=' + calling + ', active PTT=' + station + ': ' + detail);
            };
            // At fractional zoom the integer client/scroll widths can differ by one
            // even when WebKit reports zero scrollable distance.
            panel.scrollLeft = panel.scrollWidth;
            check(!panel.scrollLeft, 'horizontal scroll ' + panel.scrollLeft + ', dimensions ' + panel.scrollWidth + '/' + panel.clientWidth);
            const boundary = panel.getBoundingClientRect();
            const controls = ['call', 'dictation', 'send', 'minimize', 'open', 'collapse', 'draft'];
            if (calling) controls.push('mute');
            for (const id of controls) {
                const box = rect(id);
                check(box.width > 0 && box.left >= boundary.left && box.right <= boundary.right, id + ' clipped');
            }
            const cue = rect('remote-voice-indicator');
            for (const id of ['minimize', 'open', 'collapse']) {
                const control = rect(id);
                check(Math.abs(cue.top + cue.height / 2 - control.top - control.height / 2) <= 1, id + ' not aligned with indicator');
            }
            if (!station) {
                check(rect('target-title').width > 1 && getComputedStyle(element('target-title')).visibility === 'visible', 'title missing');
                check(rect('call-label').width > 1 && getComputedStyle(element('call-label')).clipPath === 'none', 'call label missing');
                check(getComputedStyle(element('draft'), '::placeholder').opacity !== '0', 'placeholder missing');
            }
        }
    }
    stack.style.maxHeight = '100px';
    if (panel.scrollHeight <= panel.clientHeight) throw Error('short panel no longer scrolls vertically');
    panel.scrollTop = panel.scrollHeight;
    if (!panel.scrollTop) throw Error('actions are unreachable in a short panel');
    return 'pet panel layout passed';
}

test('pet composer keeps call, title and controls visible without horizontal scrolling in WebKit', {
    skip: process.platform !== 'darwin', timeout: 50000,
}, async () => {
    const app = path.resolve(__dirname, '..');
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'keepwork-pet-layout-'));
    try {
        const [html, typography, styles] = await Promise.all(
            ['pet.html', 'src/typography.css', 'src/pet.css'].map(file => fs.readFile(path.join(app, file), 'utf8')));
        const script = path.join(temporary, 'measure.js');
        await fs.writeFile(script, 'return (' + measurePanel.toString() + ')(' +
            JSON.stringify(html) + ',' + JSON.stringify(typography + '\n' + styles) + ');');
        const executable = path.join(temporary, 'webview');
        await execute('clang', ['-fobjc-arc', '-Wall', '-Werror', '-framework', 'AppKit', '-framework', 'WebKit',
            path.join(__dirname, 'fixtures/remote_voice_main_composer_macos.m'), '-o', executable], { timeout: 15000 });
        const result = await execute(executable, [script, 'pet panel layout passed'], { timeout: 30000 });
        assert.match(result.stdout, /pet panel layout passed/);
    } finally {
        await fs.rm(temporary, { recursive: true, force: true });
    }
});
