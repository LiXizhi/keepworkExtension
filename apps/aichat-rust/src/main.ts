import { installAIChatDesktopBridge } from "./bridge";
import { mountDesktopTitlebar } from "./titlebar";
import type { DesktopStatus, PageConnectionSnapshot } from "./types";

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
const retryStatus = document.getElementById("retry-status");
const startup = document.getElementById("startup");
const recoveryPanel = document.getElementById("recovery");
const recovery = window.__AICHAT_PAGE_CONNECTION__;
let connection: PageConnectionSnapshot | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let pending = false;
let disposed = false;

function clearRetry(): void {
  if (retryTimer !== undefined) clearTimeout(retryTimer);
  retryTimer = undefined;
}

function applyStartupTheme(theme: DesktopStatus["theme"]): void {
  document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light";
  document.dispatchEvent(new Event("aichat:theme-changed"));
}

function showRecovery(failed: boolean): void {
  if (recoveryPanel) recoveryPanel.hidden = !failed;
  if (startup) {
    startup.dataset.state = failed ? "unavailable" : "connecting";
    startup.setAttribute("aria-busy", String(!failed));
  }
}

function render(status: DesktopStatus): void {
  connection = status.pageConnection;
  const failed = connection?.phase === "unavailable";
  // Legacy hosts have no connection snapshot; keep their manual reload usable.
  showRecovery(failed || !connection);
  if (headline) headline.textContent = failed ? "暂时无法打开 AIChat" : connection ? "正在打开工作台…" : "打开聊天工作台";
  if (summary) {
    summary.textContent = failed
      ? connection?.localEntry
        ? "无法连接本地页面服务，请检查服务后重试。"
        : "请检查网络连接。恢复连接后会自动尝试重新打开。"
      : connection ? "即将进入你的第二大脑。" : "点击下方按钮重新加载聊天窗口。";
  }
  // Display only the host-sanitized origin, never an entry query or fragment.
  if (detail) {
    const running = ["running", "attached"].includes(status.mcp.state);
    detail.textContent = `页面地址：${connection?.entryOrigin || "已配置的入口"}\n本机服务：${running ? "运行中" : "未就绪"}（${status.mcp.port}）${failed && connection?.error ? `\n${connection.error}` : ""}`;
  }
  if (reloadBtn) reloadBtn.textContent = failed ? "立即重试" : connection ? "正在连接…" : "重新加载聊天窗口";
  if (failed && connection && recovery) {
    if (connection.autoRetries < connection.maxAutoRetries) {
      const delay = [5, 15, 30][connection.autoRetries] || 30;
      if (retryStatus) retryStatus.textContent = `${delay} 秒后自动重试（${connection.autoRetries + 1}/${connection.maxAutoRetries}），也可立即重试。`;
      retryTimer = setTimeout(() => { void retry(true); }, delay * 1000);
    } else if (retryStatus) {
      retryStatus.textContent = "自动重试已暂停。连接恢复后，请点击“立即重试”。";
    }
  }
}

async function retry(automatic = false): Promise<void> {
  if (!recovery || pending || disposed) return;
  if (automatic && (connection?.phase !== "unavailable" || connection.autoRetries >= connection.maxAutoRetries)) return;
  clearRetry();
  pending = true;
  showRecovery(false);
  if (reloadBtn) (reloadBtn as HTMLButtonElement).disabled = true;
  if (headline) headline.textContent = "正在打开 AIChat…";
  if (summary) summary.textContent = "请稍候，正在连接工作台。";
  if (retryStatus) retryStatus.textContent = "正在连接页面，最多等待 20 秒…";
  try {
    await recovery.retry(automatic);
    // Keep the button locked until navigation replaces this document. Native
    // recovery owns the timeout; online events cannot start a parallel attempt.
  } catch {
    pending = false;
    showRecovery(true);
    if (reloadBtn) (reloadBtn as HTMLButtonElement).disabled = false;
    if (headline) headline.textContent = "暂时无法打开 AIChat";
    if (retryStatus) retryStatus.textContent = "无法重试，请通过应用菜单重新加载。";
  }
}

if (reloadBtn) {
  reloadBtn.addEventListener("click", () => {
    if (recovery) void retry();
    else if (bridge) void bridge.runMenuCommand("reload");
  });
}

if (updatesBtn && bridge) {
  updatesBtn.addEventListener("click", () => {
    void bridge.runMenuCommand("check-updates");
  });
}

if (recovery || bridge) {
  void (recovery ? recovery.status() : bridge!.status())
    .then((status) => {
      if (disposed) return;
      applyStartupTheme(status.theme);
      render(status);
      if (connection?.phase === "idle") {
        retryTimer = setTimeout(() => { void retry(); }, 0);
      }
    })
    .catch(() => {
      if (disposed) return;
      applyStartupTheme(undefined);
      showRecovery(true);
      if (headline) headline.textContent = "暂时无法打开 AIChat";
      if (summary) summary.textContent = "请通过应用菜单重新加载聊天窗口。";
    });
} else {
  applyStartupTheme(undefined);
}

// This module runs only in the local connection page. A loaded chat has no
// connectivity-triggered navigation, keeping drafts, terminals and tasks intact.
window.addEventListener("online", () => { void retry(true); });
window.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r") {
    event.preventDefault();
    if (recovery) void retry();
    else if (bridge) void bridge.runMenuCommand("reload");
  }
});
window.addEventListener("pagehide", () => {
  disposed = true;
  clearRetry();
}, { once: true });
