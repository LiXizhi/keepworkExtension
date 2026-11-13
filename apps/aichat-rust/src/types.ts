export interface DesktopCapabilities {
  readonly browserSurfaceVersion?: 1;
  readonly browserSurfaceViewportVersion?: 1;
  readonly browserSurfaceScaleVersion?: 1;
  readonly files: true;
  readonly terminal: true;
  readonly defaultBrainFolder: true;
  readonly gitSetup: true;
  readonly floatingPet: true;
  readonly petDictationAudioVersion?: 1;
  readonly petVoiceAudioVersion?: 1;
  readonly startupSignIn: true;
  readonly launchIntents?: true;
}

export interface LaunchIntent {
  id: string;
  kind: "first-launch" | "onboarding";
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
  engine?: string;
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
  readonly theme?: "light" | "dark";
  version: string;
  platform: string;
  arch: string;
  entryUrl: string;
  localSource: boolean;
  mcp: RuntimeStatusSnapshot;
  localModel: RuntimeStatusSnapshot;
  updates: UpdatesSnapshot;
  pageConnection?: PageConnectionSnapshot;
}

export interface PageConnectionSnapshot {
  phase: "idle" | "connecting" | "unavailable" | "ready";
  entryOrigin: string;
  localEntry: boolean;
  autoRetries: number;
  maxAutoRetries: number;
  error: string;
}

export interface AIChatDesktopBridge {
  browserSurface(op: string, args?: Record<string, unknown>): Promise<unknown>;
  onBrowserSurface(callback: (payload: Record<string, unknown>) => void): () => void;
  readonly version: 1;
  readonly capabilities: DesktopCapabilities;
  getLaunchIntent?(): Promise<LaunchIntent | null>;
  acknowledgeLaunchIntent?(id: string): Promise<boolean>;
  onLaunchIntent?(callback: () => void): () => void;
  reportStartupSignIn(signedIn: boolean): Promise<boolean>;
  publishPetState(state: Record<string, unknown>): Promise<boolean>;
  petResult(result: Record<string, unknown>): Promise<boolean>;
  petAudio?(op: "start" | "activate" | "stop" | "ack", id: string, seq?: number): Promise<Record<string, unknown>>;
  onPetAudio?(callback: (payload: Record<string, unknown>) => void): () => void;
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
    __AICHAT_PAGE_CONNECTION__?: {
      status(): Promise<DesktopStatus>;
      retry(automatic?: boolean): Promise<void>;
    };
    aichatDesktop?: AIChatDesktopBridge;
    desktopPet?: DesktopPetBridge;
    updates?: UpdatesWindowBridge;
    __AICHAT_DESKTOP_BOOTSTRAP__?: {
      platform: string;
      iconDataUrl: string;
      menus: Array<{ id: string; label: string }>;
      hostCommands: string[];
      pageCommands?: string[];
      entryUrl?: string;
    };
  }
}
