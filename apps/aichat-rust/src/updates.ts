import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UpdateComponentStatus, UpdatesSnapshot, UpdatesWindowBridge } from "./types";

function ensureUpdatesBridge(): UpdatesWindowBridge {
  if (window.updates) return window.updates;
  const listeners = new Set<(snapshot: UpdatesSnapshot) => void>();
  void listen<UpdatesSnapshot>("aichat-desktop:update-status", (event) => {
    for (const cb of listeners) {
      try {
        cb(event.payload);
      } catch {
        // Ignore listener error
      }
    }
  });
  const api: UpdatesWindowBridge = Object.freeze({
    status(): Promise<UpdatesSnapshot> {
      return invoke<UpdatesSnapshot>("updates_window_status");
    },
    check(): Promise<UpdatesSnapshot> {
      return invoke<UpdatesSnapshot>("updates_window_check");
    },
    mcp(): Promise<UpdatesSnapshot> {
      return invoke<UpdatesSnapshot>("updates_window_apply_mcp");
    },
    desktop(): Promise<UpdatesSnapshot> {
      return invoke<UpdatesSnapshot>("updates_window_apply_desktop");
    },
    subscribe(callback: (snapshot: UpdatesSnapshot) => void): () => void {
      if (typeof callback !== "function") return () => {};
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
  });
  Object.defineProperty(window, "updates", {
    value: api,
    writable: false,
    configurable: false,
  });
  return api;
}

const api = ensureUpdatesBridge();
const checkBtn = document.getElementById("check") as HTMLButtonElement;
const componentsContainer = document.getElementById("components") as HTMLElement;

function describeComponentStatus(item: UpdateComponentStatus): string {
  const parts: string[] = [];
  if (item.state === "checking") parts.push("正在检查更新…");
  else if (item.state === "downloading") {
    const pct = typeof item.progress === "number" ? ` ${Math.round(item.progress)}%` : "";
    parts.push(`正在下载更新${pct}…`);
  } else if (item.state === "ready") {
    parts.push("已下载，可以更新");
  } else if (item.state === "up-to-date") {
    parts.push("已是最新版本");
  } else if (item.state === "error") {
    parts.push("检查或下载失败");
  } else {
    parts.push("等待检查");
  }
  if (item.stale) {
    parts.push("（显示上次检查结果）");
  }
  if (item.error) {
    parts.push(`\n${item.error}`);
  }
  return parts.join("");
}

function renderCard(
  item: UpdateComponentStatus,
  buttonLabel: string,
  dateLabel: string,
  onApply: () => void
): HTMLElement {
  const section = document.createElement("section");
  const h2 = document.createElement("h2");
  h2.textContent = item.title;
  section.appendChild(h2);

  const dl = document.createElement("dl");
  const addRow = (dtText: string, ddText: string): void => {
    const dt = document.createElement("dt");
    dt.textContent = dtText;
    const dd = document.createElement("dd");
    dd.textContent = ddText || "—";
    dl.append(dt, dd);
  };

  addRow("当前安装版本", item.installedVersion || "未知");
  if (item.id === "mcp" && item.owner && item.owner !== "desktop") {
    addRow("正在运行", `${item.runningVersion || item.installedVersion || "未知"}（${item.owner}）`);
  }
  addRow("远端最新版本", item.latestVersion || "未知");
  addRow(dateLabel, item.publishedAt || "—");
  section.appendChild(dl);

  if (item.state === "downloading") {
    const progress = document.createElement("progress");
    progress.max = 100;
    if (typeof item.progress === "number") {
      progress.value = Math.max(0, Math.min(100, item.progress));
    }
    section.appendChild(progress);
  }

  const actions = document.createElement("div");
  actions.className = "actions";
  const statusEl = document.createElement("div");
  statusEl.className = "status";
  statusEl.textContent = describeComponentStatus(item);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = buttonLabel;
  btn.disabled = !item.canApply;
  btn.addEventListener("click", onApply);

  actions.append(statusEl, btn);
  section.appendChild(actions);
  return section;
}

function render(snapshot: UpdatesSnapshot): void {
  if (!snapshot) return;
  checkBtn.disabled = !!snapshot.checking;
  componentsContainer.replaceChildren(
    renderCard(snapshot.mcp, "更新 MCP", "构建日期", () => {
      void api.mcp().then(render);
    }),
    renderCard(snapshot.desktop, "更新桌面应用", "发布日期", () => {
      void api.desktop().then(render);
    })
  );
}

checkBtn.addEventListener("click", () => {
  checkBtn.disabled = true;
  void api.check().then(render);
});

api.subscribe(render);
void api.status().then(render);
