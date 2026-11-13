use crate::menu::{top_menu_bar_labels, HOST_COMMANDS, PAGE_COMMANDS};
use serde_json::json;

/// Generates the main-frame initialization script injected into `KeepWork 第二大脑` (`main` window).
/// - Strict guard: never executes in subframes (`window !== window.top`) or untrusted pages.
/// - Injects the 34px closed-Shadow-DOM `#keepwork-desktop-titlebar` with K icon, inline menus,
///   centered title, address pill, SVG refresh button, and CSS theme variable observer.
/// - Installs the frozen `window.aichatDesktop` v1 bridge with all capabilities and methods.
pub fn build_main_window_init_script(platform: &str, icon_data_url: &str) -> String {
    build_main_window_init_script_for_entry(platform, icon_data_url, crate::security::ENTRY)
}

pub fn build_main_window_init_script_for_entry(
    platform: &str,
    icon_data_url: &str,
    entry_url: &str,
) -> String {
    // Only origin/path is needed for early appearance. Do not expose an entry's
    // query, fragment or credentials through the public bootstrap object.
    let entry = url::Url::parse(entry_url)
        .ok()
        .filter(|url| !crate::security::has_credentials(url))
        .map(|mut url| {
            url.set_query(None);
            url.set_fragment(None);
            url.to_string()
        })
        .unwrap_or_else(|| crate::security::ENTRY.to_string());
    let bootstrap = json!({
        "platform": platform,
        "iconDataUrl": icon_data_url,
        "menus": top_menu_bar_labels(),
        "hostCommands": HOST_COMMANDS,
        "pageCommands": PAGE_COMMANDS,
        "entryUrl": entry,
    });

    let menu_chrome =
        include_str!("../../src/menuChrome.js").replacen("export function", "function", 1);

    let chrome_theme =
        include_str!("../../src/chromeTheme.js").replacen("export function", "function", 1);
    let page_theme =
        include_str!("../../src/pageTheme.js").replacen("export function", "function", 1);
    let local_mcp_fetch =
        include_str!("../../src/localMcpFetch.js").replacen("export function", "function", 1);

    format!(
        r#"(() => {{
  if (window !== window.top) return;
  const bootstrap = {bootstrap};
  {menu_chrome}
  {chrome_theme}
  {page_theme}
  {local_mcp_fetch}
  installLocalMcpFetch(bootstrap);
  installPageTheme(bootstrap.entryUrl);
  window.__AICHAT_DESKTOP_BOOTSTRAP__ = bootstrap;

  // Native desktop chrome should not be text-selectable. Inputs, the composer
  // and ordinary/persona messages stay selectable for native copy/paste.
  const mountInputGuard = () => {{
    if (document.getElementById("keepwork-desktop-input-guard")) return;
    const guardStyle = document.createElement("style");
    guardStyle.id = "keepwork-desktop-input-guard";
    guardStyle.textContent = `
      html, body, body * {{ -webkit-user-select: none !important; user-select: none !important; }}
      body input, body textarea, body select,
      body [contenteditable]:not([contenteditable="false"]),
      body [contenteditable]:not([contenteditable="false"]) *,
      body .chat-msg-bubble, body .chat-msg-bubble *,
      body .persona-message, body .persona-message *,
      body .md-body, body .md-body *,
      body pre, body pre *, body code {{
        -webkit-user-select: text !important; user-select: text !important;
      }}
    `;
    (document.head || document.documentElement).appendChild(guardStyle);
  }};
  if (document.documentElement) mountInputGuard();
  if (document.readyState === "loading") {{
    document.addEventListener("DOMContentLoaded", mountInputGuard, {{ once: true }});
  }}

  // Suppress the native/webview context menu on app chrome; keep the edit menu
  // on text fields and message bodies where copy/paste is meaningful.
  document.addEventListener("contextmenu", (event) => {{
    const target = event.target;
    if (target && target.closest
        && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), .chat-msg-bubble, .persona-message, .md-body, pre, code')) return;
    event.preventDefault();
  }}, true);

  const invoke = (cmd, args = {{}}) => {{
    if (window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === "function") {{
      return window.__TAURI_INTERNALS__.invoke(cmd, args);
    }}
    return Promise.reject(new Error("Tauri IPC is unavailable in this context"));
  }};

  const petListeners = new Set();
  const petAudioListeners = new Set();
  const petAudioDocument = globalThis.crypto?.randomUUID?.() || "";
  Object.defineProperty(window, "__AICHAT_PET_AUDIO_DOCUMENT__", {{ value: petAudioDocument }});
  const updateListeners = new Set();
  const folderListeners = new Set();
  const browserListeners = new Set();

  window.addEventListener("__aichat_desktop_event__", (e) => {{
    const detail = e.detail || {{}};
    if (detail.event === "browser-surface") {{
      for (const cb of browserListeners) {{ try {{ cb(detail.payload); }} catch {{}} }}
    }} else if (detail.event === "pet-command") {{
      for (const cb of petListeners) {{ try {{ cb(detail.payload); }} catch {{}} }}
    }} else if (detail.event === "pet-audio") {{
      for (const cb of petAudioListeners) {{ try {{ cb(detail.payload); }} catch {{}} }}
    }} else if (detail.event === "update-status") {{
      for (const cb of updateListeners) {{ try {{ cb(detail.payload); }} catch {{}} }}
    }} else if (detail.event === "folder-selected") {{
      for (const cb of folderListeners) {{ try {{ cb(detail.payload); }} catch {{}} }}
    }} else if (detail.event === "menu-message") {{
      window.postMessage({{ channel: "aichat.desktop-menu.v1", ...(detail.payload || {{}}) }}, window.location.origin);
    }}
  }});

  const allowedHostCommands = new Set(bootstrap.hostCommands || []);
  const capabilities = Object.freeze({{
    files: true,
    terminal: true,
    defaultBrainFolder: true,
    gitSetup: true,
    floatingPet: true,
    petDictationAudioVersion: 1,
    petVoiceAudioVersion: 1,
    startupSignIn: true,
    ...(bootstrap.platform === "darwin" ? {{ browserSurfaceVersion: 1, browserSurfaceViewportVersion: 1, browserSurfaceScaleVersion: 1 }} : {{}}),
  }});

  if (!window.aichatDesktop) {{
    const bridge = Object.freeze({{
      version: 1,
      capabilities,
      browserSurface: (op, args = {{}}) => invoke("desktop_browser_surface", {{ op: String(op || ""), args: args || {{}} }}),
      onBrowserSurface: (cb) => {{
        if (typeof cb !== "function") return () => {{}};
        browserListeners.add(cb);
        return () => browserListeners.delete(cb);
      }},
      reportStartupSignIn: (signedIn) => invoke("desktop_report_startup_signin", {{ signedIn: !!signedIn }}),
      publishPetState: (state) => invoke("desktop_publish_pet_state", {{ state: state || {{}}, document: petAudioDocument }}),
      petResult: (result) => invoke("desktop_pet_result", {{ result: result || {{}} }}),
      petAudio: (op, id, seq) => invoke("desktop_pet_audio", {{ op: String(op || ""), id: String(id || ""), ...(seq == null ? {{}} : {{ seq }}), document: petAudioDocument }}),
      onPetAudio: (cb) => {{
        if (typeof cb !== "function") return () => {{}};
        petAudioListeners.add(cb);
        return () => petAudioListeners.delete(cb);
      }},
      onPetCommand: (cb) => {{
        if (typeof cb !== "function") return () => {{}};
        petListeners.add(cb);
        return () => petListeners.delete(cb);
      }},
      checkGit: () => invoke("desktop_check_git"),
      installGit: () => invoke("desktop_install_git"),
      roots: () => invoke("desktop_roots"),
      pickFolder: () => invoke("desktop_pick_folder"),
      defaultBrainFolder: (prepare = false) => invoke("desktop_default_brain_folder", {{ prepare: !!prepare }}),
      revokeFolder: (rootId) => invoke("desktop_revoke_folder", {{ rootId: String(rootId || "") }}),
      file: (op, args = {{}}) => invoke("desktop_file", {{ op: String(op || ""), args: args || {{}} }}),
      terminal: (op, args = {{}}) => invoke("desktop_terminal", {{ op: String(op || ""), args: args || {{}} }}),
      status: () => invoke("desktop_status"),
      checkUpdates: () => invoke("desktop_check_updates"),
      installUpdate: () => invoke("desktop_install_update"),
      onUpdateStatus: (cb) => {{
        if (typeof cb !== "function") return () => {{}};
        updateListeners.add(cb);
        return () => updateListeners.delete(cb);
      }},
      runMenuCommand: (id) => {{
        const cmdId = String(id || "");
        if (!allowedHostCommands.has(cmdId)) {{
          return Promise.reject(new Error("Unsupported menu command: " + cmdId));
        }}
        return invoke("desktop_run_menu_command", {{ id: cmdId }});
      }},
      onFolderSelected: (cb) => {{
        if (typeof cb !== "function") return () => {{}};
        folderListeners.add(cb);
        return () => folderListeners.delete(cb);
      }},
    }});
    Object.defineProperty(window, "aichatDesktop", {{
      value: bridge,
      writable: false,
      configurable: false,
      enumerable: true,
    }});
  }}

  const mountChrome = () => {{
    if (document.getElementById("keepwork-desktop-titlebar")) return;
    const isMac = bootstrap.platform === "darwin" || bootstrap.platform === "macos";
    const host = document.createElement("div");
    host.id = "keepwork-desktop-titlebar";
    if (isMac) {{
      host.setAttribute("data-platform", "darwin");
    }}
    const shadow = host.attachShadow({{ mode: "closed" }});
    const style = document.createElement("style");
    style.textContent = `
      :host {{
        all: initial;
        position: fixed;
        inset: 0 0 auto 0;
        height: 34px;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        justify-content: space-between;
        box-sizing: border-box;
        padding: 0 145px 0 10px;
        font: 12px/1 system-ui, -apple-system, sans-serif;
        color: var(--chrome-text, #1a1a2e);
        background: var(--chrome-bg, #f2f3f7);
        user-select: none;
        -webkit-user-select: none;
        -webkit-app-region: drag;
      }}
      :host::after {{
        content: "";
        position: absolute;
        left: var(--chrome-surface-start, 0px);
        right: 0;
        bottom: 0;
        height: 5px;
        pointer-events: none;
        background: linear-gradient(to top, color-mix(in srgb, var(--chrome-text, #1a1a2e) 7%, transparent), transparent);
      }}
      :host([data-platform="darwin"]) {{ padding-left: 80px; padding-right: 0; }}
      .left, .center, .right {{ display: flex; align-items: center; min-width: 0; height: 100%; }}
      .left {{ gap: 2px; }}
      .right {{ flex: 1; height: 100%; }}
      .center {{ position: absolute; left: 50%; transform: translateX(-50%); gap: 8px; max-width: calc(100% - 360px); }}
      .icon {{ width: 18px; height: 18px; margin-left: 12px; margin-right: 2px; flex: none; pointer-events: none; display: block; line-height: 0; transform: none; object-fit: contain; }}
      button {{
        all: unset;
        box-sizing: border-box;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        height: 26px;
        padding: 0 8px;
        border-radius: 5px;
        font: inherit;
        color: inherit;
        cursor: pointer;
        -webkit-app-region: no-drag;
      }}
      button:hover, button[aria-expanded="true"] {{ background: var(--chrome-hover, #e2e6ef); }}
      .title {{ font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }}
      @media (max-width: 850px) {{ .title {{ display: none; }} }}
      .address {{ padding: 5px 10px; height: 24px; border-radius: 4px; color: var(--chrome-address, #4a4a5a); background: var(--chrome-pill, #e2e6ef); white-space: nowrap; }}
      .refresh {{ width: 28px; height: 28px; padding: 0; }}
      .refresh svg {{ width: 16px; height: 16px; stroke: currentColor; fill: none; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }}
.window-controls{{
  position:absolute;
  top:0;
  right:0;
  display:flex;
  height:34px;
  -webkit-app-region:no-drag;
}}
.window-controls button{{
  width:46px;
  height:34px;
  padding:0;
  border-radius:0;
}}
.window-controls button[data-window-action="close"]:hover{{
  color:#fff;
  background:#c42b1c;
}}
.window-controls svg{{
  width:12px;
  height:12px;
  fill:none;
  stroke:currentColor;
  stroke-width:1.2;
  pointer-events:none;
}}
    `;

    const left = document.createElement("div");
    left.className = "left";
    if (!isMac) {{
      {{
        const img = document.createElement("span");
        img.className = "icon";
        img.setAttribute("aria-hidden", "true");
        img.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M3.5 3h3v4.5L11 3h3.5L8.5 9l6 6H11L6.5 10.5V15H3.5z" fill="currentColor" opacity="0.72"/></svg>`;
        left.appendChild(img);
      }}
      mountDesktopMenus({{ host, shadow, left, invoke, menus: bootstrap.menus || [] }});
    }}

    const center = document.createElement("div");
    center.className = "center";
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = "KeepWork 第二大脑";

    const address = document.createElement("button");
    address.type = "button";
    address.className = "address";
    address.title = "在默认浏览器中打开";
    const h = window.location.host || "keepwork.com";
    const p = window.location.pathname || "/chat";
    address.textContent = h.startsWith("127.0.0.1") ? h.replace("127.0.0.1", "localhost") : (h + (p === "/" ? "" : p));
    address.addEventListener("click", () => {{
      void invoke("desktop_titlebar_action", {{ action: "open-external", url: window.location.href }});
    }});

    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "refresh";
    refresh.title = "刷新页面";
    refresh.innerHTML = '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>';
    refresh.addEventListener("click", () => {{
      void invoke("desktop_titlebar_action", {{ action: "reload" }});
    }});

    const right = document.createElement("div");
    right.className = "right";

    center.append(title, address, refresh);
    shadow.append(style, left, center, right);
  // Frameless Windows/Linux windows have no native caption buttons.
  if (!isMac) {{
    const controls = document.createElement("div");
    controls.className = "window-controls";
    for (const [action, label, path] of [
      ["minimize", "最小化", "M1 6h10"],
      ["toggle-maximize", "最大化或还原", "M1.5 1.5h9v9h-9z"],
      ["close", "关闭", "M1 1l10 10M11 1L1 11"],
    ]) {{
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("data-window-action", action);
      button.setAttribute("aria-label", label);
      button.title = label;
      button.innerHTML = `<svg viewBox="0 0 12 12" aria-hidden="true"><path d="${{path}}"/></svg>`;
      button.addEventListener("click", () => {{
        void invoke("desktop_titlebar_action", {{ action }}).catch(() => {{}});
      }});
      controls.appendChild(button);
    }}
    shadow.append(controls);
  }}


    let pendingMaximize = null;
    const isInteractive = (event) => {{
      const target = event.target;
      return !!target?.closest?.(
        "button, a, input, select, textarea, [role='button'], [role='menuitem'], [data-no-drag]"
      );
    }};
    const toggleMaximize = () => {{
      void invoke("desktop_titlebar_action", {{ action: "toggle-maximize" }}).catch(() => {{}});
    }};
    const handleDragMouseDown = (e) => {{
      if (e.button !== 0) return;
      // Keep the original target inside the closed shadow root. Bubbling would
      // retarget it to host and execute the gesture again (including on buttons).
      e.stopPropagation();
      pendingMaximize = null;
      if (isInteractive(e)) return;
      e.preventDefault();
      if (e.detail === 2) {{
        // Match Tauri's macOS gesture: commit on release so dragging the second
        // press can cancel maximization before the window changes size.
        if (isMac) {{
          pendingMaximize = {{ x: e.clientX, y: e.clientY }};
        }} else {{
          toggleMaximize();
        }}
      }} else if (e.detail === 1) {{
        void invoke("desktop_titlebar_action", {{ action: "drag" }}).catch(() => {{}});
      }}
    }};
    const handleDragMouseUp = (e) => {{
      if (e.button !== 0) return;
      e.stopPropagation();
      const pending = pendingMaximize;
      pendingMaximize = null;
      if (pending && e.detail === 2 && !isInteractive(e)
          && e.clientX === pending.x && e.clientY === pending.y) {{
        toggleMaximize();
      }}
    }};

    shadow.addEventListener("mousedown", handleDragMouseDown);
    host.addEventListener("mousedown", handleDragMouseDown);
    shadow.addEventListener("mouseup", handleDragMouseUp);
    host.addEventListener("mouseup", handleDragMouseUp);
    window.addEventListener("mousemove", (e) => {{
      if (pendingMaximize && (e.clientX !== pendingMaximize.x || e.clientY !== pendingMaximize.y)) {{
        pendingMaximize = null;
      }}
    }});
    window.addEventListener("mouseup", () => {{ pendingMaximize = null; }});
    window.addEventListener("blur", () => {{ pendingMaximize = null; }});

    const offsetStyle = document.createElement("style");
    offsetStyle.id = "keepwork-desktop-offset";
    offsetStyle.textContent = "body {{ height: calc(100vh - 34px) !important; transform: translateY(34px); }} .app-shell {{ height: calc(100vh - 34px) !important; }}";
    if (document.head && !document.getElementById("keepwork-desktop-offset")) {{
      document.head.appendChild(offsetStyle);
    }}
    if (document.documentElement) {{
      document.documentElement.appendChild(host);
    }}


    mountDesktopTheme({{ host, invoke }});
  }};

  if (document.readyState === "loading") {{
    window.addEventListener("DOMContentLoaded", mountChrome, {{ once: true }});
  }} else {{
    mountChrome();
  }}
}})();"#,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn early_appearance_receives_only_the_configured_entry_origin_and_path() {
        let script = build_main_window_init_script_for_entry(
            "darwin",
            "",
            "http://localhost:3001/AIChat.html?token=private-entry-secret#private-entry-fragment",
        );
        assert!(script.contains("\"entryUrl\":\"http://localhost:3001/AIChat.html\""));
        assert!(!script.contains("private-entry-secret"));
        assert!(!script.contains("private-entry-fragment"));
        let credentialed = build_main_window_init_script_for_entry(
            "darwin",
            "",
            "https://user:private-password@example.com/chat",
        );
        assert!(!credentialed.contains("private-password"));
        assert!(credentialed.contains("\"entryUrl\":\"https://keepwork.com/chat\""));
    }

    #[test]
    fn generates_frozen_main_frame_init_script_with_titlebar_and_v1_bridge() {
        let script = build_main_window_init_script("darwin", "data:image/png;base64,AAAA");
        assert!(script.contains("if (window !== window.top) return;"));
        assert!(script.contains("keepwork-desktop-titlebar"));
        assert!(script.contains("keepwork-desktop-input-guard"));
        assert!(script.contains("user-select: none"));
        assert!(script.contains("contextmenu"));
        assert!(script.contains("Object.freeze"));
        assert!(script.contains("reportStartupSignIn"));
        assert!(script.contains("defaultBrainFolder"));
        assert!(script.contains("checkUpdates"));
        assert!(script.contains("installUpdate"));
    }
}
