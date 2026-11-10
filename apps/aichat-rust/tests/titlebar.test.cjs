const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const appRoot = path.resolve(__dirname, "..");
const titlebarSource = fs.readFileSync(path.join(appRoot, "src/titlebar.ts"), "utf8");
const titlebarJs = ts.transpileModule(titlebarSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const bridgeSource = fs.readFileSync(path.join(appRoot, "src-tauri/src/bridge.rs"), "utf8");
const rawBridge = bridgeSource.match(/r#"([\s\S]*?)"#/)[1];

// Model composed event bubbling across a CLOSED shadow root: listeners inside
// see the real target; host/document/window listeners see only the host. A
// duplicate host handler must therefore fail the same way it would in a webview.
function renderer(implementation, platform = "darwin", subframe = false) {
  class Target {
    constructor() { this.listeners = new Map(); this.parentNode = null; }
    addEventListener(type, callback, options) {
      const listeners = this.listeners.get(type) || [];
      listeners.push({ callback, capture: options === true || !!options?.capture, once: !!options?.once });
      this.listeners.set(type, listeners);
    }
    removeEventListener(type, callback) {
      this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item.callback !== callback));
    }
  }
  class Element extends Target {
    constructor(tag) {
      super();
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.attributes = new Map();
      this.dataset = {};
      this.style = { setProperty() {} };
      this.className = "";
      this.classList = { contains: name => this.className.split(/\s+/).includes(name) };
      this.shadowRoot = null;
    }
    get parentElement() { return this.parentNode instanceof Element ? this.parentNode : null; }
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    attachShadow(options) {
      const shadow = new Target();
      shadow.host = this;
      shadow.mode = options.mode;
      shadow.parentNode = this;
      shadow.children = [];
      shadow.append = (...children) => children.forEach(child => {
        child.parentNode = shadow;
        shadow.children.push(child);
      });
      shadow.querySelectorAll = selector => descendants(shadow).filter(el => el.matches(selector));
      this.testShadow = shadow;
      if (options.mode !== "closed") this.shadowRoot = shadow;
      return shadow;
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    matches(selector) {
      return selector.split(",").some(part => {
        const match = part.trim().match(/^(\w+)?(?:\.([\w-]+))?(?:\[([\w-]+)(?:=['"]?([^'"\]]+)['"]?)?\])?$/);
        if (!match) return false;
        const [, tag, className, attribute, value] = match;
        return (!tag || tag.toUpperCase() === this.tagName)
          && (!className || this.classList.contains(className))
          && (!attribute || (this.hasAttribute(attribute)
            && (value === undefined || this.getAttribute(attribute) === value)));
      });
    }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
    querySelectorAll(selector) { return descendants(this).filter(el => el.matches(selector)); }
    getBoundingClientRect() { return { left: 20, bottom: 34 }; }
    getContext() { return null; }
  }
  function descendants(parent) {
    return (parent.children || []).flatMap(child => [child, ...descendants(child)]);
  }
  const document = new Target();
  document.readyState = "complete";
  document.documentElement = new Element("html");
  document.documentElement.parentNode = document;
  document.head = document.documentElement.appendChild(new Element("head"));
  document.body = document.documentElement.appendChild(new Element("body"));
  document.createElement = tag => new Element(tag);
  document.getElementById = id => [document.documentElement, ...descendants(document.documentElement)]
    .find(el => el.id === id) || null;
  const window = new Target();
  document.parentNode = window;
  window.top = subframe ? {} : window;
  window.location = { host: "localhost:57175", pathname: "/", href: "http://localhost:57175/", origin: "http://localhost:57175" };
  window.innerWidth = 1280;
  const calls = [];
  const messages = [];
  let maximized = false;
  const invoke = (command, args = {}) => {
    calls.push(JSON.parse(JSON.stringify({ command, args })));
    if (args.action === "toggle-maximize" || command.endsWith("toggle_maximize")) maximized = !maximized;
    return Promise.resolve(true);
  };
  window.__TAURI_INTERNALS__ = { invoke };
  window.postMessage = message => messages.push(message);
  const context = {
    window, document, Element, HTMLElement: Element,
    exports: {}, require: () => ({ invoke }),
    MutationObserver: class { observe() {} },
    getComputedStyle: () => ({ colorScheme: "light", getPropertyValue: () => "" }),
  };
  const bootstrap = { platform, iconDataUrl: "", menus: [{ id: "file", label: "文件" }], hostCommands: [], pageCommands: [] };
  if (implementation === "typescript") {
    vm.runInNewContext(titlebarJs, context);
    context.exports.mountDesktopTitlebar(bootstrap);
  } else {
    const javascript = rawBridge.replaceAll("{{", "{").replaceAll("}}", "}")
      .replace("{bootstrap}", JSON.stringify(bootstrap));
    vm.runInNewContext(javascript, context);
  }
  calls.length = 0; // Theme synchronization is unrelated to window gestures.
  function fire(target, type, extra = {}) {
    const eventPath = [];
    for (let node = target; node; node = node.parentNode) eventPath.push(node);
    const shadow = eventPath.find(node => node.mode === "closed");
    let stopped = false;
    let immediate = false;
    const event = {
      type, button: 0, detail: 1, clientX: 1000, clientY: 15, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { stopped = true; },
      stopImmediatePropagation() { stopped = immediate = true; },
      ...extra,
    };
    function visit(node, capture) {
      const outside = shadow && eventPath.indexOf(node) > eventPath.indexOf(shadow);
      event.target = outside ? shadow.host : target;
      event.currentTarget = node;
      event.composedPath = () => outside ? eventPath.slice(eventPath.indexOf(shadow.host)) : eventPath;
      for (const listener of [...(node.listeners.get(type) || [])]) {
        if (listener.capture !== capture) continue;
        listener.callback(event);
        if (listener.once) node.removeEventListener(type, listener.callback);
        if (immediate) break;
      }
    }
    for (const node of [...eventPath].reverse()) { visit(node, true); if (stopped) return event; }
    for (const node of eventPath) { visit(node, false); if (stopped) break; }
    return event;
  }
  const host = document.getElementById("keepwork-desktop-titlebar");
  return {
    host, window, document, calls, messages, fire,
    element: selector => host.testShadow.querySelectorAll(selector)[0],
    child(parent, tag) { return parent.appendChild(new Element(tag)); },
    actions: () => calls.map(call => call.command === "desktop_titlebar_action" ? call.args.action : call.command),
    maximized: () => maximized,
    doubleClick(target, extra = {}) {
      fire(target, "mousedown", { detail: 1, ...extra });
      fire(target, "mouseup", { detail: 1, ...extra });
      fire(target, "mousedown", { detail: 2, ...extra });
      fire(target, "mouseup", { detail: 2, ...extra });
    },
  };
}

for (const implementation of ["typescript", "rust-init-script"]) {
  for (const platform of ["darwin", "macos", "win32", "linux"]) {
    test(`${implementation} ${platform}: closed-shadow title, blank region and host padding toggle exactly once`, () => {
      for (const selector of [".right", ".title", null]) {
        const bar = renderer(implementation, platform);
        assert.equal(bar.host.shadowRoot, null);
        assert.equal(bar.host.testShadow.mode, "closed");
        const target = selector ? bar.element(selector) : bar.host;
        bar.doubleClick(target);
        assert.deepEqual(bar.actions(), ["drag", "toggle-maximize"]);
        assert.equal(bar.maximized(), true);
        bar.calls.length = 0;
        bar.doubleClick(target);
        assert.deepEqual(bar.actions(), ["drag", "toggle-maximize"]);
        assert.equal(bar.maximized(), false, "second double click must restore the window");
      }
    });
  }

  test(`${implementation}: macOS commits on second release while Windows commits on second press`, () => {
    for (const platform of ["darwin", "win32"]) {
      const bar = renderer(implementation, platform);
      const target = bar.element(".right");
      bar.fire(target, "mousedown", { detail: 2 });
      assert.deepEqual(bar.actions(), platform === "darwin" ? [] : ["toggle-maximize"]);
      bar.fire(target, "mouseup", { detail: 2 });
      assert.deepEqual(bar.actions(), ["toggle-maximize"]);
      bar.fire(target, "mouseup", { detail: 2 });
      assert.deepEqual(bar.actions(), ["toggle-maximize"], "orphan mouseup cannot replay a toggle");
    }
  });

  test(`${implementation}: macOS movement, blur, outside release and interactive release cancel maximization`, () => {
    for (const cancel of ["move", "blur", "outside", "button", "new-press", "moved-release"]) {
      const bar = renderer(implementation);
      const target = bar.element(".right");
      bar.fire(target, "mousedown", { detail: 2 });
      if (cancel === "move") {
        bar.fire(bar.document.body, "mousemove", { clientX: 1001 });
        bar.fire(bar.document.body, "mousemove", { clientX: 1000 });
      } else if (cancel === "blur") bar.fire(bar.window, "blur");
      else if (cancel === "outside") bar.fire(bar.document.body, "mouseup", { detail: 2 });
      else if (cancel === "button") bar.fire(bar.element(".refresh"), "mouseup", { detail: 2 });
      else if (cancel === "new-press") bar.fire(bar.element(".address"), "mousedown");
      else bar.fire(target, "mouseup", { detail: 2, clientX: 1001 });
      bar.fire(target, "mouseup", { detail: 2 });
      assert.deepEqual(bar.actions(), [], cancel);
      assert.equal(bar.maximized(), false, cancel);
    }
  });

  test(`${implementation}: address, refresh SVG and menu buttons stay interactive without window gestures`, () => {
    for (const platform of ["darwin", "win32"]) {
      const bar = renderer(implementation, platform);
      const address = bar.element(".address");
      const refresh = bar.element(".refresh");
      const svgPath = bar.child(bar.child(refresh, "svg"), "path");
      for (const target of [address, refresh, svgPath]) bar.doubleClick(target);
      if (platform === "win32") bar.doubleClick(bar.element("button[data-menu-id]"));
      assert.deepEqual(bar.actions(), []);
      assert.equal(bar.fire(address, "mousedown").defaultPrevented, false, "native button defaults remain usable");
      bar.fire(address, "click");
      bar.fire(svgPath, "click");
      assert.deepEqual(bar.actions(), ["open-external", "reload"]);
      assert.equal(bar.calls[0].args.url, "http://localhost:57175/");
    }
  });

  test(`${implementation}: single primary press drags once and secondary presses do nothing`, () => {
    const bar = renderer(implementation);
    const target = bar.element(".right");
    bar.fire(target, "mousedown");
    bar.fire(target, "mouseup");
    assert.deepEqual(bar.actions(), ["drag"]);
    for (const button of [1, 2]) bar.doubleClick(target, { button });
    assert.deepEqual(bar.actions(), ["drag"]);
  });

  test(`${implementation}: titlebar never mounts inside a child frame`, () => {
    const bar = renderer(implementation, "darwin", true);
    assert.equal(bar.host, null);
    assert.deepEqual(bar.calls, []);
  });
}
