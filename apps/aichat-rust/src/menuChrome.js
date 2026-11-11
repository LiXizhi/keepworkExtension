// Shared by the bundled fallback page and the Rust main-frame init script.
// Keep this module dependency-free: the Rust bridge embeds this function too.
export function mountDesktopMenus({ host, shadow, left, invoke, menus }) {
  if (!Array.isArray(menus) || menus.length === 0) return { close() {} };

  const style = document.createElement("style");
  style.textContent = `
    .menu-heading { border-radius:3px; cursor:default; }
    .menu-heading[aria-expanded="true"] { background:var(--chrome-hover,#e2e6ef); }
    .menu-popup {
      position:fixed; z-index:4; box-sizing:border-box; min-width:240px;
      max-width:calc(100vw - 16px); max-height:calc(100vh - 46px);
      overflow:auto; padding:4px; border-radius:4px;
      border:1px solid color-mix(in srgb,var(--chrome-text,#1a1a2e) 18%,transparent);
      background:var(--chrome-menu-bg,var(--chrome-bg,#f2f3f7));
      color:var(--chrome-text,#1a1a2e); box-shadow:0 5px 16px rgba(0,0,0,.18);
      font:13px/1.25 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      user-select:none; -webkit-user-select:none; -webkit-app-region:no-drag;
      cursor:default;
    }
    .menu-popup .menu-row {
      box-sizing:border-box; display:grid; grid-template-columns:12px minmax(0,1fr) auto;
      align-items:center; gap:4px; width:100%; min-height:28px; height:auto;
      padding:5px 10px 5px 2px; border-radius:2px; font:inherit; color:inherit;
      background:transparent;
      text-align:left; cursor:default; -webkit-app-region:no-drag;
    }
    .menu-popup .menu-row[data-active="true"] { background:var(--chrome-hover,#e2e6ef); }
    .menu-popup .menu-row[aria-disabled="true"] { opacity:.52; }
    .menu-popup .menu-row:focus-visible { outline:none; }
    .menu-mark { text-align:center; }
    .menu-label { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .menu-shortcut { margin-left:20px; opacity:.62; white-space:nowrap; }
    .menu-separator {
      height:1px; margin:4px 5px;
      background:color-mix(in srgb,var(--chrome-text,#1a1a2e) 14%,transparent);
    }
  `;
  shadow.append(style);
  left.setAttribute("role", "menubar");
  left.setAttribute("aria-label", "应用菜单");

  const buttons = [];
  let activeIndex = -1;
  let generation = 0;
  let popup = null;
  let rows = [];
  let rowIndex = -1;
  let savedFocus = null;
  let savedSelection = null;
  let savedRange = null;

  const rememberFocus = () => {
    savedFocus = document.activeElement;
    savedSelection = null;
    savedRange = null;
    try {
      if (savedFocus && typeof savedFocus.selectionStart === "number") {
        savedSelection = [savedFocus.selectionStart, savedFocus.selectionEnd, savedFocus.selectionDirection];
      }
      const selection = document.getSelection?.();
      if (selection?.rangeCount) savedRange = selection.getRangeAt(0).cloneRange();
    } catch { /* Some native input types do not expose a text selection. */ }
  };

  const restoreFocus = () => {
    try {
      if (savedFocus?.isConnected !== false && typeof savedFocus?.focus === "function") {
        savedFocus.focus({ preventScroll: true });
        if (savedSelection && typeof savedFocus.setSelectionRange === "function") {
          savedFocus.setSelectionRange(...savedSelection);
        }
      }
      if (savedRange) {
        const selection = document.getSelection?.();
        selection?.removeAllRanges();
        selection?.addRange(savedRange);
      }
    } catch { /* Navigation or a page rerender may have removed the old input. */ }
  };

  const removePopup = () => {
    popup?.remove();
    popup = null;
    rows = [];
    rowIndex = -1;
  };

  const close = (restore = false) => {
    generation++;
    activeIndex = -1;
    removePopup();
    for (const button of buttons) button.setAttribute("aria-expanded", "false");
    if (restore) restoreFocus();
    savedFocus = savedSelection = savedRange = null;
  };

  const selectRow = (index, focus = false) => {
    if (!rows.length) return;
    rowIndex = (index + rows.length) % rows.length;
    rows.forEach((row, i) => row.setAttribute("data-active", String(i === rowIndex)));
    if (focus) {
      rows[rowIndex].focus({ preventScroll: true });
      rows[rowIndex].scrollIntoView?.({ block: "nearest" });
    }
  };

  const activate = id => {
    // Native editing commands must see the input/selection that opened Edit.
    close(true);
    void invoke("desktop_run_menu_command", { id }).catch(() => {});
  };

  const checkedState = item => {
    if (typeof item.checked === "boolean") return item.checked;
    if (item.check !== true) return undefined;
    if (item.id === "experience-simple" || item.id === "experience-professional") {
      const experience = document.body?.dataset.experience;
      if (experience === "simple" || experience === "professional") return item.id === `experience-${experience}`;
    }
    if (item.id === "theme-light" || item.id === "theme-dark") {
      const scheme = document.body ? getComputedStyle(document.body).colorScheme : "";
      const dark = document.body?.classList.contains("dark") || document.documentElement.classList.contains("dark") || scheme === "dark";
      return item.id === (dark ? "theme-dark" : "theme-light");
    }
    // A missing page-owned panel state is unknown, not an unchecked checkbox.
    return undefined;
  };

  const showPayload = (payload, button, keyboard) => {
    const items = payload?.menu?.items || payload?.items;
    if (!Array.isArray(items)) throw new Error("Invalid desktop menu payload");
    removePopup();
    popup = document.createElement("div");
    popup.className = "menu-popup";
    popup.setAttribute("role", "menu");
    popup.setAttribute("aria-label", payload.menu?.label || button.textContent);
    popup.addEventListener("mousedown", event => {
      event.preventDefault();
      event.stopPropagation(); // Menu padding/separators are never window drag regions.
    });
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "separator") {
        const separator = document.createElement("div");
        separator.className = "menu-separator";
        separator.setAttribute("role", "separator");
        popup.append(separator);
        continue;
      }
      if (typeof item.label !== "string") continue;
      const enabled = item.enabled !== false && typeof item.id === "string";
      const row = document.createElement(enabled ? "button" : "div");
      row.className = "menu-row";
      if (enabled) {
        row.type = "button";
        row.dataset.command = item.id;
        row.tabIndex = -1;
      } else {
        row.setAttribute("aria-disabled", "true");
      }
      const checked = checkedState(item);
      row.setAttribute("role", typeof checked === "boolean" ? "menuitemcheckbox" : "menuitem");
      if (typeof checked === "boolean") row.setAttribute("aria-checked", String(checked));
      const mark = document.createElement("span");
      mark.className = "menu-mark";
      mark.textContent = checked === true ? "✓" : "";
      const label = document.createElement("span");
      label.className = "menu-label";
      label.textContent = item.label;
      const shortcut = document.createElement("span");
      shortcut.className = "menu-shortcut";
      shortcut.textContent = typeof item.shortcut === "string" ? item.shortcut : "";
      row.append(mark, label, shortcut);
      if (enabled) {
        const index = rows.length;
        row.addEventListener("mouseenter", () => selectRow(index));
        row.addEventListener("click", () => activate(item.id));
        rows.push(row);
      }
      popup.append(row);
    }
    shadow.append(popup);
    const anchor = button.getBoundingClientRect();
    popup.style.left = `${Math.max(8, anchor.left)}px`;
    popup.style.top = `${Math.max(0, anchor.bottom)}px`;
    const rect = popup.getBoundingClientRect();
    popup.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - rect.width - 8))}px`;
    popup.style.top = `${Math.max(0, Math.min(anchor.bottom, window.innerHeight - rect.height - 8))}px`;
    if (keyboard) selectRow(0, true);
  };

  const open = (index, keyboard = false, last = false) => {
    if (activeIndex < 0) rememberFocus();
    activeIndex = (index + buttons.length) % buttons.length;
    const button = buttons[activeIndex];
    const expectedIndex = activeIndex;
    const request = ++generation;
    removePopup();
    buttons.forEach((entry, i) => entry.setAttribute("aria-expanded", String(i === activeIndex)));
    const anchor = button.getBoundingClientRect();
    void invoke("desktop_open_menu", {
      menuId: menus[activeIndex].id,
      left: Math.round(anchor.left),
      bottom: Math.round(anchor.bottom),
      renderMode: "shell",
    }).then(payload => {
      if (request !== generation || activeIndex !== expectedIndex) return;
      showPayload(payload, button, keyboard);
      if (keyboard && last) selectRow(rows.length - 1, true);
    }).catch(() => {
      if (request === generation) close(keyboard);
    });
  };

  for (const [index, menu] of menus.entries()) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "menu-heading";
    button.dataset.menuId = menu.id;
    button.setAttribute("role", "menuitem");
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");
    button.textContent = menu.label;
    button.addEventListener("mousedown", event => event.preventDefault());
    button.addEventListener("click", () => activeIndex === index ? close(true) : open(index));
    button.addEventListener("mouseenter", () => {
      if (activeIndex >= 0 && activeIndex !== index) open(index);
    });
    button.addEventListener("keydown", event => {
      if (activeIndex < 0 && (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        event.stopPropagation();
        open(index, true, event.key === "ArrowUp");
      }
    });
    buttons.push(button);
    left.append(button);
  }

  document.addEventListener("keydown", event => {
    if (event.isComposing || event.ctrlKey || event.metaKey) return;
    const hotkeys = { f: "file", e: "edit", v: "view", h: "help" };
    if (event.altKey && !event.shiftKey && typeof event.key === "string") {
      const menuId = hotkeys[event.key.toLowerCase()];
      const index = menus.findIndex(menu => menu.id === menuId);
      if (index >= 0) {
        event.preventDefault();
        event.stopPropagation();
        open(index, true);
      }
      return;
    }
    if (event.key === "F10" && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      if (activeIndex >= 0) close(true);
      else open(0, true);
      return;
    }
    if (activeIndex < 0 || event.altKey) return;
    if (event.key === "Tab") { close(true); return; }
    const handled = ["Escape", "ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp", "Home", "End", "Enter", " "];
    if (!handled.includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") close(true);
    else if (event.key === "ArrowLeft") open(activeIndex - 1, true);
    else if (event.key === "ArrowRight") open(activeIndex + 1, true);
    else if (event.key === "ArrowDown") selectRow(rowIndex + 1, true);
    else if (event.key === "ArrowUp") selectRow(rowIndex < 0 ? rows.length - 1 : rowIndex - 1, true);
    else if (event.key === "Home") selectRow(0, true);
    else if (event.key === "End") selectRow(rows.length - 1, true);
    else if (rows[rowIndex]) activate(rows[rowIndex].dataset.command);
  }, true);

  document.addEventListener("pointerdown", event => {
    if (activeIndex >= 0 && !event.composedPath().includes(host)) close();
  }, true);
  shadow.addEventListener("pointerdown", event => {
    if (activeIndex < 0) return;
    const path = event.composedPath();
    if (!path.some(target => buttons.includes(target) || target === popup)) close();
  }, true);
  window.addEventListener("blur", () => close());
  window.addEventListener("resize", () => close());

  return { close: () => close() };
}
