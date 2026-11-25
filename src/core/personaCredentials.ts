import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import * as path from 'node:path';

export interface PersonaCredentialVault {
    seal(scope: string, token: string): string;
    open(scope: string, sealed: string): string;
}

export const credentialUnavailable = 'CRM 安全凭据不可用，请解锁系统凭据库后重启服务，或重新绑定 CRM';
export const validCrmToken = (value: unknown): value is string => typeof value === 'string' && /^kwcrm_[a-f0-9]{64}$/.test(value);
const unavailable = () => Error(credentialUnavailable);
const service = 'com.keepwork.mcp.persona-crm.v1';
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');

// Secrets travel through anonymous pipes. Never propagate a helper's output or command error.
function run(program: string, args: string[], input = '') {
    const result = spawnSync(program, args, {
        input, encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 16384,
        stdio: ['pipe', 'pipe', 'ignore'],
    });
    if (result.error || result.status !== 0) throw unavailable();
    return result.stdout.trim();
}

function dpapi(operation: 'Protect' | 'Unprotect', scope: string, data: string) {
    const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = [
        "$ErrorActionPreference='Stop'",
        'Add-Type -AssemblyName System.Security',
        '$entropy=[Convert]::FromBase64String([Console]::ReadLine())',
        '$data=[Convert]::FromBase64String([Console]::ReadLine())',
        `$result=[Security.Cryptography.ProtectedData]::${operation}($data,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)`,
        '[Console]::Write([Convert]::ToBase64String($result))',
    ].join(';');
    return run(exe, ['-NoLogo', '-NonInteractive', '-NoProfile', '-Command', script],
        Buffer.from(scope).toString('base64') + '\n' + data + '\n');
}

function lookupKey(id?: string) {
    if (process.platform === 'darwin') {
        return run('/usr/bin/security', ['find-generic-password', '-s', service, ...(id ? ['-a', id] : []), '-w']);
    }
    if (process.platform === 'linux') {
        return run('/usr/bin/secret-tool', ['lookup', 'service', service, ...(id ? ['account', id] : [])]);
    }
    throw unavailable();
}

function registerKey() {
    const key = randomBytes(32);
    const id = hash(key);
    const hex = key.toString('hex');
    // Each key has an immutable account. Concurrent first starts can safely create two keys.
    if (process.platform === 'darwin') {
        run('/usr/bin/security', ['-i'], `add-generic-password -s ${service} -a ${id} -w ${hex}\n`);
    } else if (process.platform === 'linux') {
        run('/usr/bin/secret-tool', ['store', '--label=Keepwork CRM', 'service', service, 'account', id], hex);
    } else throw unavailable();
    if (lookupKey(id) !== hex) throw unavailable();
    return key;
}

export function createPersonaCredentialVault(): PersonaCredentialVault {
    let currentKey: Buffer | undefined;
    function keyFor(id?: string): Buffer {
        if (currentKey && (!id || hash(currentKey) === id)) return currentKey;
        let hex: string;
        try { hex = lookupKey(id); }
        catch {
            if (id) throw unavailable(); // A missing decryption key must never be replaced.
            return currentKey = registerKey();
        }
        if (!/^[a-f0-9]{64}$/.test(hex)) throw unavailable();
        const key = Buffer.from(hex, 'hex');
        if (id && hash(key) !== id) throw unavailable();
        return currentKey = key;
    }
    return {
        seal(scope, token) {
            if (process.platform === 'win32') return 'dpapi1:' + dpapi('Protect', scope, Buffer.from(token).toString('base64'));
            const key = keyFor();
            const iv = randomBytes(12);
            const cipher = createCipheriv('aes-256-gcm', key, iv);
            cipher.setAAD(Buffer.from(scope));
            const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
            return ['gcm1', hash(key), Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')].join(':');
        },
        open(scope, sealed) {
            try {
                if (typeof sealed !== 'string' || sealed.length > 8192) throw unavailable();
                if (process.platform === 'win32' && /^dpapi1:[A-Za-z0-9+/]+=*$/.test(sealed)) {
                    return Buffer.from(dpapi('Unprotect', scope, sealed.slice(7)), 'base64').toString('utf8');
                }
                const parts = /^gcm1:([a-f0-9]{64}):([A-Za-z0-9+/]+=*)$/.exec(sealed);
                if (!parts || process.platform === 'win32') throw unavailable();
                const data = Buffer.from(parts[2], 'base64');
                const decipher = createDecipheriv('aes-256-gcm', keyFor(parts[1]), data.subarray(0, 12));
                decipher.setAAD(Buffer.from(scope));
                decipher.setAuthTag(data.subarray(12, 28));
                return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
            } catch { throw unavailable(); }
        },
    };
}
