import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AIChatDesktopBridge,
  BrainFolderResult,
  DesktopCapabilities,
  DesktopStatus,
  GitInstallResult,
  GitStatus,
  RootGrant,
  UpdatesSnapshot,
} from "./types";

const ALLOWED_HOST_COMMANDS = new Set([
  "file:open-folder",
  "file:new-window",
  "file:close-window",
  "view:reload",
  "view:force-reload",
  "view:toggle-devtools",
  "view:reset-zoom",
  "view:zoom-in",
  "view:zoom-out",
  "view:toggle-fullscreen",
  "view:toggle-source",
  "view:toggle-pet",
  "view:toggle-login-startup",
  "help:mcp-dashboard",
  "help:check-updates",
  "help:restart-mcp",
  "help:open-keepwork",
]);

export function installAIChatDesktopBridge(): AIChatDesktopBridge | null {
  if (window !== window.top) return null;
  if (window.aichatDesktop) return window.aichatDesktop;

  const capabilities: DesktopCapabilities = Object.freeze({
    files: true,
    terminal: true,
    defaultBrainFolder: true,
    gitSetup: true,
    floatingPet: true,
    startupSignIn: true,
  });

  const petListeners = new Set<(payload: Record<string, unknown>) => void>();
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
