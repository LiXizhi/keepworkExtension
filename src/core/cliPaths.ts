import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// GUI-launched daemons inherit a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin).
// CLIs installed through a Node version manager or a per-user prefix are never
// on it, so channel setup reported "CLI unavailable" even when the binary was
// on the user's shell PATH. These helpers list the usual install locations.
function isDirectory(dir: string): boolean {
    try { return fs.statSync(dir).isDirectory(); } catch { return false; }
}

function versionPrefixes(): string[] {
    const home = os.homedir();
    const roots: Array<[string, string]> = [
        [path.join(home, '.nvm', 'versions', 'node'), ''],
        [path.join(home, '.local', 'share', 'fnm', 'node-versions'), 'installation'],
        [path.join(home, '.nodenv', 'versions'), ''],
    ];
    const prefixes: string[] = [];
    for (const [root, suffix] of roots) {
        let versions: string[] = [];
        try { versions = fs.readdirSync(root); } catch { continue; }
        for (const version of versions) prefixes.push(path.join(root, version, suffix));
    }
    return prefixes;
}

/** Directories that may hold globally installed executables. */
export function cliSearchDirs(): string[] {
    const home = os.homedir();
    const dirs = [
        process.env.KEEPWORK_CLI_BIN || '',
        path.join(home, '.local', 'bin'),
        path.join(home, '.npm-global', 'bin'),
        path.join(home, '.volta', 'bin'),
        path.join(home, '.bun', 'bin'),
        path.join(home, 'Library', 'pnpm'),
        path.join(home, '.local', 'share', 'pnpm'),
        ...(process.env.APPDATA ? [path.join(process.env.APPDATA, 'npm')] : []),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        ...versionPrefixes().map(prefix => path.join(prefix, 'bin')),
    ];
    return dirs.filter(dir => dir && isDirectory(dir));
}

/** `node_modules` parents of global installs (npm prefixes and version managers). */
export function globalModuleDirs(): string[] {
    const home = os.homedir();
    const dirs = [
        ...(process.env.APPDATA ? [path.join(process.env.APPDATA, 'npm')] : []),
        path.join(home, '.npm-global', 'lib'),
        '/usr/local/lib',
        '/opt/homebrew/lib',
        ...versionPrefixes().map(prefix => path.join(prefix, 'lib')),
    ];
    return dirs.filter(dir => dir && isDirectory(dir));
}

// npm installs CLIs as `#!/usr/bin/env node` shims. A GUI-launched daemon has
// no Node on PATH, so prepend the runtime's own bin directory (and the usual
// install prefixes) for child processes.
export function cliChildEnv(): NodeJS.ProcessEnv {
    const key = process.platform === 'win32' ? 'Path' : 'PATH';
    const current = process.env[key] || process.env.PATH || '';
    const dirs = [path.dirname(process.execPath), ...cliSearchDirs(), ...String(current).split(path.delimiter)];
    return { ...process.env, [key]: [...new Set(dirs.filter(Boolean))].join(path.delimiter) };
}
