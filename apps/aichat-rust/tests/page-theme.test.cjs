const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../src/pageTheme.js"), "utf8").replace("export function", "function");
const entryUrl = "http://localhost:3001/AIChat.html";

function pageTheme({ url = entryUrl, entry = entryUrl, hour = 12, storage = {}, blockedStorage = false,
  subframe = false, shell = false, parsing = "body" } = {}) {
  class Target {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, callback) { this.listeners.set(type, [...(this.listeners.get(type) || []), callback]); }
    removeEventListener(type, callback) { this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== callback)); }
    fire(type) { for (const callback of [...(this.listeners.get(type) || [])]) callback({ type }); }
  }
  class Element {
    constructor() {
      this.attributes = new Map(); this.children = []; this.classes = new Set();
      this.classList = { contains: name => this.classes.has(name),
        toggle: (name, value) => value ? this.classes.add(name) : this.classes.delete(name) };
    }
    setAttribute(name, value) { this.attributes.set(name, value); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
    remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); }
  }
  const document = new Target();
  document.documentElement = parsing === "empty" ? null : new Element();
  document.head = document.documentElement?.appendChild(new Element()) || null;
  document.body = parsing === "body" ? document.documentElement.appendChild(new Element()) : null;
  document.createElement = () => new Element();
  const window = new Target();
  window.top = subframe ? {} : window;
  window.location = { href: url };
  if (shell) window.__AICHAT_PAGE_CONNECTION__ = {};
  const reads = [];
  window.localStorage = {
    getItem(key) { reads.push(key); if (blockedStorage) throw Error("Storage disabled"); return storage[key] ?? null; },
    setItem() { throw Error("Startup appearance must never write preferences"); },
  };
  const observers = [];
  class MutationObserver {
    constructor(callback) { this.callback = callback; this.connected = false; observers.push(this); }
    observe() { this.connected = true; }
    disconnect() { this.connected = false; }
  }
  const context = {
    window, document, URL, URLSearchParams, MutationObserver, Date: class { getHours() { return hour; } },
  };
  vm.runInNewContext(`${source}\ninstallPageTheme(${JSON.stringify(entry)});`, context);
  return { document, window, reads, observers,
    mutate() { for (const observer of observers) if (observer.connected) observer.callback([]); },
    mountRoot() { document.documentElement = new Element(); document.head = document.documentElement.appendChild(new Element()); },
    mountBody() { document.body = document.documentElement.appendChild(new Element()); },
    styles() { return document.head?.children.filter(child => child.textContent) || []; },
    reinstall(nextEntry = entry) { context.installPageTheme(nextEntry); },
  };
}

for (const [name, options, light] of [
  ["manual light at night", { hour: 23, storage: { "aichat:theme-mode": "manual", "aichat:theme": "light" } }, true],
  ["manual dark at noon", { hour: 12, storage: { "aichat:theme-mode": "manual", "aichat:theme": "dark" } }, false],
  ["automatic ignores stale dark", { hour: 12, storage: { "aichat:theme": "dark" } }, true],
  ["automatic ignores stale light", { hour: 23, storage: { "aichat:theme-mode": "auto", "aichat:theme": "light" } }, false],
  ["just before dawn", { hour: 6 }, false], ["dawn", { hour: 7 }, true],
  ["just before dusk", { hour: 18 }, true], ["dusk", { hour: 19 }, false],
  ["query theme wins over hash", { url: `${entryUrl}?theme=%20LIGHT%20#theme=dark`, hour: 23 }, true],
  ["hash theme", { url: `${entryUrl}#theme=dark`, hour: 12 }, false],
  ["invalid query does not use hash", { url: `${entryUrl}?theme=unknown#theme=light`, hour: 23 }, false],
  ["empty query does not use hash", { url: `${entryUrl}?theme=#theme=dark`, hour: 12 }, true],
  ["invalid manual preference", { storage: { "aichat:theme-mode": "manual", "aichat:theme": "unknown" }, hour: 23 }, true],
  ["unreadable storage", { blockedStorage: true, hour: 12 }, true],
]) {
  test(`early page theme: ${name}`, () => {
    const page = pageTheme(options);
    assert.equal(page.document.body.classList.contains("light"), light);
    assert.equal(page.document.documentElement.classList.contains("light"), false);
    assert.equal(page.document.documentElement.getAttribute("data-theme"), null);
    assert.equal(page.document.documentElement.getAttribute("data-aichat-desktop-boot-theme"), null);
    assert.deepEqual(page.styles(), []);
    assert.equal(page.observers.filter(observer => observer.connected).length, 0, "theme ownership returns to the real page immediately");
  });
}

test("early theme waits for parsing, removes temporary root colors and never reapplies after page takeover", () => {
  const page = pageTheme({ parsing: "empty", hour: 23,
    storage: { "aichat:theme-mode": "manual", "aichat:theme": "light" } });
  assert.equal(page.observers[0].connected, true);
  page.mountRoot(); page.mutate();
  assert.equal(page.document.documentElement.getAttribute("data-aichat-desktop-boot-theme"), "light");
  assert.match(page.styles()[0].textContent, /background: #ffffff/);
  page.mountBody(); page.mutate();
  assert.equal(page.document.body.classList.contains("light"), true);
  assert.deepEqual(page.styles(), []);
  assert.equal(page.document.documentElement.getAttribute("data-aichat-desktop-boot-theme"), null);
  assert.equal(page.observers[0].connected, false);
  assert.equal(page.document.listeners.get("DOMContentLoaded").length, 0);
  page.document.body.classList.toggle("light", false);
  page.mutate(); page.document.fire("DOMContentLoaded");
  assert.equal(page.document.body.classList.contains("light"), false, "the user's later dark-mode selection remains authoritative");
});

test("leaving before body parsing cleans up the pending root theme and observer", () => {
  const page = pageTheme({ parsing: "head", hour: 23 });
  assert.match(page.styles()[0].textContent, /background: #181818/);
  page.window.fire("pagehide");
  assert.deepEqual(page.styles(), []);
  assert.equal(page.document.documentElement.getAttribute("data-aichat-desktop-boot-theme"), null);
  assert.equal(page.observers[0].connected, false);
  page.mountBody(); page.mutate();
  assert.equal(page.document.body.classList.contains("light"), false);
});

test("a native verified-entry retry can authorize a changed origin but cannot overwrite page takeover twice", () => {
  const url = "http://localhost:4177/AIChat.html";
  const page = pageTheme({ url, hour: 23, storage: { "aichat:theme-mode": "manual", "aichat:theme": "light" } });
  assert.deepEqual(page.reads, [], "the original entry does not match the new menu-selected origin");
  page.reinstall(url);
  assert.equal(page.document.body.classList.contains("light"), true);
  assert.equal(page.observers.length, 1);
  const readCount = page.reads.length;
  page.document.body.classList.toggle("light", false);
  page.reinstall(url);
  assert.equal(page.document.body.classList.contains("light"), false, "a second install cannot revert the page's later theme choice");
  assert.equal(page.reads.length, readCount);
  assert.equal(page.observers.length, 1);
});

for (const url of [
  "https://evil.example/chat", "http://localhost:3002/AIChat.html", "http://localhost:3001/oauth/callback",
  "http://localhost:3001/AIChat.html/", "https://keepwork.com/chat/register", "https://keepwork.com/sso/callback",
  "https://name:password@keepwork.com/chat", "file:///tmp/AIChat.html", "about:blank",
]) {
  test(`early theme ignores a document outside the exact trusted entry: ${url}`, () => {
    const page = pageTheme({ url });
    assert.equal(page.document.body.classList.contains("light"), false);
    assert.deepEqual(page.reads, []);
    assert.deepEqual(page.observers, []);
  });
}

test("published chat remains supported while configured local origin/path validation stays exact", () => {
  const page = pageTheme({ url: "https://keepwork.com/chat?theme=light", hour: 23 });
  assert.equal(page.document.body.classList.contains("light"), true);
});

for (const options of [{ subframe: true }, { shell: true }, { entry: "https://name:password@keepwork.com/chat" }]) {
  test(`early theme cannot change subframes, native shells or credential-bearing entry configuration: ${JSON.stringify(options)}`, () => {
    const page = pageTheme(options);
    assert.deepEqual(page.reads, []);
    assert.deepEqual(page.observers, []);
  });
}
