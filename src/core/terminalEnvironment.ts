import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SUPPORTED_LOGIN_SHELLS = new Set(['bash', 'fish', 'zsh']);
const MAX_ENV_OUTPUT_BYTES = 1024 * 1024;
const LOGIN_SHELL_TIMEOUT_MS = 8_000;
const ENV_OUTPUT_MARKER = '__KEEPWORK_TERMINAL_ENV_START__';

function userShell(): string {
    try { return os.userInfo().shell || ''; }
    catch { return ''; }
}

function parseEnvironment(output: Buffer): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    const text = output.toString('utf8');
    const marker = `${ENV_OUTPUT_MARKER}\n`;
    const markerIndex = text.indexOf(marker);
    if (markerIndex < 0) return env;
    for (const entry of text.slice(markerIndex + marker.length).split('\0')) {
        const separator = entry.indexOf('=');
        if (separator <= 0) continue;
        const name = entry.slice(0, separator);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
        env[name] = entry.slice(separator + 1);
    }
    return env;
}

/** Merge the user's exported login-shell environment into a GUI-launched process environment. */
export function resolveTerminalSpawnEnvironment(baseEnv: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
    if (process.platform === 'win32') return Promise.resolve({ ...baseEnv });

    const candidates = [baseEnv.SHELL, userShell()].filter((value): value is string => !!value);
    const shell = candidates.find(candidate => {
        if (!path.isAbsolute(candidate) || !existsSync(candidate)) return false;
        return SUPPORTED_LOGIN_SHELLS.has(path.basename(candidate).toLowerCase());
    });
    const envCommand = ['/usr/bin/env', '/bin/env'].find(candidate => existsSync(candidate));
    if (!shell || !envCommand) return Promise.resolve({ ...baseEnv });

    return new Promise(resolve => {
        let child: ReturnType<typeof spawn>;
        try {
            child = spawn(shell, ['-l', '-i', '-c', `printf '\\n${ENV_OUTPUT_MARKER}\\n'; ${envCommand} -0`], {
                cwd: baseEnv.HOME || os.homedir(),
                env: { ...baseEnv, HOME: baseEnv.HOME || os.homedir(), SHELL: shell },
                stdio: ['ignore', 'pipe', 'ignore'],
                windowsHide: true,
            });
        } catch {
            resolve({ ...baseEnv });
            return;
        }

        const chunks: Buffer[] = [];
        let outputBytes = 0;
        let settled = false;
        const finish = (shellEnv?: NodeJS.ProcessEnv) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(shellEnv && Object.prototype.hasOwnProperty.call(shellEnv, 'PATH')
                ? { ...baseEnv, ...shellEnv }
                : { ...baseEnv });
        };
        const timer = setTimeout(() => {
            child.kill();
            finish();
        }, LOGIN_SHELL_TIMEOUT_MS);

        child.stdout?.on('data', (chunk: Buffer | string) => {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            outputBytes += bytes.length;
            if (outputBytes > MAX_ENV_OUTPUT_BYTES) {
                child.kill();
                finish();
                return;
            }
            chunks.push(bytes);
        });
        child.on('error', () => finish());
        child.on('close', () => finish(parseEnvironment(Buffer.concat(chunks))));
    });
}
