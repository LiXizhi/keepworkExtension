import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AIChatDesktopBridge,
  BrainFolderResult,
  DesktopCapabilities,
  DesktopStatus,
  GitInstallResult,
  GitStatus,
  LaunchIntent,
  RootGrant,
  UpdatesSnapshot,
} from "./types";

// 与 `apps/aichat-desktop` 的 `preload.cjs` / `menu.rs` 保持一致的无前缀 id。
const ALLOWED_HOST_COMMANDS = new Set([
  "open-folder",
  "reload",
  "check-updates",
  "toggle-login",
  "quit",
  "undo",
  "redo",
  "cut",
  "copy",
  "paste",
  "remote-voice",
  "select-all",
  "zoom-in",
  "zoom-out",
  "zoom-reset",
  "fullscreen",
  "mcp-status",
  "mcp-dashboard",
  "mcp-restart",
  "open-browser",
  "local-source",
  "published-site",
  "close-window",
  "toggle-pet",
  "open-keepwork",
]);

/** 页面命令：由 AIChat 页面自行执行，桌面进程只投递。 */
export const PAGE_COMMANDS = [
  "new-chat",
  "toggle-sidebar",
  "toggle-files",
  "open-settings",
  "experience-simple",
  "experience-professional",
  "theme-light",
  "theme-dark",
] as const;

export function installAIChatDesktopBridge(launchCapability = ""): AIChatDesktopBridge | null {
  if (window !== window.top) return null;
  if (window.aichatDesktop) return window.aichatDesktop;

  const launchDocument = globalThis.crypto?.randomUUID?.() || "";
  const launchEnabled = (() => {
    if (!launchCapability || !launchDocument || window.__AICHAT_PAGE_CONNECTION__) return false;
    try {
      const current = new URL(window.location.href);
      const entry = new URL(window.__AICHAT_DESKTOP_BOOTSTRAP__?.entryUrl || "https://keepwork.com/chat");
      return !current.username && !current.password && (
        (current.origin === entry.origin && current.pathname === entry.pathname)
        || (current.origin === "https://keepwork.com" && current.pathname === "/chat")
        || (current.protocol === "http:" && ["127.0.0.1", "localhost"].includes(current.hostname)
          && current.pathname.endsWith("/AIChat.html")));
    } catch { return false; }
  })();

  const capabilities: DesktopCapabilities = Object.freeze({
    files: true,
    terminal: true,
    defaultBrainFolder: true,
    gitSetup: true,
    floatingPet: true,
    startupSignIn: true,
    ...(launchEnabled ? { launchIntents: true as const } : {}),
    ...(["darwin", "win32"].includes(window.__AICHAT_DESKTOP_BOOTSTRAP__?.platform || "") ? { browserSurfaceVersion: 1 as const } : {}),
    ...(window.__AICHAT_DESKTOP_BOOTSTRAP__?.platform === "darwin" ? { browserSurfaceViewportVersion: 1 as const, browserSurfaceScaleVersion: 1 as const } : {}),
  });

  const petListeners = new Set<(payload: Record<string, unknown>) => void>();
  const launchListeners = new Set<() => void>();
  let launchLive = launchEnabled;
  window.addEventListener("pagehide", () => { launchLive = false; launchListeners.clear(); }, { once: true });
  const invokeLaunch = <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => launchLive
    ? invoke<T>(command, { document: launchDocument, token: launchCapability, ...args })
    : Promise.reject(new Error("Launch document is no longer active"));
  const browserListeners = new Set<(payload: Record<string, unknown>) => void>();
  void listen<Record<string, unknown>>("aichat-desktop:browser-surface", (event) => {
    for (const cb of browserListeners) { try { cb(event.payload); } catch {} }
  });
  window.addEventListener("__aichat_desktop_event__", ((event: CustomEvent) => {
    if (event.detail?.event === "launch-intent" && launchLive) {
      for (const cb of launchListeners) { try { cb(); } catch {} }
      return;
    }
    if (event.detail?.event !== "browser-surface") return;
    for (const cb of browserListeners) { try { cb(event.detail.payload); } catch {} }
  }) as EventListener);
  const updateListeners = new Set<(payload: UpdatesSnapshot) => void>();
  const folderListeners = new Set<(root: RootGrant) => void>();

  void listen<Record<string, unknown>>("aichat-desktop:pet-command", (event) => {
    for (const cb of petListeners) {
      try {
        cb(event.payload);
      } catch {
        // Ignore listener error
      }
    }
  });

  void listen<UpdatesSnapshot>("aichat-desktop:update-status", (event) => {
    for (const cb of updateListeners) {
      try {
        cb(event.payload);
      } catch {
        // Ignore listener error
      }
    }
  });

  void listen<RootGrant>("aichat-desktop:folder-selected", (event) => {
    for (const cb of folderListeners) {
      try {
        cb(event.payload);
      } catch {
        // Ignore listener error
      }
    }
  });

  void listen<Record<string, unknown>>("aichat-desktop:menu-message", (event) => {
    window.postMessage(
      {
        channel: "aichat.desktop-menu.v1",
        ...event.payload,
      },
      window.location.origin
    );
  });

  const bridge: AIChatDesktopBridge = Object.freeze({
    version: 1,
    capabilities,
    ...(launchEnabled ? {
      getLaunchIntent: (): Promise<LaunchIntent | null> => invokeLaunch("desktop_get_launch_intent"),
      acknowledgeLaunchIntent: (id: string): Promise<boolean> => invokeLaunch("desktop_acknowledge_launch_intent", { id: String(id || "") }),
      onLaunchIntent: (callback: () => void): (() => void) => {
        if (typeof callback !== "function") return () => {};
        launchListeners.add(callback);
        return () => { launchListeners.delete(callback); };
      },
    } : {}),
    browserSurface(op: string, args: Record<string, unknown> = {}): Promise<unknown> {
      return invoke("desktop_browser_surface", { op, args });
    },
    onBrowserSurface(callback: (payload: Record<string, unknown>) => void): () => void {
      browserListeners.add(callback);
      return () => { browserListeners.delete(callback); };
    },
    reportStartupSignIn(signedIn: boolean): Promise<boolean> {
      return invoke<boolean>("desktop_report_startup_signin", { signedIn: !!signedIn });
    },
    publishPetState(state: Record<string, unknown>): Promise<boolean> {
      return invoke<boolean>("desktop_publish_pet_state", { state: state || {} });
    },
    petResult(result: Record<string, unknown>): Promise<boolean> {
      return invoke<boolean>("desktop_pet_result", { result: result || {} });
    },
    onPetCommand(callback: (payload: Record<string, unknown>) => void): () => void {
      if (typeof callback !== "function") return () => {};
      petListeners.add(callback);
      return () => {
        petListeners.delete(callback);
      };
    },
    checkGit(): Promise<GitStatus> {
      return invoke<GitStatus>("desktop_check_git");
    },
    installGit(): Promise<GitInstallResult> {
      return invoke<GitInstallResult>("desktop_install_git");
    },
    roots(): Promise<RootGrant[]> {
      return invoke<RootGrant[]>("desktop_roots");
    },
    pickFolder(): Promise<RootGrant | null> {
      return invoke<RootGrant | null>("desktop_pick_folder");
    },
    defaultBrainFolder(prepare = false): Promise<BrainFolderResult> {
      return invoke<BrainFolderResult>("desktop_default_brain_folder", {
        prepare: !!prepare,
      });
    },
    revokeFolder(rootId: string): Promise<boolean> {
      return invoke<boolean>("desktop_revoke_folder", { rootId: String(rootId || "") });
    },
    file(op: string, args: Record<string, unknown> = {}): Promise<unknown> {
      return invoke<unknown>("desktop_file", {
        op: String(op || ""),
        args: args || {},
      });
    },
    terminal(op: string, args: Record<string, unknown> = {}): Promise<unknown> {
      return invoke<unknown>("desktop_terminal", {
        op: String(op || ""),
        args: args || {},
      });
    },
    status(): Promise<DesktopStatus> {
      return invoke<DesktopStatus>("desktop_status");
    },
    checkUpdates(): Promise<UpdatesSnapshot> {
      return invoke<UpdatesSnapshot>("desktop_check_updates");
    },
    installUpdate(): Promise<unknown> {
      return invoke<unknown>("desktop_install_update");
    },
    onUpdateStatus(callback: (payload: UpdatesSnapshot) => void): () => void {
      if (typeof callback !== "function") return () => {};
      updateListeners.add(callback);
      return () => {
        updateListeners.delete(callback);
      };
    },
    runMenuCommand(id: string): Promise<boolean> {
      const commandId = String(id || "");
      if (!ALLOWED_HOST_COMMANDS.has(commandId)) {
        return Promise.reject(new Error(`Unsupported menu command: ${commandId}`));
      }
      return invoke<boolean>("desktop_run_menu_command", { id: commandId });
    },
    onFolderSelected(callback: (root: RootGrant) => void): () => void {
      if (typeof callback !== "function") return () => {};
      folderListeners.add(callback);
      return () => {
        folderListeners.delete(callback);
      };
    },
  });

  Object.defineProperty(window, "aichatDesktop", {
    value: bridge,
    writable: false,
    configurable: false,
    enumerable: true,
  });

  return bridge;
}
