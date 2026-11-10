const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const appRoot = path.resolve(__dirname, "../..");
const titlebarSource = fs.readFileSync(path.join(appRoot, "src/titlebar.ts"), "utf8");
const titlebarJs = ts.transpileModule(titlebarSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const bridgeSource = fs.readFileSync(path.join(appRoot, "src-tauri/src/bridge.rs"), "utf8");
const rawBridge = bridgeSource.match(/r#"([\s\S]*?)"#/)[1];
const menuSource = fs.readFileSync(path.join(appRoot, "src/menuChrome.js"), "utf8").replace("export function", "function");

// Model composed event bubbling across a CLOSED shadow root: listeners inside
// see the real target; host/document/window listeners see only the host. A
// duplicate host handler must therefore fail the same way it would in a webview.
function renderer(implementation, platform = "darwin", subframe = false, menuError = false, config = {}) {
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
      this.dataset = new Proxy({}, {
        set: (target, key, value) => {
          target[key] = value;
          this.setAttribute("data-" + key.replace(/[A-Z]/g, letter => "-" + letter.toLowerCase()), value);
          return true;
        },
      });
      this.style = { setProperty() {} };
      this.className = "";
      this.classList = {
        contains: name => this.className.split(/\s+/).includes(name),
        add: name => { if (!this.classList.contains(name)) this.className += " " + name; },
        remove: name => { this.className = this.className.split(/\s+/).filter(item => item !== name).join(" "); },
        toggle: (name, active = !this.classList.contains(name)) => { this.classList[active ? "add" : "remove"](name); },
      };
      this.shadowRoot = null;
    }
    get parentElement() { return this.parentNode instanceof Element ? this.parentNode : null; }
    get isConnected() { for (let node = this; node; node = node.parentNode) if (node === document) return true; return false; }
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; return child; }
    replaceChildren(...children) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; this.append(...children); }
    remove() { this.parentNode?.removeChild(this); }
    contains(child) { return child === this || descendants(this).includes(child); }
    focus() { document.activeElement = this; }
    scrollIntoView() {}
    setSelectionRange(start, end, direction) { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; }
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
      shadow.querySelector = selector => shadow.querySelectorAll(selector)[0] || null;
      shadow.appendChild = child => { shadow.append(child); return child; };
      shadow.removeChild = child => { shadow.children.splice(shadow.children.indexOf(child), 1); child.parentNode = null; return child; };
      shadow.contains = child => descendants(shadow).includes(child);
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
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    getBoundingClientRect() { return { left: 20, right: 300, top: 0, bottom: 34, width: 280, height: 34 }; }
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
  document.activeElement = document.body;
  document.getSelection = () => null;
  document.createElement = tag => new Element(tag);
  document.getElementById = id => [document.documentElement, ...descendants(document.documentElement)]
    .find(el => el.id === id) || null;
  const window = new Target();
  document.parentNode = window;
  window.top = subframe ? {} : window;
  window.location = { host: "localhost:57175", pathname: "/", href: "http://localhost:57175/", origin: "http://localhost:57175" };
  window.innerWidth = 1280;
  window.innerHeight = 900;
  const calls = [];
  const messages = [];
  let maximized = false;
  const invoke = (command, args = {}) => {
    calls.push(JSON.parse(JSON.stringify({ command, args })));
    if (args.action === "toggle-maximize" || command.endsWith("toggle_maximize")) maximized = !maximized;
    if (command === "desktop_open_menu" && menuError) return Promise.reject(new Error("Popup unavailable"));
    if (config.invoke) return config.invoke(command, args);
    if (command === "desktop_open_menu") return Promise.resolve({ items: config.items || [
      { id: "new-chat", label: "新对话", accelerator: "CmdOrCtrl+N" },
      { type: "separator" },
      { label: "Status", enabled: false },
      { id: "open-folder", label: "打开文件夹…" },
      { id: "toggle-login", label: "自动启动", type: "checkbox", checked: true },
    ] });
    return Promise.resolve(true);
  };
  window.__TAURI_INTERNALS__ = { invoke };
  window.postMessage = message => messages.push(message);
  const context = {
    window, document, Element, HTMLElement: Element,
    exports: {}, require: () => ({ invoke, mountDesktopMenus: context.mountDesktopMenus }),
    MutationObserver: class { observe() {} },
    setTimeout, clearTimeout, requestAnimationFrame: callback => callback(),
    getComputedStyle: () => ({ colorScheme: "light", getPropertyValue: () => "" }),
  };
  const bootstrap = { platform, iconDataUrl: "", menus: config.menus || [{ id: "file", label: "文件" }, { id: "edit", label: "编辑" }, { id: "view", label: "视图" }, { id: "help", label: "帮助" }], hostCommands: [], pageCommands: [] };
  if (implementation === "typescript") {
    vm.runInNewContext(menuSource, context);
    vm.runInNewContext(titlebarJs, context);
    context.exports.mountDesktopTitlebar(bootstrap);
  } else {
    const javascript = rawBridge.replaceAll("{{", "{").replaceAll("}}", "}")
      .replace("{bootstrap}", JSON.stringify(bootstrap)).replace("{menu_chrome}", menuSource);
    vm.runInNewContext(javascript, context);
  }
  const initialCalls = [...calls];
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
    host, window, document, calls, initialCalls, messages, fire,
    element: selector => host.testShadow.querySelectorAll(selector)[0],
    elements: selector => host.testShadow.querySelectorAll(selector),
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

module.exports = { renderer };
