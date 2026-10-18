import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { Incoming, MessageConfig, splitReply } from './messagingPolicy';

export function resolveDws(): string {
    const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter);
    const binary = process.platform === 'win32' ? 'dws.exe' : 'dws';
    const candidates = [process.env.KEEPWORK_DWS_PATH || '', path.join(os.homedir(), '.local', 'bin', binary), ...dirs.map(d => path.join(d, binary)),
        ...[process.env.APPDATA && path.join(process.env.APPDATA, 'npm'), ...dirs, path.join(os.homedir(), '.npm-global', 'lib'), '/usr/local/lib', '/opt/homebrew/lib']
            .filter((v): v is string => !!v).map(d => path.join(d, 'node_modules/dingtalk-workspace-cli/vendor', binary))];
    for (const file of candidates) if (path.isAbsolute(file) && fs.existsSync(file) && fs.statSync(file).isFile()) return file;
    throw new Error('DWS CLI unavailable; install dingtalk-workspace-cli or set KEEPWORK_DWS_PATH to its native executable');
}
export class DwsError extends Error { constructor(public uncertain: boolean, public detail?: any) { super(uncertain ? 'DWS result unknown; not retried' : 'DWS rejected the operation'); } }
export function dws(args: string[], cwd: string): Promise<any> {
    return new Promise((resolve, reject) => {
        let child: ChildProcessWithoutNullStreams;
        try { child = spawn(resolveDws(), args, { cwd, shell: false, windowsHide: true, stdio: 'pipe' }); } catch(e) { reject(e); return; }
        let output = '', settled = false;
        const finish = (error?: Error, value?: any) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
        const timer = setTimeout(() => { child.stdin.end(); finish(new DwsError(true)); }, 45000);
        child.stdout.setEncoding('utf8'); child.stdout.on('data', s => { output += s; if (output.length > 2_000_000) { child.stdin.end(); finish(new DwsError(true)); } });
        child.stderr.resume(); child.on('error', () => finish(new DwsError(false)));
        child.on('close', code => { try { const result = JSON.parse(output); if (code || result.error) finish(new DwsError(false, result.error)); else finish(undefined, result); } catch { finish(new DwsError(true)); } });
    });
}
// Explicit interactive authorization only; output may contain credentials and is discarded.
export function loginDws(root: string, profile?: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(resolveDws(), ['auth', 'login', ...(profile ? ['--profile', profile] : [])], {cwd:root,shell:false,windowsHide:true,stdio:'pipe'});
        child.stdout.resume(); child.stderr.resume();
        const timer = setTimeout(() => { child.kill(); reject(new Error('DingTalk authorization timed out; retry authorization')); }, 180000);
        child.on('error', () => { clearTimeout(timer); reject(new Error('DingTalk authorization could not start')); });
        child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('DingTalk authorization was cancelled or failed')); });
    });
}
export function listenerArgs(config: MessageConfig): string[][] {
    return [['user_im_message_receive_at', 'user_im_message_receive_o2o_all'],
        ...(config.keywords.length ? config.groups.map(group => ['user_im_message_receive_group', '--group', group]) : [])]
        .map(keys => ['event', 'consume', ...keys, '--flatten', '-f', 'ndjson']);
}
export async function listenDws(root: string, profile: string, config: MessageConfig, onEvent: (event: any) => void, onExit: () => void) {
    const children: ChildProcessWithoutNullStreams[] = [];
    let stopping = false;
    const stop = () => { stopping = true; for (const child of children) child.stdin.end(); };
    try {
        for (const args of listenerArgs(config)) {
            await new Promise<void>((resolve, reject) => {
                const child = spawn(resolveDws(), [...args, '--profile', profile], { cwd: root, shell: false, windowsHide: true, stdio: 'pipe' }); children.push(child);
                let ready = false, output = '', diagnostics = '';
                const timer = setTimeout(() => { reject(new Error('DWS listener not ready')); stop(); }, 45000);
                child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
                child.stdout.on('data', chunk => {
                    output += chunk; if (output.length > 1_000_000) { stop(); onExit(); return; }
                    let end; while ((end = output.indexOf('\n')) >= 0) { const line = output.slice(0, end); output = output.slice(end + 1); if (ready && !stopping && line.trim()) { try { onEvent(JSON.parse(line)); } catch { /* invalid event is never executed */ } } }
                });
                child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-4000); if (!ready && diagnostics.includes('[event] ready')) { ready = true; clearTimeout(timer); resolve(); } });
                child.on('error', () => { clearTimeout(timer); reject(new Error('DWS listener could not start')); if (!stopping) onExit(); });
                child.on('close', () => { clearTimeout(timer); if (!ready) reject(new Error(/invalid.?grant|token.*expired|unauthorized|\b401\b|auth login|未登录|请.*登录/i.test(diagnostics) ? 'DingTalk login required' : 'DWS listener exited before ready')); if (!stopping) onExit(); });
            });
        }
        return stop;
    } catch(e) { stop(); throw e; }
}
function bizId(value: any): string {
    if (!value || typeof value !== 'object') return '';
    if (typeof value.bizId === 'string') return value.bizId;
    for (const v of Object.values(value)) { const found = bizId(v); if (found) return found; }
    return '';
}
export class DingTalkDelivery {
    constructor(private root: string, private profile: string) {}
    async create(message: Incoming): Promise<string> {
        try {
            const result = await dws(['chat', '+messages-send-card', ...(message.kind === 'direct' ? ['--receiver-open-dingtalk-id', message.sender] : ['--group', message.conversation]), '--profile', this.profile, '-f', 'json', '--yes'], this.root);
            const id = bizId(result); if (!id) throw new DwsError(true); return id;
        } catch(error) { if (error instanceof DwsError && !error.uncertain) return ''; throw error; }
    }
    async update(card: string, text: string, status: number) {
        return dws(['chat', '+messages-update-card', '--biz-id', card, '--content', text, '--flow-status', String(status), '--profile', this.profile, '-f', 'json', '--yes'], this.root);
    }
    async send(message: Incoming, id: string, text: string) {
        const marker = '【AI 代答】';
        const parts = text.startsWith(marker)
            ? splitReply(text.slice(marker.length), 6000 - Buffer.byteLength(marker)).map(part => marker + part)
            : splitReply(text);
        for (const [index, part] of parts.entries()) await dws(['chat', '+messages-send', '--as', 'user', ...(message.kind === 'direct' ? ['--open-dingtalk-id', message.sender] : ['--group', message.conversation]), '--text', part, '--idempotency-key', `${id}-${index}`, '--profile', this.profile, '-f', 'json', '--yes'], this.root);
    }
}
