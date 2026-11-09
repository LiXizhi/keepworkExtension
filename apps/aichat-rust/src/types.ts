export interface DesktopCapabilities {
  readonly files: true;
  readonly terminal: true;
  readonly defaultBrainFolder: true;
  readonly gitSetup: true;
  readonly floatingPet: true;
  readonly startupSignIn: true;
}

export interface RootGrant {
  id: string;
  name: string;
  path?: string;
}

export interface BrainFolderResult {
  root?: RootGrant;
  path: string;
  name: string;
  exists: boolean;
  granted: boolean;
}

export interface GitStatus {
  installed: boolean;
  version: string;
  path: string;
  platform: string;
  canInstall: boolean;
}

export interface GitInstallResult {
  started: boolean;
  installed?: boolean;
  method?: string;
  message: string;
}

export interface RuntimeStatusSnapshot {
  id: string;
  port: number;
  state: "starting" | "running" | "attached" | "conflict" | "stopped" | "error";
  owner: "desktop" | "vscode-extension" | "local-helper" | "external" | "";
  pid: number;
  version: string;
  commit: string;
  builtAt: string;
  error: string;
  updateState: "idle" | "checking" | "downloading" | "staged" | "error";
  updateProgress: number | null;
  updateError: string;
  latestVersion: string;
  latestBuiltAt: string;
  pendingVersion: string;
}

export interface UpdateComponentStatus {
  id: "mcp" | "desktop";
  title: string;
  installedVersion: string;
  runningVersion?: string;
  owner?: string;
  latestVersion: string;
  publishedAt: string;
  state: "idle" | "checking" | "downloading" | "ready" | "up-to-date" | "error";
  progress: number | null;
  canApply: boolean;
  stale: boolean;
  error: string;
  checkedAt?: string;
}

export interface UpdatesSnapshot {
  checking: boolean;
  checkedAt: string;
  mcp: UpdateComponentStatus;
  desktop: UpdateComponentStatus;
}

export interface DesktopStatus {
  version: string;
  platform: string;
  arch: string;
  entryUrl: string;
  localSource: boolean;
  mcp: RuntimeStatusSnapshot;
  localModel: RuntimeStatusSnapshot;
  updates: UpdatesSnapshot;
}

export interface AIChatDesktopBridge {
  readonly version: 1;
  readonly capabilities: DesktopCapabilities;
  reportStartupSignIn(signedIn: boolean): Promise<boolean>;
  publishPetState(state: Record<string, unknown>): Promise<boolean>;
  petResult(result: Record<string, unknown>): Promise<boolean>;
  onPetCommand(callback: (payload: Record<string, unknown>) => void): () => void;
  checkGit(): Promise<GitStatus>;
  installGit(): Promise<GitInstallResult>;
  roots(): Promise<RootGrant[]>;
  pickFolder(): Promise<RootGrant | null>;
  defaultBrainFolder(prepare?: boolean): Promise<BrainFolderResult>;
  revokeFolder(rootId: string): Promise<boolean>;
  file(op: string, args?: Record<string, unknown>): Promise<unknown>;
  terminal(op: string, args?: Record<string, unknown>): Promise<unknown>;
  status(): Promise<DesktopStatus>;
  checkUpdates(): Promise<UpdatesSnapshot>;
  installUpdate(): Promise<unknown>;
  onUpdateStatus(callback: (payload: UpdatesSnapshot) => void): () => void;
  runMenuCommand(id: string): Promise<boolean>;
  onFolderSelected(callback: (root: RootGrant) => void): () => void;
}

export interface DesktopPetBridge {
  action(name: string, args?: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  subscribe(callback: (state: Record<string, unknown>) => void): () => void;
}

export interface UpdatesWindowBridge {
  status(): Promise<UpdatesSnapshot>;
  check(): Promise<UpdatesSnapshot>;
  mcp(): Promise<UpdatesSnapshot>;
  desktop(): Promise<UpdatesSnapshot>;
  subscribe(callback: (snapshot: UpdatesSnapshot) => void): () => void;
}

declare global {
  interface Window {
    aichatDesktop?: AIChatDesktopBridge;
    desktopPet?: DesktopPetBridge;
    updates?: UpdatesWindowBridge;
    __AICHAT_DESKTOP_BOOTSTRAP__?: {
      platform: string;
      iconDataUrl: string;
      menus: Array<{ id: string; label: string }>;
      hostCommands: string[];
      pageCommands?: string[];
    };
  }
}
