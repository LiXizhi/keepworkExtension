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

function pageNode(values = {}) {
  const node = Object.assign(values, eventTarget());
  const attributes = new Map(Object.entries(values.attributes || {}));
  node.childElementCount ??= 0;
  node.textContent ??= "";
  node.dataset ??= {};
  node.style ??= { display: "block", visibility: "visible" };
  node.queries ??= new Map();
  node.getAttribute = name => {
    if (name === "data-workbench-ready" && Object.hasOwn(node.dataset, "workbenchReady")) return node.dataset.workbenchReady;
    return attributes.has(name) ? attributes.get(name) : null;
  };
  node.setAttribute = (name, value) => attributes.set(name, String(value));
  node.removeAttribute = name => attributes.delete(name);
  node.querySelectorAll = selector => node.queries.get(selector) || [];
  node.querySelector = selector => node.querySelectorAll(selector)[0] || null;
  node.closest = () => node.hidden || node.hiddenAncestor || attributes.has("hidden") || attributes.get("aria-hidden") === "true" ? node : null;
  node.getClientRects = () => node.hasLayout === false ? [] : [{ width: 640, height: 480 }];
  node.layoutReads = 0;
  node.getBoundingClientRect = () => { node.layoutReads++; return { width: 640, height: 480 }; };
  return node;
}

function injectedPage({ url = "https://keepwork.com/chat", recoveryUrl = shellUrl, readyState = "loading", subframe = false, root = null, invoke, onVerifiedEntry,
  marker, progress = false, styles = [], dialogs = [], elements = {}, fonts = Object.assign(eventTarget(), { status: "loaded" }),
} = {}) {
  const calls = [];
  const observers = [];
  const window = Object.assign(eventTarget(), {
    location: new URL(url), getComputedStyle: node => node.style,
    matchMedia: media => ({ matches: media !== "print" }),
  });
  window.top = subframe ? {} : window;
  window.__TAURI_INTERNALS__ = {
    invoke(command, args) {
      calls.push({ command, args: JSON.parse(JSON.stringify(args)) });
      return invoke ? invoke(command, args) : Promise.resolve(command === "desktop_page_connection_attempt" ? 7 : true);
    },
  };
  const byId = new Map(Object.entries(elements));
  if (root) byId.set("app", pageNode(root));
  if (progress) byId.set("startup-progress", pageNode());
  const documentElement = pageNode();
  if (marker !== undefined) documentElement.dataset.workbenchReady = marker;
  const document = Object.assign(eventTarget(), {
    readyState, documentElement, fonts,
    getElementById: id => byId.get(id) || null,
    querySelectorAll: selector => selector === 'link[rel~="stylesheet"]' ? styles : dialogs,
  });
  class MutationObserver {
    constructor(callback) { this.callback = callback; this.connected = false; observers.push(this); }
    observe(target, options) { this.target = target; this.options = options; this.connected = true; }
    disconnect() { this.connected = false; }
    fire() { if (this.connected) this.callback([]); }
  }
  const source = fs.readFileSync(path.join(appRoot, "src/pageConnection.js"), "utf8")
    .replace("export function", "function");
  vm.runInNewContext(`${source}\ninstallPageConnection(${JSON.stringify(privateToken)}, ${JSON.stringify(recoveryUrl)}${onVerifiedEntry ? ", onVerifiedEntry" : ""});`, {
    window, document, MutationObserver, onVerifiedEntry,
  });
  return { window, document, calls, observers, elements: byId, styles, dialogs, fonts,
    mutate() { observers.forEach(observer => observer.fire()); } };
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
  assert.equal((page.document.listeners.get("DOMContentLoaded") || []).length, 0);
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

test("a switched entry receives the appearance callback only after its captured native ticket is verified", async () => {
  const url = "http://localhost:4177/AIChat.html?theme=light#current-entry";
  const entries = [];
  let resolveAttempt;
  const page = injectedPage({ url, onVerifiedEntry: verified => entries.push(verified),
    invoke: command => command === "desktop_page_connection_attempt"
      ? new Promise(resolve => { resolveAttempt = resolve; }) : Promise.resolve(true) });
  await settle();
  assert.deepEqual(entries, [], "a URL alone does not authorize appearance changes");
  resolveAttempt(9);
  await settle();
  assert.deepEqual(entries, [url]);
  page.document.fire("DOMContentLoaded");
  page.document.fire("DOMContentLoaded");
  await settle();
  assert.deepEqual(entries, [url], "DOM readiness cannot replay the one-shot callback");
  assert.equal(page.calls.at(-1).command, "desktop_main_document_ready");
});

test("invalid, rejected, subframe and shell tickets never authorize the appearance fallback", async () => {
  const entries = [];
  for (const generation of [null, undefined, false, -1, 1.5, "7", NaN, Infinity]) {
    injectedPage({ invoke: async () => generation, onVerifiedEntry: url => entries.push(url) });
    await settle();
  }
  injectedPage({ invoke: async () => { throw Error("untrusted document"); }, onVerifiedEntry: url => entries.push(url) });
  injectedPage({ subframe: true, onVerifiedEntry: url => entries.push(url) });
  injectedPage({ url: shellUrl, onVerifiedEntry: url => entries.push(url) });
  await settle();
  assert.deepEqual(entries, []);
  const firstGeneration = [];
  injectedPage({ invoke: async () => 0, onVerifiedEntry: url => firstGeneration.push(url) });
  await settle();
  assert.deepEqual(firstGeneration, ["https://keepwork.com/chat"], "generation zero is a valid native ticket");
});

test("an optional appearance callback failure does not interrupt ordinary document readiness", async () => {
  const page = injectedPage({ readyState: "complete", onVerifiedEntry() { throw Error("appearance unavailable"); } });
  await settle();
  assert.deepEqual(page.calls.map(call => call.command), ["desktop_page_connection_attempt", "desktop_main_document_ready"]);
});

for (const invalidation of ["pagehide", "changed-url", "rendered-app"]) {
  test(`a late appearance ticket cannot modify a ${invalidation} document`, async () => {
    const entries = [];
    const root = { childElementCount: 0, textContent: "" };
    let resolveAttempt;
    const page = injectedPage({ url: "http://localhost:4177/AIChat.html", root,
      invoke: command => command === "desktop_page_connection_attempt"
        ? new Promise(resolve => { resolveAttempt = resolve; }) : Promise.resolve(true),
      onVerifiedEntry: url => entries.push(url) });
    if (invalidation === "pagehide") page.window.fire("pagehide");
    if (invalidation === "changed-url") page.window.location = new URL("http://localhost:4177/oauth/callback");
    if (invalidation === "rendered-app") root.childElementCount = 1;
    resolveAttempt(12);
    await settle();
    assert.deepEqual(entries, [], "late native verification cannot override a document that has handed off theme ownership");
  });
}

test("known AIChat documents with an empty app wait for rendering instead of accepting cached HTML alone", async () => {
  for (const url of ["https://keepwork.com/chat", "http://127.0.0.1:3001/AIChat.html", "http://localhost:3001/local/AIChat.html"]) {
    const root = { childElementCount: 0, textContent: " \n " };
    const page = injectedPage({ url, root });
    page.document.fire("DOMContentLoaded");
    await settle();
    assert.equal(page.calls.length, 1, url);
    assert.equal(page.observers.length, 1);
    assert.equal(page.observers[0].target, page.document.documentElement, "observe the marker and progress element outside #app too");
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

test("older rendered layouts or nonempty error UI remain usable without a new readiness marker", async () => {
  for (const root of [{ childElementCount: 1, textContent: "" }, { childElementCount: 0, textContent: "登录提示" }]) {
    const page = injectedPage({ root, readyState: "interactive" });
    await settle();
    assert.equal(page.calls.length, 2);
    assert.equal(page.observers[0].connected, false);
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
    assert.equal(page.observers[0].connected, false, url);
  }
});

test("an existing loading shell waits for the workbench marker and removal of startup progress", async () => {
  const root = { childElementCount: 1, textContent: "Loading workspace…" };
  const page = injectedPage({ root, marker: "false", progress: true, readyState: "complete" });
  await settle();
  assert.equal(page.calls.length, 1, "the first child in #app is not a completed first screen");
  page.document.documentElement.dataset.workbenchReady = "true";
  page.mutate();
  await settle();
  assert.equal(page.calls.length, 1, "the boot progress element must disappear too");
  root.textContent = "Workspace actions";
  page.elements.delete("startup-progress");
  page.mutate();
  await settle();
  assert.equal(page.calls.length, 2);
  assert.equal(page.calls[1].command, "desktop_main_document_ready");
  assert.equal(page.observers[0].connected, false);
  assert.ok(page.document.documentElement.layoutReads > 0, "prepare layout before revealing the hidden window");
  assert.ok(page.observers[0].options.attributeFilter.includes("data-workbench-ready"));
});

test("older pages reject a busy root, loading-only placeholder, and an empty chat shell", async () => {
  const placeholders = ':scope > [role="progressbar"], :scope > [aria-busy="true"], :scope > .loading, :scope > .spinner';
  for (const busyRoot of [true, false]) {
    const root = { childElementCount: 1, textContent: "Loading…", queries: new Map() };
    if (busyRoot) root.attributes = { "aria-busy": "true" };
    else root.queries.set(placeholders, [pageNode()]);
    const page = injectedPage({ root, readyState: "complete" });
    await settle();
    assert.equal(page.calls.length, 1);
    root.removeAttribute("aria-busy");
    root.queries.delete(placeholders);
    const chat = pageNode();
    root.queries.set(".app-shell", [pageNode()]);
    root.queries.set(".scenario-pane.active", [pageNode({ id: "paneChat" })]);
    page.elements.set("chatMessages", chat);
    page.mutate();
    await settle();
    assert.equal(page.calls.length, 1, "a mounted shell with no initial chat content stays hidden");
    chat.textContent = "Start a new conversation";
    page.mutate();
    await settle();
    assert.equal(page.calls.length, 2, "a completed legacy first screen remains compatible without a marker");
  }
});

test("current first-screen stylesheet and fonts finish before readiness and their listeners are released", async () => {
  const stylesheet = pageNode({ sheet: null });
  const fonts = Object.assign(eventTarget(), { status: "loading" });
  const page = injectedPage({ root: { childElementCount: 1 }, marker: "true", styles: [stylesheet], fonts, readyState: "complete" });
  await settle();
  assert.equal(page.calls.length, 1);
  stylesheet.sheet = {};
  stylesheet.fire("load");
  await settle();
  assert.equal(page.calls.length, 1, "a ready document still waits for its current fonts");
  fonts.status = "loaded";
  fonts.fire("loadingdone");
  await settle();
  assert.equal(page.calls.length, 2);
  for (const event of ["load", "error"]) assert.equal(stylesheet.listeners.get(event).length, 0);
  for (const event of ["loadingdone", "loadingerror"]) assert.equal(fonts.listeners.get(event).length, 0);
  assert.equal(page.observers[0].connected, false);
  page.mutate();
  stylesheet.fire("load");
  fonts.fire("loadingdone");
  await settle();
  assert.equal(page.calls.length, 2, "readiness is one-shot and does not keep watching an opened chat");
});

test("failed critical CSS stays unready for native timeout recovery instead of showing an unstyled workspace", async () => {
  const stylesheet = pageNode({ sheet: null });
  const page = injectedPage({ root: { childElementCount: 1 }, marker: "true", styles: [stylesheet], readyState: "complete" });
  stylesheet.fire("error");
  page.mutate();
  await settle();
  assert.equal(stylesheet.sheet, null, "a browser keeps failed stylesheet.sheet null");
  assert.equal(page.calls.length, 1, "native owns the bounded 20-second failure/recovery path");
  assert.equal(page.observers[0].connected, true);
  page.window.fire("pagehide");
  assert.equal(page.observers[0].connected, false);
  assert.equal(stylesheet.listeners.get("error").length, 0);
});

test("disabled, nonmatching and already-loaded styles do not block older documents", async () => {
  const styles = [pageNode({ sheet: null, disabled: true }), pageNode({ sheet: null, media: "print" }), pageNode({ sheet: {} })];
  const page = injectedPage({ styles, fonts: null, readyState: "complete" });
  await settle();
  assert.equal(page.calls.length, 2);
  assert.ok(styles.every(link => link.listeners.size === 0));
});

test("usable login and modal prompts can finish a boot that is waiting for user interaction", async () => {
  for (const kind of ["login", "modal"]) {
    const prompt = pageNode({ queries: new Map() });
    prompt.queries.set(kind === "login" ? 'button:not([disabled])' : 'button:not([disabled]), input:not([disabled]), a[href]', [pageNode()]);
    const page = injectedPage({ root: { childElementCount: 1 }, marker: "false", progress: true, readyState: "complete",
      ...(kind === "login" ? { elements: { loginPromptBar: prompt } } : { dialogs: [prompt] }),
    });
    await settle();
    assert.equal(page.calls.length, 2, `${kind} must be visible so the user can complete initialization`);
  }
});

test("hidden or noninteractive prompts cannot reveal an incomplete workbench", async () => {
  for (const hidden of [{ hidden: true }, { hiddenAncestor: true }, { style: { display: "none" } }, { style: { visibility: "hidden" } }, { hasLayout: false }, { noControl: true }]) {
    const modal = pageNode({ ...hidden, queries: new Map() });
    if (!hidden.noControl) modal.queries.set('button:not([disabled]), input:not([disabled]), a[href]', [pageNode()]);
    const page = injectedPage({ root: { childElementCount: 1 }, marker: "false", progress: true, dialogs: [modal], readyState: "complete" });
    await settle();
    assert.equal(page.calls.length, 1, JSON.stringify(hidden));
    page.window.fire("pagehide");
  }
});

test("pagehide or a changed URL invalidates a delayed readiness ticket", async () => {
  for (const invalidate of [page => page.window.fire("pagehide"), page => { page.window.location = new URL("https://keepwork.com/chat?different-document=1"); }]) {
    let resolveAttempt;
    const page = injectedPage({ root: { childElementCount: 1 }, marker: "true", readyState: "complete",
      invoke: command => command === "desktop_page_connection_attempt" ? new Promise(resolve => { resolveAttempt = resolve; }) : Promise.resolve(true),
    });
    invalidate(page);
    resolveAttempt(7);
    page.mutate();
    await settle();
    assert.equal(page.calls.length, 1, "an old document must not reveal itself after navigation");
  }
});

test("a stylesheet added while the native ticket is pending is rechecked before revealing the page", async () => {
  let resolveAttempt;
  const page = injectedPage({ root: { childElementCount: 1 }, marker: "true", readyState: "complete",
    invoke: command => command === "desktop_page_connection_attempt" ? new Promise(resolve => { resolveAttempt = resolve; }) : Promise.resolve(true),
  });
  const stylesheet = pageNode({ sheet: null });
  page.styles.push(stylesheet);
  resolveAttempt(17);
  await settle();
  assert.equal(page.calls.length, 1);
  stylesheet.sheet = {};
  stylesheet.fire("load");
  await settle();
  assert.equal(page.calls.length, 2);
  assert.equal(page.calls[1].args.generation, 17, "the captured attempt remains unchanged");
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
  const themeEvents = [];
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
    documentElement: { dataset: {} },
    dispatchEvent(event) {
      themeEvents.push({ type: event.type, theme: document.documentElement.dataset.theme });
      return true;
    },
    getElementById(id) {
      if (!elements.has(id)) {
        const attributes = new Map();
        if (id === "startup") attributes.set("aria-busy", "true");
        const element = Object.assign(eventTarget(), {
          textContent: "", disabled: false, hidden: id === "recovery",
          dataset: id === "startup" ? { state: "connecting" } : {},
          setAttribute(name, value) { attributes.set(name, String(value)); },
          getAttribute(name) { return attributes.get(name) ?? null; },
        });
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
    exports: {}, window, document, Event, navigator: { platform: "MacIntel", onLine: false },
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
    window, document, calls, timers, themeEvents,
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
  assert.equal(page.element("startup").dataset.state, "connecting", "normal startup shows the compact loading state");
  assert.equal(page.element("startup").getAttribute("aria-busy"), "true");
  assert.equal(page.element("recovery").hidden, true, "diagnostics must not flash before a failure");
  assert.equal(page.document.documentElement.dataset.theme, undefined, "the native backdrop remains visible until the theme snapshot arrives");
  assert.deepEqual(page.themeEvents, []);
  resolveStatus(desktopStatus({ phase: "idle", error: "" }));
  await settle();
  assert.deepEqual(page.delays(), [0]);
  await page.advance(0);
  assert.deepEqual(page.retries(), [{ name: "retry", automatic: false }]);
  assert.equal(page.element("reload").disabled, true);
  assert.equal(page.element("recovery").hidden, true);
  assert.equal(page.document.documentElement.dataset.theme, "light");
  page.window.fire("online");
  page.element("reload").click();
  await page.advance(60000);
  assert.equal(page.retries().length, 1, "an unresolved navigation cannot start a competing attempt");
});

test("startup applies the current profile theme and signals chrome before connecting", async () => {
  for (const [theme, expected] of [["light", "light"], ["dark", "dark"], [undefined, "light"], ["unknown", "light"]]) {
    const page = await connectionPage({ status: { ...desktopStatus({ phase: "idle", error: "" }), theme } });
    assert.equal(page.document.documentElement.dataset.theme, expected);
    assert.deepEqual(page.themeEvents, [{ type: "aichat:theme-changed", theme: expected }]);
    assert.deepEqual(page.retries(), [], "theme is resolved before scheduling the first navigation");
    await page.advance(0);
    assert.deepEqual(page.retries(), [{ name: "retry", automatic: false }]);
    assert.equal(page.document.documentElement.dataset.theme, expected);
  }
});

test("a recovery document reads the latest theme snapshot instead of a previous startup choice", async () => {
  const first = await connectionPage({ status: { ...desktopStatus({ phase: "idle" }), theme: "light" } });
  assert.equal(first.document.documentElement.dataset.theme, "light");
  first.window.fire("pagehide");
  const recovery = await connectionPage({ status: { ...desktopStatus(), theme: "dark" } });
  assert.equal(recovery.document.documentElement.dataset.theme, "dark");
  assert.deepEqual(recovery.themeEvents, [{ type: "aichat:theme-changed", theme: "dark" }]);
  assert.equal(recovery.element("recovery").hidden, false);
});

test("healthy startup phases keep diagnostics hidden while a failed connection exposes recovery", async () => {
  for (const phase of ["idle", "connecting", "ready"]) {
    const page = await connectionPage({ status: desktopStatus({ phase, error: "" }) });
    assert.equal(page.element("startup").dataset.state, "connecting", phase);
    assert.equal(page.element("startup").getAttribute("aria-busy"), "true", phase);
    assert.equal(page.element("recovery").hidden, true, phase);
  }
  const failed = await connectionPage();
  assert.equal(failed.element("startup").dataset.state, "unavailable");
  assert.equal(failed.element("startup").getAttribute("aria-busy"), "false");
  assert.equal(failed.element("recovery").hidden, false);
  failed.element("reload").click();
  await settle();
  assert.equal(failed.element("startup").dataset.state, "connecting", "retry returns to loading feedback");
  assert.equal(failed.element("recovery").hidden, true, "diagnostics stay out of the normal navigation state");
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
  assert.equal(starting.document.documentElement.dataset.theme, undefined, "a disposed page cannot apply a late theme snapshot");
  assert.deepEqual(starting.themeEvents, []);
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
  assert.equal(page.element("startup").dataset.state, "unavailable", "an IPC failure must not leave a permanent spinner");
  assert.equal(page.element("recovery").hidden, false, "manual recovery remains reachable");
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
  assert.equal(page.element("startup").dataset.state, "unavailable");
  assert.equal(page.element("recovery").hidden, false, "older hosts keep their manual menu reload controls");
  assert.equal(page.document.documentElement.dataset.theme, "light", "old hosts without a theme field retain the application default");
  page.window.fire("online");
  page.element("reload").click();
  await settle();
  assert.deepEqual(page.calls, [{ name: "bridge-status" }, { name: "menu", id: "reload" }]);
  assert.doesNotMatch(page.element("detail").textContent, /secret-query-value|private-fragment/);
});

test("an unavailable startup status leaves recovery controls visible", async () => {
  const page = await connectionPage({ statusPromise: Promise.reject(new Error("Status unavailable")) });
  assert.equal(page.element("startup").dataset.state, "unavailable");
  assert.equal(page.element("recovery").hidden, false);
  assert.equal(page.document.documentElement.dataset.theme, "light");
  assert.match(page.element("headline").textContent, /暂时无法打开/);
  assert.deepEqual(page.delays(), []);
});
