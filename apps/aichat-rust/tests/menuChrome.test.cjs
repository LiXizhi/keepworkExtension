const test = require("node:test");
const assert = require("node:assert/strict");
const { renderer } = require("./helpers/desktop-renderer.cjs");

const settle = () => new Promise(resolve => setImmediate(resolve));
const headings = bar => bar.elements("button[data-menu-id]");
const commands = bar => bar.elements("button[data-command]");
const popup = bar => bar.element(".menu-popup");
const key = (bar, value, extra = {}) => bar.fire(bar.document.activeElement, "keydown", { key: value, ...extra });
async function open(bar, index = 0) {
  bar.fire(headings(bar)[index], "click");
  await settle();
  assert.ok(popup(bar));
}

for (const implementation of ["typescript", "rust-init-script"]) {
  test(`${implementation}: only an open menu tracks horizontal hover, and repeated click dismisses`, async () => {
    const bar = renderer(implementation, "win32");
    const buttons = headings(bar);
    bar.fire(buttons[1], "mouseenter");
    assert.deepEqual(bar.calls, [], "hover alone cannot open a menu");
    await open(bar);
    bar.fire(buttons[1], "mouseenter");
    await settle();
    assert.equal(buttons[0].getAttribute("aria-expanded"), "false");
    assert.equal(buttons[1].getAttribute("aria-expanded"), "true");
    assert.deepEqual(bar.calls.map(call => call.args.menuId), ["file", "edit"]);
    assert.ok(bar.calls.every(call => call.args.renderMode === "shell"));
    bar.fire(buttons[1], "mouseenter");
    assert.equal(bar.calls.length, 2, "hover on the current heading must not refetch");
    bar.fire(buttons[1], "click");
    assert.equal(popup(bar), undefined);
    assert.ok(buttons.every(button => button.getAttribute("aria-expanded") === "false"));
    assert.deepEqual(bar.messages, [], "the page cannot receive a second popup request");
  });

  test(`${implementation}: opening coordinates are rounded and menu presses retain composer focus`, async () => {
    const bar = renderer(implementation, "linux");
    const input = bar.child(bar.document.body, "textarea");
    input.focus();
    input.setSelectionRange(2, 7, "backward");
    const button = headings(bar)[0];
    button.getBoundingClientRect = () => ({ left: 20.4, bottom: 34.6 });
    assert.equal(bar.fire(button, "mousedown").defaultPrevented, true);
    await open(bar);
    assert.equal(bar.document.activeElement, input);
    assert.deepEqual(bar.calls[0], { command: "desktop_open_menu", args: { menuId: "file", left: 20, bottom: 35, renderMode: "shell" } });
    assert.equal(bar.fire(commands(bar)[0], "mousedown").defaultPrevented, true);
    bar.fire(commands(bar)[0], "click");
    assert.equal(bar.document.activeElement, input);
    assert.deepEqual([input.selectionStart, input.selectionEnd, input.selectionDirection], [2, 7, "backward"]);
    assert.equal(popup(bar), undefined);
    assert.deepEqual(bar.calls.filter(call => call.command === "desktop_run_menu_command"), [{ command: "desktop_run_menu_command", args: { id: "new-chat" } }]);
  });

  test(`${implementation}: keyboard navigation skips inert rows, wraps and executes only one command`, async () => {
    const bar = renderer(implementation, "win32");
    const input = bar.child(bar.document.body, "textarea");
    input.focus();
    assert.equal(key(bar, "F10").defaultPrevented, true);
    await settle();
    const rows = commands(bar);
    assert.equal(rows.length, 3, "disabled status and separator are absent from keyboard navigation");
    assert.equal(bar.document.activeElement, rows[0]);
    key(bar, "ArrowDown");
    assert.equal(bar.document.activeElement, rows[1]);
    key(bar, "End");
    assert.equal(bar.document.activeElement, rows[2]);
    key(bar, "ArrowDown");
    assert.equal(bar.document.activeElement, rows[0]);
    key(bar, "ArrowUp");
    assert.equal(bar.document.activeElement, rows[2]);
    key(bar, "Home");
    key(bar, "Enter");
    assert.equal(popup(bar), undefined);
    assert.equal(bar.document.activeElement, input);
    assert.deepEqual(bar.calls.filter(call => call.command === "desktop_run_menu_command").map(call => call.args.id), ["new-chat"]);
    key(bar, "Enter");
    assert.equal(bar.calls.filter(call => call.command === "desktop_run_menu_command").length, 1);
  });

  test(`${implementation}: Alt heading, horizontal arrows, Space and Escape follow menu focus`, async () => {
    const bar = renderer(implementation, "win32");
    const input = bar.child(bar.document.body, "input");
    input.focus();
    key(bar, "e", { altKey: true, ctrlKey: true });
    key(bar, "e", { altKey: true, isComposing: true });
    assert.deepEqual(bar.calls, [], "AltGr and IME composition must remain with the input");
    key(bar, "e", { altKey: true });
    await settle();
    assert.equal(bar.calls.at(-1).args.menuId, "edit");
    key(bar, "ArrowRight");
    await settle();
    assert.equal(bar.calls.at(-1).args.menuId, "view");
    key(bar, "ArrowLeft");
    await settle();
    assert.equal(bar.calls.at(-1).args.menuId, "edit");
    key(bar, "Escape");
    assert.equal(popup(bar), undefined);
    assert.equal(bar.document.activeElement, input);
    key(bar, "F10");
    await settle();
    key(bar, " ");
    assert.equal(bar.calls.at(-1).command, "desktop_run_menu_command");
  });

  test(`${implementation}: outside pointer, internal blank chrome, blur and resize close without stealing focus`, async () => {
    for (const reason of ["outside", "blank", "blur", "resize"]) {
      const bar = renderer(implementation, "win32");
      await open(bar);
      bar.fire(commands(bar)[0], "pointerdown");
      assert.ok(popup(bar), "a row inside the closed shadow root is not an outside click");
      const other = bar.child(bar.document.body, "input");
      other.focus();
      if (reason === "outside") bar.fire(other, "pointerdown");
      if (reason === "blank") bar.fire(bar.element(".right"), "pointerdown");
      if (reason === "blur" || reason === "resize") bar.fire(bar.window, reason);
      assert.equal(popup(bar), undefined, reason);
      assert.equal(bar.document.activeElement, other, reason);
    }
  });

  test(`${implementation}: stale payloads cannot replace newer headings or reopen a dismissed menu`, async () => {
    const pending = [];
    const bar = renderer(implementation, "win32", false, false, {
      invoke: (command, args) => command === "desktop_open_menu"
        ? new Promise((resolve, reject) => pending.push({ args, resolve, reject })) : Promise.resolve(true),
    });
    const payload = label => ({ items: [{ id: "new-chat", label }] });
    const buttons = headings(bar);
    bar.fire(buttons[0], "click");
    bar.fire(buttons[1], "mouseenter");
    pending[1].resolve(payload("Edit result"));
    await settle();
    assert.equal(bar.element(".menu-label").textContent, "Edit result");
    pending[0].resolve(payload("Stale file result"));
    await settle();
    assert.equal(bar.element(".menu-label").textContent, "Edit result");
    bar.fire(buttons[2], "mouseenter");
    bar.fire(buttons[3], "mouseenter");
    pending[2].reject(new Error("stale failure"));
    pending[3].resolve(payload("Help result"));
    await settle();
    assert.equal(bar.element(".menu-label").textContent, "Help result");
    bar.fire(buttons[0], "mouseenter");
    key(bar, "Escape");
    pending[4].resolve(payload("Late reopen"));
    await settle();
    assert.equal(popup(bar), undefined);
  });

  test(`${implementation}: labels stay plain text and authoritative checked state stays separate from unknown state`, async () => {
    const unsafeLabel = '<img src=x onerror="alert(1)">';
    const bar = renderer(implementation, "win32", false, false, { items: [
      { id: "copy", label: unsafeLabel, shortcut: "Ctrl+C" },
      { id: "quit", label: "Disabled", enabled: false },
      { id: "toggle-login", label: "Startup", type: "checkbox", checked: true },
      { id: "toggle-files", label: "Files", check: true },
      { type: "separator" },
    ] });
    await open(bar);
    const labels = bar.elements(".menu-label");
    assert.equal(labels[0].textContent, unsafeLabel);
    assert.equal(labels[0].children.length, 0);
    assert.equal(bar.element(".menu-shortcut").textContent, "Ctrl+C");
    const disabled = bar.elements(".menu-row").find(row => row.getAttribute("aria-disabled") === "true");
    bar.fire(disabled, "click");
    assert.equal(bar.calls.filter(call => call.command === "desktop_run_menu_command").length, 0);
    const startup = commands(bar).find(row => row.dataset.command === "toggle-login");
    const unknown = commands(bar).find(row => row.dataset.command === "toggle-files");
    assert.equal(startup.getAttribute("aria-checked"), "true");
    assert.equal(unknown.getAttribute("aria-checked"), null);
    assert.equal(unknown.getAttribute("role"), "menuitem");
  });
}
