const test = require("node:test");
const assert = require("node:assert/strict");
const { renderer } = require("./helpers/desktop-renderer.cjs");

for (const implementation of ["typescript", "rust-init-script"]) {
  for (const platform of ["win32", "windows", "linux"]) {
    test(`${implementation} ${platform}: frameless window buttons remain visible and dispatch only their own action`, () => {
      const bar = renderer(implementation, platform);
      const actions = ["minimize", "toggle-maximize", "close"];
      assert.equal(bar.elements("button[data-window-action]").length, actions.length);
      for (const action of actions) {
        const button = bar.element(`button[data-window-action="${action}"]`);
        assert.ok(button, `${action} must be present in the frameless titlebar`);
        assert.equal(button.type, "button");
        assert.ok(button.getAttribute("aria-label"), `${action} needs an accessible label`);
        assert.match(button.innerHTML, /<svg[\s>]/, `${action} needs a visible icon`);
        const iconPath = bar.child(bar.child(button, "svg"), "path");
        bar.doubleClick(iconPath);
        assert.deepEqual(bar.actions(), [], `${action} must never start dragging or maximize on mousedown`);
        assert.equal(bar.fire(button, "mousedown").defaultPrevented, false);
        bar.fire(iconPath, "click");
        assert.deepEqual(bar.actions(), [action], `${action} must dispatch exactly once from an icon click`);
        bar.calls.length = 0;
      }
    });
  }

  for (const platform of ["darwin", "macos"]) {
    test(`${implementation} ${platform}: native macOS window buttons are not duplicated`, () => {
      const bar = renderer(implementation, platform);
      assert.equal(bar.elements("button[data-window-action]").length, 0);
    });
  }

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
        for (const role of ["from-user", "from-agent"]) {
          const message = bar.child(bar.document.body, "article");
          message.className = `persona-message ${role}`;
          const sender = bar.child(message, "small");
          const body = bar.child(message, "div");
          body.className = "persona-message-body";
          const content = bar.child(body, "div");
          content.className = "persona-body-content";
          const inlineText = bar.child(content, "strong");
          const receipt = bar.child(body, "details");
          const summary = bar.child(receipt, "summary");
          const execution = bar.child(receipt, "div");
          execution.className = "persona-execution";
          for (const target of [message, sender, body, content, inlineText, summary, execution]) {
            assert.equal(bar.fire(target, "contextmenu").defaultPrevented, false,
              `${role} message text keeps its native copy menu (${target.className || target.tagName})`);
          }
        }
        const navigation = bar.child(bar.document.body, "nav");
        const button = bar.child(navigation, "button");
        assert.equal(bar.fire(button, "contextmenu").defaultPrevented, true, "navigation remains app chrome");
        assert.equal(bar.fire(bar.host, "contextmenu").defaultPrevented, true, "titlebar remains app chrome");
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

  const themeCalls = bar => bar.calls.filter(call => call.command === "desktop_sync_theme");
  const legacyPalette = (element, document) => ({
    colorScheme: "normal",
    properties: { "--bg-sidebar": document.body.classList.contains("light") ? "#f2f3f7" : "#2b2b2b" },
  });

  test(`${implementation}: legacy AIChat without body.light uses dark chrome even without color-scheme metadata`, () => {
    const bar = renderer(implementation, "windows", false, false, { computedStyle: legacyPalette });
    const theme = bar.initialCalls.find(call => call.command === "desktop_sync_theme");
    assert.equal(theme.args.dark, true);
    assert.equal(bar.host.style.getPropertyValue("--chrome-bg"), "#18181f");
    assert.equal(bar.host.style.getPropertyValue("--chrome-text"), "#d4d4dc");
    assert.equal(bar.host.style.getPropertyValue("--chrome-menu-bg"), "#202028");
  });

  test(`${implementation}: document-only theme events follow AIChat light-class removal and restoration`, () => {
    const bar = renderer(implementation, "darwin", false, false, {
      bodyClass: "light", computedStyle: legacyPalette,
    });
    assert.equal(bar.initialCalls.find(call => call.command === "desktop_sync_theme").args.dark, false);
    assert.equal(bar.host.style.getPropertyValue("--chrome-bg"), "#f2f3f7");
    bar.document.body.classList.remove("light");
    bar.fire(bar.document, "aichat:theme-changed", { bubbles: false, detail: { theme: "dark" } });
    assert.deepEqual(themeCalls(bar).map(call => call.args.dark), [true]);
    assert.equal(bar.host.style.getPropertyValue("--chrome-bg"), "#18181f");
    bar.document.body.classList.add("light");
    bar.fire(bar.document, "aichat:theme-changed", { bubbles: false, detail: { theme: "light" } });
    assert.deepEqual(themeCalls(bar).map(call => call.args.dark), [true, false]);
    assert.equal(bar.host.style.getPropertyValue("--chrome-text"), "#1a1a2e");
  });

  test(`${implementation}: explicit class and data-theme remain authoritative over native or CSS preference`, () => {
    for (const [className, scheme, dark] of [["dark", "light", true], ["light", "dark", false]]) {
      const bar = renderer(implementation, "linux", false, false, {
        bodyClass: className, computedStyle: { colorScheme: scheme }, systemDark: !dark,
      });
      assert.equal(bar.initialCalls.find(call => call.command === "desktop_sync_theme").args.dark, dark);
    }
    const bar = renderer(implementation, "linux");
    bar.document.documentElement.setAttribute("data-theme", "dark");
    bar.mutation(bar.document.documentElement, "data-theme");
    assert.deepEqual(themeCalls(bar).map(call => call.args.dark), [true]);
    bar.document.documentElement.setAttribute("data-theme", "light");
    bar.mutation(bar.document.documentElement, "data-theme");
    assert.deepEqual(themeCalls(bar).map(call => call.args.dark), [true, false]);
  });

  test(`${implementation}: asynchronous stylesheet loading refreshes dark chrome before a page event`, () => {
    const palette = { colorScheme: "normal", properties: {} };
    const bar = renderer(implementation, "windows", false, false, { computedStyle: palette });
    assert.equal(bar.initialCalls.find(call => call.command === "desktop_sync_theme").args.dark, false);
    palette.properties["--bg-sidebar"] = "#2b2b2b";
    const sheet = bar.child(bar.document.head, "link");
    sheet.setAttribute("rel", "stylesheet");
    bar.fire(sheet, "load", { bubbles: false });
    assert.deepEqual(themeCalls(bar).map(call => call.args.dark), [true]);
    assert.equal(bar.host.style.getPropertyValue("--chrome-bg"), "#18181f");
  });

  test(`${implementation}: absent CSS theme defaults to unconfirmed light without following OS changes`, () => {
    const bar = renderer(implementation, "darwin", false, false, {
      computedStyle: { colorScheme: "normal" }, systemDark: true,
    });
    const initial = bar.initialCalls.find(call => call.command === "desktop_sync_theme");
    assert.equal(initial.args.dark, false);
    assert.equal(initial.args.confirmed, false, "a provisional theme cannot overwrite the native preference");
    assert.equal(bar.host.style.getPropertyValue("--chrome-bg"), "#f2f3f7");
    bar.setSystemDark(false);
    bar.setSystemDark(true);
    assert.deepEqual(themeCalls(bar), []);
    bar.document.body.classList.add("dark");
    bar.fire(bar.document, "aichat:theme-changed", { bubbles: false });
    assert.deepEqual(themeCalls(bar).map(call => [call.args.dark, call.args.confirmed]), [[true, true]]);
  });

  test(`${implementation}: startup chrome waits for the native theme snapshot without reporting an OS guess`, () => {
    for (const mode of [{ shell: true }, { startupMarker: true }]) {
      const bar = renderer(implementation, "darwin", false, false, {
        ...mode, systemDark: true, computedStyle: { colorScheme: "dark" },
      });
      assert.equal(bar.host.style.visibility, "hidden");
      assert.equal(bar.initialCalls.some(call => call.command === "desktop_sync_theme"), false);
      bar.fire(bar.window, "load");
      bar.fire(bar.document, "aichat:theme-changed", { bubbles: false });
      bar.setSystemDark(false);
      assert.deepEqual(themeCalls(bar), []);
      assert.equal(bar.document.documentElement.dataset.theme, undefined);
      bar.document.documentElement.dataset.theme = "light";
      bar.fire(bar.document, "aichat:theme-changed", { bubbles: false });
      assert.equal(bar.host.style.visibility, "visible");
      assert.equal(bar.host.style.getPropertyValue("--chrome-bg"), "#f2f3f7");
      assert.deepEqual(themeCalls(bar).map(call => [call.args.dark, call.args.confirmed]), [[false, true]]);
    }
  });

  test(`${implementation}: saved startup theme overrides the opposite system appearance and remains stable`, () => {
    for (const [theme, systemDark, background] of [["light", true, "#f2f3f7"], ["dark", false, "#18181f"]]) {
      const bar = renderer(implementation, "windows", false, false, {
        shell: true, htmlTheme: theme, systemDark,
        computedStyle: { colorScheme: systemDark ? "dark" : "light" },
      });
      assert.equal(bar.host.style.visibility, "visible");
      const initial = bar.initialCalls.find(call => call.command === "desktop_sync_theme");
      assert.equal(initial.args.dark, theme === "dark");
      assert.equal(initial.args.confirmed, true);
      assert.equal(bar.host.style.getPropertyValue("--chrome-bg"), background);
      bar.setSystemDark(!systemDark);
      bar.setSystemDark(systemDark);
      bar.fire(bar.window, "resize");
      assert.equal(bar.document.documentElement.dataset.theme, theme, "chrome never rewrites the native startup preference");
      assert.deepEqual(themeCalls(bar), []);
    }
  });

  test(`${implementation}: actual chat theme changes remain confirmed and independent of the OS`, () => {
    const bar = renderer(implementation, "windows", false, false, {
      bodyClass: "light", systemDark: true, computedStyle: legacyPalette,
    });
    assert.equal(bar.document.documentElement.dataset.theme, undefined, "startup preferences cannot be injected into a real chat document");
    assert.equal(bar.initialCalls.find(call => call.command === "desktop_sync_theme").args.confirmed, true);
    bar.document.body.classList.remove("light");
    bar.fire(bar.document, "aichat:theme-changed", { bubbles: false });
    bar.setSystemDark(false);
    assert.deepEqual(themeCalls(bar).map(call => [call.args.dark, call.args.confirmed]), [[true, true]]);
    bar.document.body.classList.add("light");
    bar.fire(bar.document, "aichat:theme-changed", { bubbles: false });
    assert.deepEqual(themeCalls(bar).map(call => [call.args.dark, call.args.confirmed]), [[true, true], [false, true]]);
  });

  test(`${implementation}: repeated theme, skin and experience signals avoid duplicate native theme updates`, () => {
    const bar = renderer(implementation, "linux", false, false, { computedStyle: legacyPalette });
    for (const type of ["aichat:theme-changed", "aichat:skin-changed", "aichat:experience-changed"]) {
      bar.fire(bar.document, type, { bubbles: false });
      bar.fire(bar.window, type);
    }
    bar.fire(bar.window, "resize");
    assert.deepEqual(themeCalls(bar), []);
  });
}

for (const implementation of ["typescript", "rust-init-script"]) {
  test(`${implementation}: titlebar follows AIChat language changes`, () => {
    const bar = renderer(implementation, "windows");
    bar.document.documentElement.lang = "en";
    bar.fire(bar.document, "aichat:language-changed");
    assert.equal(bar.element(".title").textContent, "KeepWork Second Brain");
    assert.deepEqual(bar.elements("button[data-menu-id]").map(button => button.textContent), ["File", "Edit", "View", "Help"]);
    assert.equal(bar.element(".refresh").getAttribute("aria-label"), "Reload page");
    bar.document.documentElement.lang = "zh-CN";
    bar.fire(bar.document, "aichat:language-changed");
    assert.equal(bar.element(".title").textContent, "KeepWork 第二大脑");
    assert.equal(bar.element('button[data-menu-id="file"]').textContent, "文件");
  });
  test(`${implementation}: macOS title follows language changes`, () => {
    const bar = renderer(implementation, "darwin");
    bar.document.documentElement.lang = "en";
    bar.fire(bar.document, "aichat:language-changed");
    assert.equal(bar.element(".title").textContent, "KeepWork Second Brain");
  });
}

for (const implementation of ["typescript", "rust-init-script"]) {
  test(`${implementation}: macOS serializes native menu language changes`, async () => {
    const resolvers = [];
    const bar = renderer(implementation, "darwin", false, false, {
      invoke(command) {
        if (command === "desktop_set_menu_language") return new Promise(resolve => resolvers.push(resolve));
        return Promise.resolve(true);
      },
    });
    assert.deepEqual(bar.initialCalls.filter(c => c.command === "desktop_set_menu_language").map(c => c.args.language), ["zh-CN"]);
    bar.document.documentElement.lang = "en";
    bar.mutation(bar.document.documentElement, "lang");
    assert.equal(bar.calls.filter(c => c.command === "desktop_set_menu_language").length, 0);
    resolvers.shift()(true);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(bar.calls.filter(c => c.command === "desktop_set_menu_language").map(c => c.args.language), ["en"]);
    bar.document.documentElement.lang = "zh-CN";
    bar.fire(bar.document, "aichat:language-changed");
    resolvers.shift()(true);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(bar.calls.filter(c => c.command === "desktop_set_menu_language").map(c => c.args.language), ["en", "zh-CN"]);
    resolvers.shift()(true);
    await new Promise(resolve => setImmediate(resolve));
    bar.fire(bar.document, "aichat:language-changed");
    assert.equal(bar.calls.filter(c => c.command === "desktop_set_menu_language").length, 2);
  });
  test(`${implementation}: Windows never sends native menu language updates`, () => {
    const bar = renderer(implementation, "windows");
    bar.document.documentElement.lang = "en";
    bar.fire(bar.document, "aichat:language-changed");
    assert.equal([...bar.initialCalls, ...bar.calls].some(c => c.command === "desktop_set_menu_language"), false);
  });
}

test("macOS native menu localizes every Chinese label without changing command wiring", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const root = path.resolve(__dirname, "..");
  const source = fs.readFileSync(path.join(root, "src-tauri/src/app/host_menu.rs"), "utf8");
  const menu = source.split("pub(super) fn setup_mac_native_menu")[1].split("fn show_host_error")[0];
  const translations = fs.readFileSync(path.join(root, "src-tauri/src/menu.rs"), "utf8").split("pub fn mac_menu_text")[1].split("/// 页面命令")[0];
  const labels = [...menu.matchAll(/mac_menu_text\(language,\s*"([^"]+)"\)/g)].map(m => m[1]);
  assert.ok(labels.length >= 33);
  for (const label of labels) assert.ok(translations.includes(`"${label}" =>`), label);
  for (const [id, shortcut] of [["new-chat", "CmdOrCtrl+N"], ["file:close-window", "CmdOrCtrl+W"], ["zoom-in", "CmdOrCtrl+="], ["tray:quit", "CmdOrCtrl+Q"]]) {
    const entry = menu.slice(menu.indexOf(`"${id}"`));
    assert.ok(entry.indexOf(`"${shortcut}"`) < 250, id);
  }
  assert.match(menu, /core\.settings\(\)\.pet_visible/);
  assert.match(menu, /core\.login_startup\.is_enabled\(\)/);
});
