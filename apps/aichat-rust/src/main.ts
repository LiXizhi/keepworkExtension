import { installAIChatDesktopBridge } from "./bridge";
import { mountDesktopTitlebar } from "./titlebar";

const DEFAULT_MENUS = [
  { id: "file", label: "文件" },
  { id: "edit", label: "编辑" },
  { id: "view", label: "视图" },
  { id: "help", label: "帮助" },
];

const bridge = installAIChatDesktopBridge();
const bootstrap = window.__AICHAT_DESKTOP_BOOTSTRAP__;
mountDesktopTitlebar({
  platform: bootstrap?.platform || (navigator.platform.toLowerCase().includes("mac") ? "darwin" : "win32"),
  iconDataUrl: bootstrap?.iconDataUrl || "",
  menus: bootstrap?.menus || DEFAULT_MENUS,
});

const reloadBtn = document.getElementById("reload");
const updatesBtn = document.getElementById("updates");
const headline = document.getElementById("headline");
const summary = document.getElementById("summary");
const detail = document.getElementById("detail");

if (reloadBtn && bridge) {
  reloadBtn.addEventListener("click", () => {
    void bridge.runMenuCommand("view:reload");
  });
}

if (updatesBtn && bridge) {
  updatesBtn.addEventListener("click", () => {
    void bridge.runMenuCommand("help:check-updates");
  });
}

if (bridge) {
  void bridge
    .status()
    .then((status) => {
      if (headline) headline.textContent = "无法打开 AIChat";
      if (summary) summary.textContent = "请检查网络连接，或重新加载聊天窗口。";
      if (detail) {
        detail.textContent = `入口：${status.entryUrl} · MCP (${status.mcp.port})：${status.mcp.state}`;
      }
    })
    .catch(() => {
      if (headline) headline.textContent = "无法打开 AIChat";
      if (summary) summary.textContent = "请重新加载聊天窗口。";
    });
}
