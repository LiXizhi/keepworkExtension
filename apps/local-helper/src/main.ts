import fs from 'node:fs';
import path from 'node:path';
import {
    app,
    Menu,
    nativeImage,
    Notification,
    shell,
    Tray,
    utilityProcess,
} from 'electron';
import { autoUpdater } from 'electron-updater';
import {
    mcpHomeDir,
    resolvePort,
    SERVER_NAME,
} from '../../../src/core/config';
import { resolveWorkspaceRoot } from '../../../src/core/paths';
import { startHelperNotifyBridge, HelperNotifyBridgeHandle } from './notifyBridge';

const AI_CHAT_URL = 'https://keepwork.com/chat';
const APP_ID = 'com.keepwork.local-helper';
const LOGIN_ARGS = ['--background'];
const POLL_MS = 4000;
const MAX_RETRY_MS = 30_000;
const TRAY_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAAyZpVFh0WE1MOmNvbS5hZG9iZS54bXAAAAAAADw/eHBhY2tldCBiZWdpbj0i77u/IiBpZD0iVzVNME1wQ2VoaUh6cmVTek5UY3prYzlkIj8+IDx4OnhtcG1ldGEgeG1sbnM6eD0iYWRvYmU6bnM6bWV0YS8iIHg6eG1wdGs9IkFkb2JlIFhNUCBDb3JlIDUuNi1jMTM4IDc5LjE1OTgyNCwgMjAxNi8wOS8xNC0wMTowOTowMSAgICAgICAgIj4gPHJkZjpSREYgeG1sbnM6cmRmPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5LzAyLzIyLXJkZi1zeW50YXgtbnMjIj4gPHJkZjpEZXNjcmlwdGlvbiByZGY6YWJvdXQ9IiIgeG1sbnM6eG1wPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvIiB4bWxuczp4bXBNTT0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL21tLyIgeG1sbnM6c3RSZWY9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9zVHlwZS9SZXNvdXJjZVJlZiMiIHhtcDpDcmVhdG9yVG9vbD0iQWRvYmUgUGhvdG9zaG9wIENDIDIwMTcgKFdpbmRvd3MpIiB4bXBNTTpJbnN0YW5jZUlEPSJ4bXAuaWlkOjNGQUNBRTk5MEY3NTExRTc4NzVFOEVDRjJFMDg2QTkwIiB4bXBNTTpEb2N1bWVudElEPSJ4bXAuZGlkOjNGQUNBRTlBMEY3NTExRTc4NzVFOEVDRjJFMDg2QTkwIj4gPHhtcE1NOkRlcml2ZWRGcm9tIHN0UmVmOmluc3RhbmNlSUQ9InhtcC5paWQ6M0ZBQ0FFOTcwRjc1MTFFNzg3NUU4RUNGMkUwODZBOTAiIHN0UmVmOmRvY3VtZW50SUQ9InhtcC5kaWQ6M0ZBQ0FFOTgwRjc1MTFFNzg3NUU4RUNGMkUwODZBOTAiLz4gPC9yZGY6RGVzY3JpcHRpb24+IDwvcmRmOlJERj4gPC94OnhtcG1ldGE+IDw/eHBhY2tldCBlbmQ9InIiPz4JASiTAAABBElEQVR42mJkaNzFQApgYiARoGsQ5mTVFeMhVoOWKPedXJtiS3liNaQYSgtwsCCLGEjwZpnIinGzwUVQpIU4WeFsblbmVieVXDNZJkbGRAMpszkn/2NqgAM7ecGF/toKApxA9sGH71M3X/uP1QY4WBOqJ8rF9vnXn9Ldt2edffIfSQq7BqDqk08/Bq+6+PTzT6Li4fKrL99//8s1k0P2Lj4Nk089ApLm0vzz/LT81UUZCWqYfe5p0a6bzz7/5GZlKTCX73JVJZw0zr/4nLTp6uprL/79/3/g/nu4OCNy4jOS5JPj53j08ce555/ggpwsTN///MMeSkB1yEohAFk1OakVIMAANBZWi7NyWjUAAAAASUVORK5CYII=';

type HelperStatus = 'starting' | 'running' | 'attached' | 'stopped' | 'conflict' | 'error';
type WorkerProcess = ReturnType<typeof utilityProcess.fork>;

interface HealthInfo {
    ok?: boolean;
    name?: string;
    pid?: number;
    port?: number;
    version?: string;
    clients?: number;
    workspaceRoot?: string;
}

interface HealthProbe {
    reachable: boolean;
    info: HealthInfo | null;
}

interface HelperSettings {
    autostartInitialized?: boolean;
}

let tray: Tray | null = null;
let worker: WorkerProcess | null = null;
let notifyBridge: HelperNotifyBridgeHandle | null = null;
let status: HelperStatus = 'starting';
let statusDetail = '正在启动本地服务';
let shuttingDown = false;
let retryAttempt = 0;
let retryTimer: NodeJS.Timeout | null = null;
let pollTimer: NodeJS.Timeout | null = null;

function helperHome(): string {
    const dir = mcpHomeDir();
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function settingsPath(): string {
    return path.join(helperHome(), 'helper-settings.json');
}

function logPath(): string {
    return path.join(helperHome(), 'helper.log');
}

function readSettings(): HelperSettings {
    try {
        return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as HelperSettings;
    } catch {
        return {};
    }
}

function writeSettings(next: HelperSettings): void {
    fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function appendLog(message: string): void {
    const target = logPath();
    try {
        const stat = fs.statSync(target);
        if (stat.size > 1024 * 1024) {
            const previous = `${target}.1`;
            try { fs.unlinkSync(previous); } catch { /* ignore */ }
            fs.renameSync(target, previous);
        }
    } catch {
        /* create below */
    }
    fs.appendFileSync(target, `${new Date().toISOString()} ${message}\n`, 'utf8');
}

function setStatus(next: HelperStatus, detail: string): void {
    if (status === next && statusDetail === detail) return;
    status = next;
    statusDetail = detail;
    appendLog(`${next}: ${detail}`);
    rebuildTrayMenu();
}

function statusLabel(): string {
    switch (status) {
        case 'running': return `本地服务运行中 - ${statusDetail}`;
        case 'attached': return `已连接现有服务 - ${statusDetail}`;
        case 'conflict': return `端口冲突 - ${statusDetail}`;
        case 'error': return `服务异常 - ${statusDetail}`;
        case 'stopped': return '本地服务已停止';
        default: return '本地服务正在启动';
    }
}

function setOpenAtLogin(enabled: boolean): void {
    app.setLoginItemSettings({
        openAtLogin: enabled,
        args: LOGIN_ARGS,
        name: APP_ID,
    });
    writeSettings({ ...readSettings(), autostartInitialized: true });
    rebuildTrayMenu();
}

function initializeOpenAtLogin(): void {
    const settings = readSettings();
    if (!settings.autostartInitialized && app.isPackaged) setOpenAtLogin(true);
}

function showMessage(title: string, body: string): void {
    if (!Notification.isSupported()) return;
    new Notification({ title, body }).show();
}

async function probeHealth(): Promise<HealthProbe> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
        const response = await fetch(`http://127.0.0.1:${resolvePort()}/health`, { signal: controller.signal });
        if (!response.ok) return { reachable: true, info: null };
        try {
            return { reachable: true, info: await response.json() as HealthInfo };
        } catch {
            return { reachable: true, info: null };
        }
    } catch {
        return { reachable: false, info: null };
    } finally {
        clearTimeout(timer);
    }
}

function clearRetry(): void {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
}

function scheduleRetry(): void {
    if (shuttingDown || retryTimer) return;
    const delay = Math.min(1000 * (2 ** retryAttempt), MAX_RETRY_MS);
    retryAttempt += 1;
    retryTimer = setTimeout(() => {
        retryTimer = null;
        void maintainService();
    }, delay);
}

function spawnWorker(): void {
    if (shuttingDown || worker) return;
    setStatus('starting', '正在启动 MCP');
    const entry = path.join(__dirname, 'worker.js');
    const child = utilityProcess.fork(entry, [], {
        serviceName: 'KP Local Helper MCP',
        env: { ...process.env },
    });
    worker = child;
    child.on('message', (message) => appendLog(`worker: ${JSON.stringify(message)}`));
    child.once('exit', (code) => {
        appendLog(`worker exited with code ${code}`);
        if (worker === child) worker = null;
        if (!shuttingDown) scheduleRetry();
    });
}

async function maintainService(): Promise<void> {
    if (shuttingDown) return;
    const probe = await probeHealth();
    const health = probe.info;
    if (health?.name === SERVER_NAME) {
        clearRetry();
        retryAttempt = 0;
        const owned = !!worker?.pid && worker.pid === health.pid;
        setStatus(owned ? 'running' : 'attached', `端口 ${health.port || resolvePort()}，${health.clients || 0} 个连接`);
        return;
    }
    if (probe.reachable) {
        const occupant = health?.name ? `服务 ${health.name}` : '其他服务';
        setStatus('conflict', `${resolvePort()} 已被${occupant}占用`);
        return;
    }
    if (!worker) spawnWorker();
}

async function checkForUpdates(manual: boolean): Promise<void> {
    const config = path.join(process.resourcesPath, 'app-update.yml');
    if (!app.isPackaged || !fs.existsSync(config)) {
        if (manual) showMessage('KP 本地助手', '当前安装包未配置更新地址');
        return;
    }
    try {
        await autoUpdater.checkForUpdatesAndNotify();
    } catch (error) {
        appendLog(`update check failed: ${error instanceof Error ? error.message : String(error)}`);
        if (manual) showMessage('KP 本地助手', '检查更新失败，请稍后重试');
    }
}

function rebuildTrayMenu(): void {
    if (!tray) return;
    const login = app.getLoginItemSettings({ args: LOGIN_ARGS });
    tray.setToolTip(`KP Local Helper - ${statusLabel()}`);
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: statusLabel(), enabled: false },
        { type: 'separator' },
        { label: '打开 AIChat', click: () => { void shell.openExternal(AI_CHAT_URL); } },
        { label: '打开本地工作目录', click: () => { void shell.openPath(resolveWorkspaceRoot()); } },
        { label: '重新检测本地服务', click: () => { void maintainService(); } },
        { type: 'separator' },
        {
            label: '登录电脑后自动启动',
            type: 'checkbox',
            checked: login.openAtLogin,
            click: (item) => setOpenAtLogin(item.checked),
        },
        { label: '检查更新', click: () => { void checkForUpdates(true); } },
        { label: '查看运行日志', click: () => shell.showItemInFolder(logPath()) },
        { type: 'separator' },
        { label: '退出 KP 本地助手', click: () => app.quit() },
    ]));
}

async function start(): Promise<void> {
    app.setAppUserModelId(APP_ID);
    initializeOpenAtLogin();

    tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON));
    rebuildTrayMenu();
    tray.on('click', () => { void shell.openExternal(AI_CHAT_URL); });

    notifyBridge = await startHelperNotifyBridge();
    appendLog(`notify bridge listening on ${notifyBridge.port}`);
    await maintainService();
    pollTimer = setInterval(() => { void maintainService(); }, POLL_MS);
    pollTimer.unref();

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-downloaded', () => {
        showMessage('KP 本地助手', '新版本已下载，将在退出后自动安装');
    });
    setTimeout(() => { void checkForUpdates(false); }, 15_000).unref();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', () => { void shell.openExternal(AI_CHAT_URL); });
    app.whenReady().then(start).catch((error) => {
        appendLog(`startup failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
        app.quit();
    });
}

app.on('before-quit', () => {
    shuttingDown = true;
    clearRetry();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    notifyBridge?.dispose();
    notifyBridge = null;
    worker?.kill();
    worker = null;
    tray?.destroy();
    tray = null;
});
