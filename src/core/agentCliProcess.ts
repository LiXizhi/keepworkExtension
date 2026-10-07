import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AgentCliBackend, AGENT_CLI } from './agentCliBackends';
export { AgentCliBackend } from './agentCliBackends';

export type CliLaunch = { executable: string; args: string[]; path: string; source: string };
type DiscoveryOptions = { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; home?: string; pathDirs?: string[]; systemDirs?: string[]; applicationDirs?: string[] };

function file(target: string, platform: string, script = false): boolean {
    try { if (!fs.statSync(target).isFile()) return false; if (platform !== 'win32' && !script) fs.accessSync(target, fs.constants.X_OK); return true; } catch { return false; }
}
function nodeScript(target: string): boolean {
    if (/\.[cm]?js$/i.test(target)) return true;
    try {
        const fd = fs.openSync(target, 'r');
        try { const head = Buffer.alloc(256); const size = fs.readSync(fd, head, 0, head.length, 0); return /^#![^\r\n]*\bnode\b/.test(head.toString('utf8', 0, size)); }
        finally { fs.closeSync(fd); }
    } catch { return false; }
}
function entries(root: string): string[] { try { return fs.readdirSync(root).slice(0, 128); } catch { return []; } }

/** Read-only, bounded discovery; never invokes shells, installers or login scripts. */
export function resolveAgentCli(backend: AgentCliBackend, args: string[], override?: string, options: DiscoveryOptions = {}): CliLaunch {
    const platform = options.platform || process.platform, env = options.env || process.env, home = options.home || os.homedir();
    const names = AGENT_CLI[backend].commands;
    const configured = override || env[`KEEPWORK_${backend.toUpperCase()}_PATH`];
    const pathDirs = (options.pathDirs || (env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':')).map(d => d.replace(/^"|"$/g, '')).filter(d => path.isAbsolute(d));
    const tryPath = (target: string, source: string): CliLaunch | undefined => {
        const script = nodeScript(target);
        if (file(target, platform, script)) return { executable: script ? process.execPath : target, args: script ? [target, ...args] : args, path: target, source };
    };
    const cursorPackage = (dir: string, source: string): CliLaunch | undefined => {
        if (platform !== 'win32' || backend !== 'cursor' || !file(path.join(dir, 'cursor-agent.ps1'), platform)) return;
        // Resolve the official fixed layout and bundled Node without evaluating shell text.
        const versions = entries(path.join(dir, 'versions'))
            .filter(name => /^\d{4}\.\d{1,2}\.\d{1,2}(?:-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/.test(name))
            .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
        for (const root of [dir, ...versions.map(name => path.join(dir, 'versions', name))]) {
            const node = path.join(root, 'node.exe'), entry = path.join(root, 'index.js');
            if (file(node, platform) && file(entry, platform, true))
                return { executable: node, args: [entry, ...args], path: entry, source };
        }
    };
    const tryDir = (dir: string, source: string): CliLaunch | undefined => {
        for (const name of names) {
            const native = tryPath(path.join(dir, name + (platform === 'win32' ? '.exe' : '')), source);
            if (native) return native;
            if (platform === 'win32' && file(path.join(dir, name + '.cmd'), platform)) {
                try { const command = cliCommand(path.join(dir, name + '.cmd'), args, platform, env); return { ...command, path: command.executable === process.execPath ? command.args[0] : command.executable, source }; } catch { /* unsupported shim */ }
            }
        }
        return cursorPackage(dir, source);
    };
    if (configured) {
        const expanded = configured.startsWith('~/') ? path.join(home, configured.slice(2)) : configured;
        if (path.isAbsolute(expanded)) {
            if (/\.(cmd|ps1)$/i.test(expanded)) {
                if (file(expanded, platform) && /^(?:cursor-agent|agent)\.(?:cmd|ps1)$/i.test(path.basename(expanded))) {
                    const launch = cursorPackage(path.dirname(expanded), 'configured'); if (launch) return launch;
                }
                const command = cliCommand(expanded, args, platform, env);
                return { ...command, path: command.executable === process.execPath ? command.args[0] : command.executable, source: 'configured' };
            }
            const launch = tryPath(expanded, 'configured'); if (launch) return launch;
        } else {
            for (const dir of pathDirs) {
                const launch = tryPath(path.join(dir, expanded + (platform === 'win32' && !path.extname(expanded) ? '.exe' : '')), 'configured'); if (launch) return launch;
                if (platform === 'win32') try { const command = cliCommand(path.join(dir, expanded), args, platform, env); if (file(command.executable, platform)) return { ...command, path: command.executable === process.execPath ? command.args[0] : command.executable, source: 'configured' }; } catch { /* next PATH entry */ }
            }
        }
        throw new Error(`Configured ${backend} CLI not found: ${expanded}. Fix KEEPWORK_${backend.toUpperCase()}_PATH.`);
    }
    for (const dir of pathDirs) { const launch = tryDir(dir, 'PATH'); if (launch) return launch; }
    const common = platform === 'win32' ? [
        env.APPDATA && path.join(env.APPDATA, 'npm'), path.join(home, '.local', 'bin'), path.join(home, 'scoop', 'shims'),
        env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'),
        env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'codebuddy', 'bin'),
        path.join(home, '.claude', 'bin'), path.join(home, '.cursor', 'bin'), path.join(home, '.opencode', 'bin'), path.join(home, '.kimi', 'bin'), path.join(home, '.trae', 'bin'),
        env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'cursor-agent'),
        env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'cursor-agent'),
        env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'TraeCLI', 'bin'),
        env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'TraeX', 'bin'),
        env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'trae-cli', 'bin'),
        backend === 'trae' && env.TRAECLI_INSTALL_DIR,
    ] : [path.join(home, '.local', 'bin'), path.join(home, '.npm-global', 'bin'), path.join(home, '.npm', 'bin'),
        path.join(home, '.volta', 'bin'), ...['codebuddy', 'claude', 'cursor', 'opencode', 'kimi', 'trae'].map(name => path.join(home, '.' + name, 'bin')), ...(options.systemDirs || ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'])];
    if (env.npm_config_prefix) common.push(path.join(env.npm_config_prefix, platform === 'win32' ? '' : 'bin'));
    if (platform !== 'win32') {
        const versions = path.join(env.NVM_DIR || path.join(home, '.nvm'), 'versions', 'node');
        common.push(...entries(versions).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map(v => path.join(versions, v, 'bin')));
    }
    for (const dir of common.filter((d): d is string => !!d)) { const launch = tryDir(dir, 'common'); if (launch) return launch; }
    const packageName = AGENT_CLI[backend].npm;
    if (packageName)
    for (const dir of [...pathDirs, ...common.filter((d): d is string => !!d)]) {
        for (const modules of [path.join(dir, 'node_modules'), path.resolve(dir, '..', 'lib', 'node_modules')]) {
            const packageRoot = path.join(modules, packageName);
            try {
                const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
                const bins = typeof pkg.bin === 'string' ? [pkg.bin] : names.map(name => pkg.bin?.[name]);
                for (const bin of bins) if (typeof bin === 'string') {
                    const target = path.resolve(packageRoot, bin), relative = path.relative(packageRoot, target);
                    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
                    const launch = tryPath(target, 'npm'); if (launch) return launch;
                }
            } catch { /* package missing or incomplete */ }
            for (const name of names) {
                const launch = tryPath(path.join(modules, packageName, 'bin', name), 'npm'); if (launch) return launch;
            }
        }
    }
    if (platform === 'win32' && backend === 'codex' && env.LOCALAPPDATA) {
        const base = path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
        const candidates = entries(base).map(v => path.join(base, v, 'codex.exe')).filter(p => file(p, platform));
        candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
        if (candidates[0]) return tryPath(candidates[0], 'desktop')!;
    }
    const appDirs = options.applicationDirs || (platform === 'win32' ? [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA, env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')].filter((d): d is string => !!d) : ['/Applications', path.join(home, 'Applications')]);
    for (const root of appDirs) {
        if (backend === 'codex' && platform === 'darwin') for (const app of ['Codex.app', 'ChatGPT.app']) {
            const launch = tryPath(path.join(root, app, 'Contents', 'Resources', 'codex'), 'desktop'); if (launch) return launch;
        }
        if (backend === 'workbuddy' || backend === 'codebuddy') for (const app of ['WorkBuddy', 'CodeBuddy']) {
            const resources = platform === 'win32' ? path.join(root, app, 'resources') : path.join(root, app + '.app', 'Contents', 'Resources');
            const launch = tryPath(path.join(resources, 'app.asar.unpacked', 'cli', 'bin', 'codebuddy'), 'desktop'); if (launch) return launch;
        }
    }
    throw new Error(`${backend} CLI not found in PATH or common installation locations. Install its CLI or set KEEPWORK_${backend.toUpperCase()}_PATH.`);
}

/** Resolve npm launchers without invoking a shell or interpreting user text. */
export function cliCommand(executable: string, args: string[], platform = process.platform, env = process.env): { executable: string; args: string[] } {
    if (/\.(?:[cm]?js)$/i.test(executable)) return { executable: process.execPath, args: [executable, ...args] };
    if (platform !== 'win32') return { executable, args };
    const dirs = path.isAbsolute(executable) ? [path.dirname(executable)] : (env.PATH || '').split(path.delimiter).map(d => d.replace(/^"|"$/g, ''));
    const name = path.basename(executable).replace(/\.(?:cmd|ps1|exe)$/i, '');
    for (const dir of dirs) {
        const native = path.join(dir, name + '.exe');
        if (fs.existsSync(native)) return { executable: native, args };
        const shim = path.join(dir, name + '.cmd');
        if (!fs.existsSync(shim)) continue;
        // npm shims point at the package bin. Only accept a real JS file within this directory.
        const text = fs.readFileSync(shim, 'utf8');
        // Official native wrappers (for example Trae) contain only echo-off and a sibling EXE invocation.
        const nativeWrapper = text.match(/^\s*(?:@echo off\s*)?"%~dp0([^"\\/\r\n]+\.exe)"\s+%\*\s*$/i);
        if (nativeWrapper) {
            const target = path.join(dir, nativeWrapper[1]);
            if (file(target, platform)) return { executable: target, args };
        }
        for (const match of text.matchAll(/"%(?:dp0|~dp0)%?\\?([^"\r\n]+)"/gi)) {
            const script = path.resolve(dir, match[1].replace(/\\/g, path.sep));
            const relative = path.relative(dir, script);
            if (!relative.startsWith('..') && !path.isAbsolute(relative) && file(script, platform, true) && nodeScript(script)) return { executable: process.execPath, args: [script, ...args] };
        }
    }
    if (/\.(cmd|ps1)$/i.test(executable)) throw new Error('Configure the CLI native executable or JavaScript entry, not a shell launcher');
    return { executable, args };
}

export function stopCli(child: ChildProcessWithoutNullStreams) {
    if (!child.pid || child.exitCode !== null) return;
    if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
        killer.on('error', () => child.kill());
    } else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); }
    }
}
