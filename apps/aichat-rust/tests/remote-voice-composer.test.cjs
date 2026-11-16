const test = require("node:test");
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const execute = promisify(execFile);

// This function runs in the real WebKit document, with no access to the user's
// clipboard. insertText exercises native editing after the routing decision.
function checkComposerRoute(prepare) {
  const check = (condition, message) => { if (!condition) throw Error(message); };
  const byId = id => document.getElementById(id);
  const page = body => { document.body.innerHTML = body; };
  const focus = id => byId(id).focus();
  const rich = '<div id="chatInput" contenteditable="true" role="textbox">' +
    '前<span class="composer-file-ref" contenteditable="false">@资料</span>草稿</div>';
  const toolbar = '<button id="toolbar">工具</button>';
  const insert = text => check(document.execCommand("insertText", false, text), "native edit failed");
  const select = (node, start, end) => {
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  };
  const active = id => document.activeElement === byId(id);
  page(toolbar + rich);
  focus("toolbar");
  check(!document.hasFocus(), "fixture window unexpectedly active");
  check(!prepare() && active("toolbar"), "background page stole focus");

  // Keep the process/window invisible while exercising foreground routing.
  Object.defineProperty(document, "hasFocus", { value: () => true });
  const history = '<article tabindex="-1" id="history">历史消息</article>';
  for (const from of ["toolbar", "history"]) {
    page(toolbar + history + rich);
    focus(from);
    select(byId("history").firstChild, 0, 2);
    check(prepare() && active("chatInput"), "composer not focused from " + from);
    // AIChat intercepts single-line text/plain paste on the composer and
    // inserts its text with WebKit's native editing command.
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", "口述");
    byId("chatInput").addEventListener("paste", event => {
      event.preventDefault();
      insert(event.clipboardData.getData("text/plain"));
    }, { once: true });
    const pasted = document.activeElement.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true, cancelable: true, clipboardData,
    }));
    check(!pasted, "composer did not receive paste");
    check(byId("history").textContent === "历史消息", "overwrote history selection");
    check(byId("chatInput").textContent === "前@资料草稿口述", "dictation did not append to rich draft");
    check(byId("chatInput").querySelector(".composer-file-ref")?.textContent === "@资料", "lost rich chip");
  }

  page(rich);
  focus("chatInput");
  select(byId("chatInput").lastChild, 1, 2);
  check(prepare() && getSelection().toString() === "稿", "lost active rich selection");
  insert("字");
  check(byId("chatInput").textContent === "前@资料草字", "did not replace selected rich text");

  page(toolbar + '<textarea id="chatInput">保留草稿</textarea>');
  focus("toolbar");
  check(prepare() && active("chatInput"), "legacy textarea not focused");
  byId("chatInput").setSelectionRange(1, 3);
  check(prepare() && byId("chatInput").selectionStart === 1 && byId("chatInput").selectionEnd === 3,
    "lost active textarea selection");
  insert("新");
  check(byId("chatInput").value === "保新稿", "wrong textarea insertion position");

  page('<input id="search" value="搜索词">' + rich);
  focus("search");
  byId("search").setSelectionRange(1, 2);
  check(prepare() && active("search") && byId("search").selectionStart === 1, "stole existing editable target");
  page('<iframe id="tool" title="子工具"></iframe>' + rich);
  focus("tool");
  check(prepare() && active("tool"), "stole embedded tool focus");

  page(rich + '<dialog id="modal"><input id="modalInput"><button id="ok">确认</button></dialog>');
  byId("modal").showModal();
  focus("modalInput");
  check(prepare() && active("modalInput"), "stole modal input focus");
  focus("ok");
  check(!prepare() && active("ok"), "routed behind modal");
  page(rich + '<section role="dialog" aria-modal="true"><button id="ok">确认</button></section>');
  focus("ok");
  check(!prepare() && active("ok"), "routed behind ARIA modal");
  page(toolbar + rich + '<section id="personaPage"><div class="persona-composer">' +
    '<textarea id="personaDraft" name="message">分身草稿</textarea></div></section>');
  focus("toolbar");
  check(prepare() && active("personaDraft"), "did not prefer persona composer");
  page(toolbar + rich + '<section class="remote-inline" role="region" open>' +
    '<div class="remote-composer"><div id="remoteDraft" class="remote-text-input" ' +
    'contenteditable="true"></div></div></section>');
  focus("toolbar");
  check(prepare() && active("remoteDraft"), "did not prefer the open remote conversation");
  byId("remoteDraft").setAttribute("contenteditable", "false");
  focus("toolbar");
  check(!prepare() && active("toolbar"), "focused the chat behind a read-only remote conversation");

  for (const id of ["imageInput", "videoInput"]) {
    page(toolbar + '<div hidden>' + rich + '</div><textarea id="' + id + '"></textarea>');
    focus("toolbar");
    check(prepare() && active(id), "did not focus visible " + id);
  }
  for (const unavailable of ["", '<div hidden>' + rich + '</div>',
    '<div style="visibility:hidden">' + rich + '</div>', '<div inert>' + rich + '</div>',
    '<textarea id="chatInput" readonly></textarea>', '<textarea id="chatInput" disabled></textarea>']) {
    page(toolbar + unavailable);
    focus("toolbar");
    check(!prepare() && active("toolbar"), "claimed missing or unavailable composer");
  }
  return "composer routing passed";
}

test("native remote dictation prepares only the foreground page's intended editor in WKWebView", {
  skip: process.platform !== "darwin", timeout: 30000,
}, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "keepwork-voice-composer-"));
  try {
    const js = await fs.readFile(path.join(__dirname, "../src-tauri/src/app/remote_voice_composer.js"), "utf8");
    const script = path.join(dir, "test.js");
    await fs.writeFile(script, `(${checkComposerRoute})(() => eval(${JSON.stringify(js)}))`);
    const adapter = path.join(dir, "webview");
    await execute("clang", ["-fobjc-arc", "-framework", "AppKit", "-framework", "WebKit",
      path.join(__dirname, "fixtures/remote_voice_composer_macos.m"), "-o", adapter], { timeout: 15000 });
    const { stdout } = await execute(adapter, [script], { timeout: 14000 });
    assert.match(stdout, /composer routing passed/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
