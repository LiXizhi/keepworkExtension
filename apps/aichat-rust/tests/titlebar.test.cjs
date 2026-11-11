const test = require("node:test");
const assert = require("node:assert/strict");
const { renderer } = require("./helpers/desktop-renderer.cjs");

for (const implementation of ["typescript", "rust-init-script"]) {
  for (const platform of ["darwin", "macos", "win32", "windows", "linux"]) {
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

  test(`${implementation}: macOS commits on second release while Linux commits on second press`, () => {
    for (const platform of ["darwin", "linux"]) {
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
    for (const platform of ["darwin", "linux"]) {
      const bar = renderer(implementation, platform);
      const address = bar.element(".address");
      const refresh = bar.element(".refresh");
      const svgPath = bar.child(bar.child(refresh, "svg"), "path");
      for (const target of [address, refresh, svgPath]) bar.doubleClick(target);
      if (platform === "linux") bar.doubleClick(bar.element("button[data-menu-id]"));
      assert.deepEqual(bar.actions(), []);
      assert.equal(bar.fire(address, "mousedown").defaultPrevented, false, "native button defaults remain usable");
      bar.fire(address, "click");
      bar.fire(svgPath, "click");
      assert.deepEqual(bar.actions(), ["open-external", "reload"]);
      assert.equal(bar.calls[0].args.url, "http://localhost:57175/");
    }
  });

  test(`${implementation}: Linux uses a fixed upright vector K even without a bitmap icon`, () => {
    const bar = renderer(implementation, "linux");
    const icon = bar.element(".icon");
    assert.ok(icon, "K must remain visible when no bitmap is supplied");
    assert.equal(icon.tagName, "SPAN");
    assert.match(icon.innerHTML, /<svg[\s>]/);
    assert.match(icon.innerHTML, /<path[\s>]/);
    assert.doesNotMatch(icon.innerHTML, /<text[\s>]|<image[\s>]|transform=/);
    assert.equal(bar.element("img.icon"), undefined);
    const css = bar.elements("style").map(style => style.textContent).find(text => text.includes(".icon"));
    assert.match(css, /\.icon\s*\{[^}]*width:\s*18px/);
    assert.match(css, /\.icon\s*\{[^}]*height:\s*18px/);
  });

  for (const platform of ["win32", "windows"]) {
    test(`${implementation} ${platform}: web chrome mounts once with its offset and keeps theme synchronization`, () => {
      const bar = renderer(implementation, platform);
      assert.ok(bar.host, "Windows uses the themed 34px web titlebar");
      assert.equal(bar.elements("button[data-menu-id]").length, 4);
      assert.ok(bar.document.getElementById("keepwork-desktop-offset"), "web titlebar reserves its 34px client area");
      assert.ok(bar.initialCalls.some(call => call.command === "desktop_sync_theme"));
      bar.document.body.className = "dark";
      bar.fire(bar.window, "aichat:theme-changed");
      assert.ok(bar.calls.some(call => call.command === "desktop_sync_theme" && call.args.dark === true));
      if (implementation === "rust-init-script") {
        assert.ok(Object.isFrozen(bar.window.aichatDesktop), "native chrome cannot remove the v1 bridge");
        assert.equal(bar.fire(bar.document.body, "contextmenu").defaultPrevented, true, "chrome selection guard remains active");
        const input = bar.child(bar.document.body, "input");
        assert.equal(bar.fire(input, "contextmenu").defaultPrevented, false, "composer edit menu remains available");
      }
    });
  }

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
