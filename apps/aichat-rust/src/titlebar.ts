import { invoke } from "@tauri-apps/api/core";
import { mountDesktopMenus } from "./menuChrome.js";
import { mountDesktopTheme } from "./chromeTheme.js";

const TITLEBAR_CSS = `
:host{
  all:initial;
  position:fixed;
  inset:0 0 auto 0;
  height:34px;
  z-index:2147483647;
  display:flex;
  align-items:center;
  justify-content:space-between;
  box-sizing:border-box;
  padding:0 145px 0 10px;
  font:12px/1 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  color:var(--chrome-text,#1a1a2e);
  background:var(--chrome-bg,#f2f3f7);
  user-select:none;
  -webkit-user-select:none;
  -webkit-app-region:drag;
}
:host::after{
  content:"";
  position:absolute;
  left:var(--chrome-surface-start,0px);
  right:0;
  bottom:0;
  height:5px;
  pointer-events:none;
  background:linear-gradient(to top,color-mix(in srgb,var(--chrome-text,#1a1a2e) 7%,transparent),transparent);
}
:host([data-platform="darwin"]){
  padding-left:80px;
  padding-right:0;
}
.left,.center,.right{
  display:flex;
  align-items:center;
  min-width:0;
  height:100%;
}
.left{
  gap:2px;
}
.right{
  flex:1;
  height:100%;
}
.center{
  position:absolute;
  left:50%;
  transform:translateX(-50%);
  gap:8px;
  max-width:calc(100% - 360px);
}
.icon{
  width:18px;
  height:18px;
  margin-left:12px;
  margin-right:2px;
  flex:none;
  pointer-events:none;
  display:block;
  line-height:0;
  transform:none;
  object-fit:contain;
}
button{
  all:unset;
  box-sizing:border-box;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  height:26px;
  padding:0 8px;
  border-radius:5px;
  font:inherit;
  color:inherit;
  cursor: pointer;
  -webkit-app-region:no-drag;
}
button:hover,button[aria-expanded="true"]{
  background:var(--chrome-hover,#e2e6ef);
}
button:focus-visible{
  outline:2px solid #395cda;
  outline-offset:-2px;
}
.title{
  font-weight:600;
  white-space:nowrap;
  overflow:hidden;
  text-overflow:ellipsis;
}
@media (max-width:850px){
  .title{display:none;}
}
.address{
  padding:5px 10px;
  height:24px;
  border-radius:4px;
  color:var(--chrome-address,#4a4a5a);
  background:var(--chrome-pill,#e2e6ef);
  white-space:nowrap;
}
.refresh{
  width:28px;
  height:28px;
  padding:0;
}
.refresh svg{
  width:16px;
  height:16px;
  stroke:currentColor;
  fill:none;
  stroke-width:1.8;
  stroke-linecap:round;
  stroke-linejoin:round;
}
.window-controls{
  position:absolute;
  top:0;
  right:0;
  display:flex;
  height:34px;
  -webkit-app-region:no-drag;
}
.window-controls button{
  width:46px;
  height:34px;
  padding:0;
  border-radius:0;
}
.window-controls button[data-window-action="close"]:hover{
  color:#fff;
  background:#c42b1c;
}
.window-controls svg{
  width:12px;
  height:12px;
  fill:none;
  stroke:currentColor;
  stroke-width:1.2;
  pointer-events:none;
}
`;

export function mountDesktopTitlebar(options: {
  platform: string;
  iconDataUrl: string;
  menus: Array<{ id: string; label: string }>;
}): void {
  if (window !== window.top) return;
  if (document.getElementById("keepwork-desktop-titlebar")) return;

  const isMac = options.platform === "darwin" || options.platform === "macos";
  const host = document.createElement("div");
  host.id = "keepwork-desktop-titlebar";
  if (isMac) {
    host.setAttribute("data-platform", "darwin");
  }
  const shadow = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = TITLEBAR_CSS;

  const left = document.createElement("div");
  left.className = "left";

  if (!isMac) {
    {
      const icon = document.createElement("span");
      icon.className = "icon";
      icon.setAttribute("aria-hidden", "true");
      icon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M3.5 3h3v4.5L11 3h3.5L8.5 9l6 6H11L6.5 10.5V15H3.5z" fill="currentColor" opacity="0.72"/></svg>`;
      left.appendChild(icon);
    }

  }

  const center = document.createElement("div");
  center.className = "center";

  const title = document.createElement("span");
  title.className = "title";
  title.textContent = "KeepWork 第二大脑";

  const address = document.createElement("button");
  address.type = "button";
  address.className = "address";
  address.title = "在默认浏览器中打开";
  const formatAddress = (): string => {
    const { host: h, pathname } = window.location;
    if (h === "127.0.0.1" || h.startsWith("127.0.0.1:") || h.startsWith("localhost:")) {
      return h.replace("127.0.0.1", "localhost");
    }
    return `${h}${pathname === "/" ? "" : pathname}`;
  };
  address.textContent = formatAddress();
  address.addEventListener("click", () => {
    void invoke("desktop_titlebar_action", {
      action: "open-external",
      url: window.location.href,
    });
  });

  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "refresh";
  refresh.title = "刷新页面";
  refresh.setAttribute("aria-label", "刷新页面");
  refresh.innerHTML = `<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>`;
  refresh.addEventListener("click", () => {
    void invoke("desktop_titlebar_action", { action: "reload" });
  });

  const right = document.createElement("div");
  right.className = "right";

  center.append(title, address, refresh);
  shadow.append(style, left, center, right);

  // Frameless Windows/Linux windows have no native caption buttons.
  if (!isMac) {
    const controls = document.createElement("div");
    controls.className = "window-controls";
    for (const [action, label, path] of [
      ["minimize", "最小化", "M1 6h10"],
      ["toggle-maximize", "最大化或还原", "M1.5 1.5h9v9h-9z"],
      ["close", "关闭", "M1 1l10 10M11 1L1 11"],
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("data-window-action", action);
      button.setAttribute("aria-label", label);
      button.title = label;
      button.innerHTML = `<svg viewBox="0 0 12 12" aria-hidden="true"><path d="${path}"/></svg>`;
      button.addEventListener("click", () => {
        void invoke("desktop_titlebar_action", { action }).catch(() => {});
      });
      controls.appendChild(button);
    }
    shadow.append(controls);
  }

  mountDesktopMenus({ host, shadow, left, invoke, menus: isMac ? [] : options.menus, nativeMenu: isMac });

  let pendingMaximize: { x: number; y: number } | null = null;
  const isInteractive = (event: MouseEvent): boolean => {
    const target = event.target as Element | null;
    return !!target?.closest?.(
      "button, a, input, select, textarea, [role='button'], [role='menuitem'], [data-no-drag]"
    );
  };
  const toggleMaximize = (): void => {
    void invoke("desktop_titlebar_action", { action: "toggle-maximize" }).catch(() => {});
  };
  const handleDragMouseDown = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    // Keep the original target inside the closed shadow root. Bubbling would
    // retarget it to host and execute the gesture again (including on buttons).
    e.stopPropagation();
    pendingMaximize = null;
    if (isInteractive(e)) return;
    e.preventDefault();
    if (e.detail === 2) {
      // Match Tauri's macOS gesture: commit on release so dragging the second
      // press can cancel maximization before the window changes size.
      if (isMac) {
        pendingMaximize = { x: e.clientX, y: e.clientY };
      } else {
        toggleMaximize();
      }
    } else if (e.detail === 1) {
      void invoke("desktop_titlebar_action", { action: "drag" }).catch(() => {});
    }
  };
  const handleDragMouseUp = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const pending = pendingMaximize;
    pendingMaximize = null;
    if (pending && e.detail === 2 && !isInteractive(e)
        && e.clientX === pending.x && e.clientY === pending.y) {
      toggleMaximize();
    }
  };

  shadow.addEventListener("mousedown", handleDragMouseDown as EventListener);
  host.addEventListener("mousedown", handleDragMouseDown);
  shadow.addEventListener("mouseup", handleDragMouseUp as EventListener);
  host.addEventListener("mouseup", handleDragMouseUp);
  window.addEventListener("mousemove", (e) => {
    if (pendingMaximize && (e.clientX !== pendingMaximize.x || e.clientY !== pendingMaximize.y)) {
      pendingMaximize = null;
    }
  });
  window.addEventListener("mouseup", () => { pendingMaximize = null; });
  window.addEventListener("blur", () => { pendingMaximize = null; });

  const pageOffsetStyle = document.createElement("style");
  pageOffsetStyle.id = "keepwork-desktop-offset";
  pageOffsetStyle.textContent = `
    body {
      height: calc(100vh - 34px) !important;
      transform: translateY(34px);
    }
    .app-shell {
      height: calc(100vh - 34px) !important;
    }
  `;

  const mountDom = (): void => {
    if (document.head && !document.getElementById("keepwork-desktop-offset")) {
      document.head.appendChild(pageOffsetStyle);
    }
    if (document.documentElement && !document.getElementById("keepwork-desktop-titlebar")) {
      document.documentElement.appendChild(host);
    }
  };
  mountDom();
  window.addEventListener("DOMContentLoaded", mountDom, { once: true });


  mountDesktopTheme({ host, invoke });
}
