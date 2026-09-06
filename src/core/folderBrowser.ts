import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const FOLDER_BROWSER_API = 'folders-v1';
async function directory(p: string): Promise<boolean> {
    try { return (await fs.stat(p)).isDirectory(); } catch { return false; }
}
// Fixed scripts only: browser input is never interpolated into a shell command.
async function windowsInfo(): Promise<{ folders: Record<string, string>; drives: string[] }> {
    const script = "$k=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders'; $f=@{}; foreach($p in $k.PSObject.Properties){if($p.Value -is [string]){$f[$p.Name]=[Environment]::ExpandEnvironmentVariables($p.Value)}}; @{folders=$f;drives=@([System.IO.DriveInfo]::GetDrives() | ForEach-Object {$_.Name})} | ConvertTo-Json -Compress";
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new();' + script], { windowsHide: true, timeout: 10000 });
    return JSON.parse(stdout);
}
export async function folderLocations() {
    const home = os.homedir();
    const locations = [{ id: 'home', name: 'Home', path: home }];
    let volumes: { name: string; path: string }[] = [];
    if (process.platform === 'win32') {
        const info = await windowsInfo();
        const keys = { Desktop: 'Desktop', Documents: 'Personal', Downloads: '{374DE290-123F-4565-9164-39C4925E467B}', Pictures: 'My Pictures', Music: 'My Music', Videos: 'My Video' };
        for (const [name, key] of Object.entries(keys)) {
            const p = info.folders[key];
            if (p && await directory(p)) locations.push({ id: name.toLowerCase(), name, path: p });
        }
        volumes = info.drives.map(p => ({ name: p, path: p }));
    } else if (process.platform === 'darwin') {
        const keys = { Desktop: 'desktop folder', Documents: 'documents folder', Downloads: 'downloads folder', Pictures: 'pictures folder', Music: 'music folder', Movies: 'movies folder' };
        for (const [name, key] of Object.entries(keys)) {
            try {
                const { stdout } = await exec('/usr/bin/osascript', ['-e', `POSIX path of (path to ${key} from user domain)`], { timeout: 3000 });
                const p = stdout.trim();
                if (await directory(p)) locations.push({ id: name.toLowerCase(), name, path: p });
            } catch { /* Omit locations unavailable for this account. */ }
        }
        volumes = [{ name: 'Macintosh HD', path: '/' }];
        for (const name of await fs.readdir('/Volumes').catch(() => [] as string[])) {
            const p = path.join('/Volumes', name);
            if (await directory(p)) volumes.push({ name, path: p });
        }
    } else volumes = [{ name: 'Filesystem', path: '/' }];
    return { platform: process.platform, home, locations, volumes };
}

export function absoluteFolder(raw: string): string {
    const expanded = raw === '~' ? os.homedir() : raw.startsWith('~/') || raw.startsWith('~\\') ? path.join(os.homedir(), raw.slice(2)) : raw;
    if (!path.isAbsolute(expanded)) throw new Error('An absolute directory path is required');
    return path.resolve(expanded);
}
export async function browseFolders(raw: string, options: { hidden?: boolean; filter?: string; offset?: number; limit?: number } = {}) {
    const current = absoluteFolder(raw);
    const stat = await fs.stat(current);
    if (!stat.isDirectory()) throw new Error('Not a directory');
    const parent = path.dirname(current);
    const breadcrumbs = [{ name: path.parse(current).root, path: path.parse(current).root }];
    for (const part of current.slice(path.parse(current).root.length).split(path.sep).filter(Boolean)) {
        breadcrumbs.push({ name: part, path: path.join(breadcrumbs[breadcrumbs.length - 1].path, part) });
    }
    let hiddenNames = new Set<string>();
    if (process.platform === 'win32') {
        // Pass the path as environment data, never as PowerShell source.
        const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); ConvertTo-Json -Compress -InputObject @([System.IO.DirectoryInfo]::new($env:KEEPWORK_BROWSE_PATH).EnumerateFileSystemInfos() | Where-Object {($_.Attributes -band [System.IO.FileAttributes]::Hidden) -ne 0} | ForEach-Object {$_.Name})"], { windowsHide: true, timeout: 10000, env: { ...process.env, KEEPWORK_BROWSE_PATH: current } });
        hiddenNames = new Set(JSON.parse(stdout || '[]'));
    }
    const entries: { name: string; path: string; hidden: boolean; symlink: boolean }[] = [];
    const dir = await fs.opendir(current);
    for await (const item of dir) {
        const hidden = item.name.startsWith('.') || hiddenNames.has(item.name);
        if (hidden && !options.hidden) continue;
        if (options.filter && !item.name.toLocaleLowerCase().includes(options.filter.toLocaleLowerCase())) continue;
        const p = path.join(current, item.name);
        if (!item.isDirectory() && !(item.isSymbolicLink() && await directory(p))) continue;
        entries.push({ name: item.name, path: p, hidden, symlink: item.isSymbolicLink() });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) || a.name.localeCompare(b.name));
    const offset = Number.isFinite(options.offset) ? Math.max(0, Math.floor(options.offset!)) : 0;
    const limit = Number.isFinite(options.limit) && options.limit! > 0 ? Math.min(200, Math.floor(options.limit!)) : 100;
    return { path: current, parent: parent === current ? null : parent, breadcrumbs, entries: entries.slice(offset, offset + limit), total: entries.length, nextOffset: offset + limit < entries.length ? offset + limit : null };
}
