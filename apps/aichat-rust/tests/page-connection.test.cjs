const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const appRoot = path.resolve(__dirname, "..");
const shellUrl = "tauri://localhost/index.html";
const privateToken = "private-host-test-token";
const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise(setImmediate);
};

function eventTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(name, callback, options = {}) {
      const items = listeners.get(name) || [];
      items.push({ callback, once: !!options.once });
      listeners.set(name, items);
    },
    removeEventListener(name, callback) {
      listeners.set(name, (listeners.get(name) || []).filter(item => item.callback !== callback));
    },
    fire(name, extra = {}) {
      for (const listener of [...(listeners.get(name) || [])]) {
        listener.callback({ type: name, ...extra });
        if (listener.once) this.removeEventListener(name, listener.callback);
      }
    },
  };
}

function injectedPage({ url = "https://keepwork.com/chat", recoveryUrl = shellUrl, readyState = "loading", subframe = false, root = null, invoke } = {}) {
  const calls = [];
  const observers = [];
  const window = Object.assign(eventTarget(), { location: new URL(url) });
  window.top = subframe ? {} : window;
  window.__TAURI_INTERNALS__ = {
    invoke(command, args) {
      calls.push({ command, args: JSON.parse(JSON.stringify(args)) });
      return invoke ? invoke(command, args) : Promise.resolve(command === "desktop_page_connection_attempt" ? 7 : true);
    },
  };
  const document = Object.assign(eventTarget(), { readyState, getElementById: id => id === "app" ? root : null });
  class MutationObserver {
    constructor(callback) { this.callback = callback; this.connected = false; observers.push(this); }
    observe(target, options) { this.target = target; this.options = options; this.connected = true; }
    disconnect() { this.connected = false; }
    fire() { if (this.connected) this.callback([]); }
  }
  const source = fs.readFileSync(path.join(appRoot, "src/pageConnection.js"), "utf8")
    .replace("export function", "function");
  vm.runInNewContext(`${source}\ninstallPageConnection(${JSON.stringify(privateToken)}, ${JSON.stringify(recoveryUrl)});`, {
    window, document, MutationObserver,
  });
  return { window, document, calls, observers, mutate() { observers.forEach(observer => observer.fire()); } };
}

test("document readiness is injected into older chat pages without adding recovery listeners", async () => {
  const url = "https://keepwork.com/chat?session=preserved#draft";
  const page = injectedPage({ url });
  assert.deepEqual(page.calls, [{ command: "desktop_page_connection_attempt", args: { url, token: privateToken } }]);
  assert.equal(page.window.aichatDesktop, undefined, "readiness cannot require a newer AIChat bridge");
  assert.equal(page.window.__AICHAT_PAGE_CONNECTION__, undefined);
  assert.equal(page.window.listeners.has("online"), false);
  assert.equal(page.window.listeners.has("offline"), false);
  page.document.fire("DOMContentLoaded");
  page.document.fire("DOMContentLoaded");
  await settle();
  assert.deepEqual(page.calls, [
    { command: "desktop_page_connection_attempt", args: { url, token: privateToken } },
    { command: "desktop_main_document_ready", args: { url, generation: 7, token: privateToken } },
  ]);
  page.window.fire("offline");
  page.window.fire("online");
  await settle();
  assert.equal(page.calls.length, 2, "network changes must not reload or replay an opened chat");
  assert.ok(!Object.values(page.window).includes(privateToken), "private host token stays inside the closure");
});

test("already loaded documents report readiness and a rejected report stays bounded", async () => {
  const page = injectedPage({ readyState: "complete", invoke: async command => {
    if (command === "desktop_page_connection_attempt") return 7;
    throw new Error("stale document");
  } });
  await settle();
  assert.equal(page.calls.length, 2);
  assert.equal(page.calls[1].command, "desktop_main_document_ready");
  assert.equal(page.document.listeners.has("DOMContentLoaded"), false);
});

test("DOMContentLoaded waits for the captured attempt ticket instead of using a later generation", async () => {
  let resolveAttempt;
  const page = injectedPage({ invoke: command => command === "desktop_page_connection_attempt"
    ? new Promise(resolve => { resolveAttempt = resolve; }) : Promise.resolve(true) });
  page.document.fire("DOMContentLoaded");
  await settle();
  assert.equal(page.calls.length, 1);
  resolveAttempt(19);
  await settle();
  assert.deepEqual(page.calls[1], {
    command: "desktop_main_document_ready", args: { url: "https://keepwork.com/chat", generation: 19, token: privateToken },
  });
});

test("rejected and absent attempt tickets never mark a document ready", async () => {
  for (const invoke of [async () => null, async () => { throw new Error("unauthorized document"); }]) {
    const page = injectedPage({ invoke });
    await settle();
    page.document.fire("DOMContentLoaded");
    await settle();
    assert.equal(page.calls.length, 1);
    assert.equal(page.calls[0].command, "desktop_page_connection_attempt");
  }
});

test("known AIChat documents with an empty app wait for rendering instead of accepting cached HTML alone", async () => {
  for (const url of ["https://keepwork.com/chat", "http://127.0.0.1:3001/AIChat.html", "http://localhost:3001/local/AIChat.html"]) {
    const root = { childElementCount: 0, textContent: " \n " };
    const page = injectedPage({ url, root });
    page.document.fire("DOMContentLoaded");
    await settle();
    assert.equal(page.calls.length, 1, url);
    assert.equal(page.observers.length, 1);
    assert.equal(page.observers[0].target, root);
    assert.equal(page.observers[0].options.childList, true);
    assert.equal(page.observers[0].options.characterData, true);
    page.mutate();
    await settle();
    assert.equal(page.calls.length, 1, "whitespace and empty mutations do not mean the app rendered");
    root.childElementCount = 1;
    page.mutate();
    await settle();
    assert.equal(page.calls.length, 2);
    assert.equal(page.calls[1].command, "desktop_main_document_ready");
    assert.equal(page.observers[0].connected, false);
    assert.equal(page.window.listeners.get("pagehide").length, 0);
    root.childElementCount = 0;
    page.mutate();
    page.window.fire("online");
    await settle();
    assert.equal(page.calls.length, 2, "an opened app is never monitored or reloaded again");
  }
});

test("rendered child elements or nonempty text accept the known app without waiting for further network resources", async () => {
  for (const root of [{ childElementCount: 1, textContent: "" }, { childElementCount: 0, textContent: "登录提示" }]) {
    const page = injectedPage({ root, readyState: "interactive" });
    await settle();
    assert.equal(page.calls.length, 2);
    assert.equal(page.observers.length, 0);
  }
  const root = { childElementCount: 0, textContent: "" };
  const loading = injectedPage({ root });
  loading.document.fire("DOMContentLoaded");
  root.textContent = "无法连接登录服务，请重试";
  loading.mutate();
  await settle();
  assert.equal(loading.calls.length, 2, "a rendered error UI is still a usable page");
});

test("navigating away from a blank app disconnects its render observer without reporting success", async () => {
  const root = { childElementCount: 0, textContent: "" };
  const page = injectedPage({ root, readyState: "complete" });
  assert.equal(page.observers[0].connected, true);
  page.window.fire("pagehide");
  assert.equal(page.observers[0].connected, false);
  root.childElementCount = 1;
  page.mutate();
  await settle();
  assert.equal(page.calls.length, 1);
});

test("legacy documents with no app root and unknown custom layouts retain DOM readiness semantics", async () => {
  const root = { childElementCount: 0, textContent: "" };
  for (const url of ["https://keepwork.com/custom-entry", "http://localhost:3001/custom.html", "https://custom.example/AIChat.html"]) {
    const page = injectedPage({ url, root, readyState: "complete" });
    await settle();
    assert.equal(page.calls.length, 2, url);
    assert.equal(page.observers.length, 0, url);
  }
});

test("tool frames and login subframes never receive recovery controls or publish readiness", async () => {
  for (const url of [shellUrl, "https://keepwork.com/chat", "https://accounts.google.com/login"]) {
    const page = injectedPage({ url, subframe: true, readyState: "complete" });
    page.document.fire("DOMContentLoaded");
    await settle();
    assert.deepEqual(page.calls, []);
    assert.equal(page.window.__AICHAT_PAGE_CONNECTION__, undefined);
    assert.equal(page.document.listeners.size, 0);
  }
});

test("only the exact host connection page receives the frozen private recovery API", async () => {
  const page = injectedPage({ url: shellUrl, readyState: "complete" });
  const api = page.window.__AICHAT_PAGE_CONNECTION__;
  assert.ok(Object.isFrozen(api));
  const descriptor = Object.getOwnPropertyDescriptor(page.window, "__AICHAT_PAGE_CONNECTION__");
  assert.equal(descriptor.writable, false);
  assert.equal(descriptor.configurable, false);
  assert.deepEqual(page.calls, [], "local connection page cannot mark the chat ready");
  await api.status();
  await api.retry();
  await api.retry(true);
  assert.deepEqual(page.calls, [
    { command: "desktop_page_connection_status", args: { token: privateToken } },
    { command: "desktop_retry_page_connection", args: { automatic: false, token: privateToken } },
    { command: "desktop_retry_page_connection", args: { automatic: true, token: privateToken } },
  ]);
  for (const url of [`${shellUrl}?foreign=1`, `${shellUrl}#foreign`, "https://evil.example/index.html", "tauri://localhost/pet.html"]) {
    const other = injectedPage({ url });
    assert.equal(other.window.__AICHAT_PAGE_CONNECTION__, undefined, url);
  }
});

test("macOS, Windows and development shell identities match exactly without path or port aliases", async () => {
  for (const recoveryUrl of ["tauri://localhost/", "http://tauri.localhost/", "http://127.0.0.1:1430/"]) {
    const shell = injectedPage({ url: recoveryUrl, recoveryUrl });
    assert.ok(shell.window.__AICHAT_PAGE_CONNECTION__, recoveryUrl);
    await shell.window.__AICHAT_PAGE_CONNECTION__.status();
    assert.deepEqual(shell.calls, [{ command: "desktop_page_connection_status", args: { token: privateToken } }]);
    const aliases = [
      `${recoveryUrl}index.html`, `${recoveryUrl}other.html`, `${recoveryUrl}?retry=1`, `${recoveryUrl}#retry`,
      "http://localhost:1430/", "http://127.0.0.1:1431/",
    ].filter(url => url !== recoveryUrl);
    if (recoveryUrl.startsWith("tauri:")) aliases.push(recoveryUrl.slice(0, -1));
    for (const url of aliases) {
      const other = injectedPage({ url, recoveryUrl });
      assert.equal(other.window.__AICHAT_PAGE_CONNECTION__, undefined, `${recoveryUrl} alias ${url}`);
      assert.deepEqual(other.calls.map(call => call.command), ["desktop_page_connection_attempt"]);
    }
  }
});

function desktopStatus(connection = {}) {
  return {
    entryUrl: "https://keepwork.com/chat?token=secret-query-value#private-fragment",
    mcp: { port: 8089, state: "running" },
    pageConnection: {
      phase: "unavailable", entryOrigin: "https://keepwork.com", localEntry: false,
      autoRetries: 0, maxAutoRetries: 3, error: "页面连接超时。", ...connection,
    },
  };
}

async function connectionPage({ status = desktopStatus(), statusPromise, retry, legacy = false } = {}) {
  const calls = [];
  const timers = new Map();
  const elements = new Map();
  let clock = 0;
  let nextTimer = 0;
  const window = eventTarget();
  const recovery = {
    status() { calls.push({ name: "status" }); return statusPromise || Promise.resolve(status); },
    retry(automatic) { calls.push({ name: "retry", automatic }); return retry ? retry(automatic) : Promise.resolve(); },
  };
  if (!legacy) window.__AICHAT_PAGE_CONNECTION__ = recovery;
  const bridge = {
    status() { calls.push({ name: "bridge-status" }); return statusPromise || Promise.resolve(status); },
    runMenuCommand(id) { calls.push({ name: "menu", id }); return Promise.resolve(true); },
  };
  const document = {
    getElementById(id) {
      if (!elements.has(id)) {
        const element = Object.assign(eventTarget(), { textContent: "", disabled: false });
        element.click = () => { if (!element.disabled) element.fire("click"); };
        elements.set(id, element);
      }
      return elements.get(id);
    },
  };
  const source = ts.transpileModule(fs.readFileSync(path.join(appRoot, "src/main.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, {
    exports: {}, window, document, navigator: { platform: "MacIntel", onLine: false },
    require(name) {
      if (name === "./bridge") return { installAIChatDesktopBridge: () => bridge };
      if (name === "./titlebar") return { mountDesktopTitlebar() {} };
      throw new Error(`Unexpected dependency: ${name}`);
    },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, due: clock + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  await settle();
  return {
    window, calls, timers,
    element: id => document.getElementById(id),
    retries: () => calls.filter(call => call.name === "retry"),
    delays: () => [...timers.values()].map(timer => timer.due - clock),
    async advance(milliseconds) {
      clock += milliseconds;
      for (const [id, timer] of [...timers]) {
        if (timer.due <= clock && timers.delete(id)) timer.callback();
      }
      await settle();
    },
  };
}

test("the local startup page waits for status then opens the configured entry exactly once", async () => {
  let resolveStatus;
  const page = await connectionPage({ statusPromise: new Promise(resolve => { resolveStatus = resolve; }) });
  assert.deepEqual(page.delays(), []);
  assert.deepEqual(page.retries(), []);
  resolveStatus(desktopStatus({ phase: "idle", error: "" }));
  await settle();
  assert.deepEqual(page.delays(), [0]);
  await page.advance(0);
  assert.deepEqual(page.retries(), [{ name: "retry", automatic: false }]);
  assert.equal(page.element("reload").disabled, true);
  page.window.fire("online");
  page.element("reload").click();
  await page.advance(60000);
  assert.equal(page.retries().length, 1, "an unresolved navigation cannot start a competing attempt");
});

test("automatic recovery uses 5/15/30 second backoff and stops at the native budget", async () => {
  for (const [autoRetries, delay] of [[0, 5000], [1, 15000], [2, 30000]]) {
    const page = await connectionPage({ status: desktopStatus({ autoRetries }) });
    assert.deepEqual(page.delays(), [delay]);
    await page.advance(delay - 1);
    assert.deepEqual(page.retries(), []);
    await page.advance(1);
    assert.deepEqual(page.retries(), [{ name: "retry", automatic: true }]);
    assert.match(page.element("retry-status").textContent, /20 秒/);
  }
  const exhausted = await connectionPage({ status: desktopStatus({ autoRetries: 3 }) });
  assert.deepEqual(exhausted.delays(), []);
  assert.match(exhausted.element("retry-status").textContent, /自动重试已暂停/);
  exhausted.window.fire("online");
  await exhausted.advance(60000);
  assert.deepEqual(exhausted.retries(), []);
  exhausted.element("reload").click();
  await settle();
  assert.deepEqual(exhausted.retries(), [{ name: "retry", automatic: false }]);
});

test("online wakes only a failed connection and coalesces timer, keyboard and click retries", async () => {
  const page = await connectionPage();
  page.window.fire("online");
  page.window.fire("online");
  page.element("reload").click();
  let prevented = 0;
  page.window.fire("keydown", { key: "r", ctrlKey: true, preventDefault() { prevented++; } });
  await page.advance(60000);
  assert.deepEqual(page.retries(), [{ name: "retry", automatic: true }]);
  assert.equal(prevented, 1);
  assert.deepEqual(page.delays(), []);
  for (const phase of ["connecting", "ready"]) {
    const active = await connectionPage({ status: desktopStatus({ phase }) });
    active.window.fire("online");
    await active.advance(60000);
    assert.deepEqual(active.retries(), [], phase);
  }
});

test("manual retry cancels pending backoff and Cmd+R uses recovery instead of reloading the shell", async () => {
  const page = await connectionPage();
  let prevented = false;
  page.window.fire("keydown", { key: "R", metaKey: true, preventDefault() { prevented = true; } });
  await page.advance(60000);
  assert.equal(prevented, true);
  assert.deepEqual(page.retries(), [{ name: "retry", automatic: false }]);
  assert.deepEqual(page.calls.filter(call => call.name === "menu"), []);
});

test("page disposal cancels backoff, ignores online, and ignores a late startup snapshot", async () => {
  const failed = await connectionPage();
  failed.window.fire("pagehide");
  failed.window.fire("online");
  failed.element("reload").click();
  await failed.advance(60000);
  assert.deepEqual(failed.delays(), []);
  assert.deepEqual(failed.retries(), []);
  let resolveStatus;
  const starting = await connectionPage({ statusPromise: new Promise(resolve => { resolveStatus = resolve; }) });
  starting.window.fire("pagehide");
  resolveStatus(desktopStatus({ phase: "idle" }));
  await starting.advance(60000);
  assert.deepEqual(starting.delays(), []);
  assert.deepEqual(starting.retries(), []);
});

test("connection diagnostics show a safe origin and distinguish local entry from the MCP service", async () => {
  const page = await connectionPage();
  assert.match(page.element("detail").textContent, /https:\/\/keepwork\.com/);
  assert.match(page.element("detail").textContent, /本机服务：运行中（8089）/);
  assert.match(page.element("headline").textContent, /暂时无法打开/);
  assert.doesNotMatch(page.element("detail").textContent, /secret-query-value|private-fragment|token=/);
  const local = await connectionPage({ status: desktopStatus({ localEntry: true, entryOrigin: "http://127.0.0.1:3001" }) });
  assert.match(local.element("summary").textContent, /本地页面服务/);
  assert.match(local.element("detail").textContent, /127\.0\.0\.1:3001/);
  local.element("updates").click();
  await settle();
  assert.deepEqual(local.calls.filter(call => call.name === "menu"), [{ name: "menu", id: "check-updates" }]);
});

test("a failed recovery invocation re-enables manual retry without replaying it automatically", async () => {
  let fail = true;
  const page = await connectionPage({ retry: async () => { if (fail) throw new Error("IPC unavailable"); } });
  page.element("reload").click();
  await settle();
  assert.equal(page.element("reload").disabled, false);
  assert.match(page.element("retry-status").textContent, /无法重试/);
  await page.advance(60000);
  assert.equal(page.retries().length, 1);
  fail = false;
  page.element("reload").click();
  await settle();
  assert.equal(page.retries().length, 2);
});

test("older hosts without the private recovery API retain manual menu reload and bounded diagnostics", async () => {
  const status = desktopStatus();
  delete status.pageConnection;
  const page = await connectionPage({ status, legacy: true });
  assert.deepEqual(page.delays(), []);
  page.window.fire("online");
  page.element("reload").click();
  await settle();
  assert.deepEqual(page.calls, [{ name: "bridge-status" }, { name: "menu", id: "reload" }]);
  assert.doesNotMatch(page.element("detail").textContent, /secret-query-value|private-fragment/);
});
