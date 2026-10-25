import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { Incoming, MessageConfig, splitReply, automatedSender, automatedText } from './messagingPolicy';

export function resolveDws(): string {
    const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter);
    const binary = process.platform === 'win32' ? 'dws.exe' : 'dws';
    const candidates = [process.env.KEEPWORK_DWS_PATH || '', path.join(os.homedir(), '.local', 'bin', binary), ...dirs.map(d => path.join(d, binary)),
        ...[process.env.APPDATA && path.join(process.env.APPDATA, 'npm'), ...dirs, path.join(os.homedir(), '.npm-global', 'lib'), '/usr/local/lib', '/opt/homebrew/lib']
            .filter((v): v is string => !!v).map(d => path.join(d, 'node_modules/dingtalk-workspace-cli/vendor', binary))];
    for (const file of candidates) if (path.isAbsolute(file) && fs.existsSync(file) && fs.statSync(file).isFile()) return file;
    throw new Error('DWS CLI unavailable; install dingtalk-workspace-cli or set KEEPWORK_DWS_PATH to its native executable');
}
export class DwsError extends Error { constructor(public uncertain: boolean, public detail?: any, reason = '') { super((uncertain ? 'DWS result unknown; not retried' : 'DWS rejected the operation') + (reason ? ` (${reason})` : '')); } }
export function dws(args: string[], cwd: string): Promise<any> {
    return new Promise((resolve, reject) => {
        let child: ChildProcessWithoutNullStreams;
        try { child = spawn(resolveDws(), args, { cwd, shell: false, windowsHide: true, stdio: 'pipe' }); } catch(e) { reject(e); return; }
        let output = '', diagnostics = '', settled = false;
        const finish = (error?: Error, value?: any) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
        const timer = setTimeout(() => { child.stdin.end(); finish(new DwsError(true)); }, 45000);
        child.stdout.setEncoding('utf8'); child.stdout.on('data', s => { output += s; if (output.length > 2_000_000) { child.stdin.end(); finish(new DwsError(true)); } });
        child.stderr.setEncoding('utf8'); child.stderr.on('data', s => { diagnostics = (diagnostics + s).slice(-4000); });
        child.on('error', () => finish(new DwsError(false)));
        child.on('close', code => { try { const result = JSON.parse(output); if (code || result.error) finish(new DwsError(false, result.error)); else finish(undefined, result); } catch {
            // Never surface raw stderr: URLs and diagnostics can contain credentials.
            const reason = /proxy/i.test(diagnostics) && /connection|connect|dial/i.test(diagnostics)
                ? 'proxy connection failed; check daemon proxy settings'
                : `exit ${code}, invalid JSON, ${output.length} characters`;
            finish(new DwsError(true, undefined, reason));
        } });
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
export function listenerArgs(config: MessageConfig & { allGroups?: boolean }): string[][] {
    return [['user_im_message_receive_at', 'user_im_message_receive_o2o_all'],
        ...(config.allGroups ? [['user_im_message_receive_group_all']] : config.keywords.length ? config.groups.map(group => ['user_im_message_receive_group', '--group', group]) : [])]
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
                child.on('close', () => { clearTimeout(timer); if (!ready && /unknown.{0,30}(event|rule)|unsupported|not supported|invalid.{0,10}event/i.test(diagnostics)) { reject(new Error('DWS CLI update required for message subscriptions')); } else if (!ready) reject(new Error(/invalid.?grant|token.*expired|unauthorized|\b401\b|auth login|未登录|请.*登录/i.test(diagnostics) ? 'DingTalk login required' : 'DWS listener exited before ready')); if (!stopping) onExit(); });
            });
        }
        return stop;
    } catch(e) { stop(); throw e; }
}
// On-demand context reads complement the event listener; they never enqueue replies.
export async function dingtalkConversation(root: string, profile: string, target: Incoming, signal?: AbortSignal, call = dws): Promise<Incoming[]> {
    const check = () => { if(signal?.aborted)throw Error('Cancelled'); };
    check();
    const status = await call(['event','status','--profile',profile,'--format','json'],root);
    const identity = status.identity;
    if(!identity?.open_dingtalk_id || `${identity.corp_id}:${identity.user_id}`!==profile)throw Error('DWS identity does not match configured profile');
    const read = async (selector: string[]) => {
        check();
        const result = await call(['chat',...selector,'--limit','50','--order','desc','--no-reactions','--profile',profile,'--format','json'],root);
        check();
        // A bounded single page may have older pages; failed/ambiguous reads are not usable context.
        if(result.contractVersion!=='im.message-list.v1' || !Array.isArray(result.messages) || result.partial || result.failedCount || result.failures?.length ||
            (result.complete===false && result.hasMore!==true))throw Error('钉钉会话上下文读取不完整');
        return result.messages;
    };
    const rows = await read(['+chat-messages',...(target.kind==='direct' ? ['--open-dingtalk-id',target.sender] : ['--group',target.conversation])]);
    const thread=target.thread || rows.find((row:any)=>row.messageId===target.id)?.threadId;
    const conversation=rows.find((row:any)=>row.messageId===target.id)?.conversationId;
    if(thread)rows.push(...await read(['+thread-replies','--group',conversation || target.conversation,'--thread-id',thread]));
    const messages=new Map<string,Incoming>();
    for(const row of rows) {
        const numeric=Number(row.createTime),time=Number.isFinite(numeric)?numeric:Date.parse(row.createTime);
        if(typeof row.messageId!=='string' || typeof row.senderId!=='string' || !Number.isFinite(time) || time<=0)throw Error('钉钉消息缺少身份或时间');
        if(conversation && row.conversationId && row.conversationId!==conversation)throw Error('钉钉会话上下文不匹配');
        const text=typeof row.text==='string'?row.text:'[非文本消息]';
        messages.set(row.messageId,{id:row.messageId,conversation:target.conversation,
            sender:row.senderId===identity.user_id?identity.open_dingtalk_id:row.senderId,
            time:time<1e12?time*1000:time,text,kind:target.kind,thread:row.threadId || undefined,
            automated:automatedSender(row)||automatedText(text)});
    }
    return [...messages.values()].sort((a,b)=>a.time-b.time || a.id.localeCompare(b.id));
}

function bizId(value: any): string {
    if (!value || typeof value !== 'object') return '';
    if (typeof value.bizId === 'string') return value.bizId;
    for (const v of Object.values(value)) { const found = bizId(v); if (found) return found; }
    return '';
}
export class DingTalkDelivery {
    constructor(private root: string, private profile: string, private beforeSend?:()=>Promise<void>) {}
    async create(message: Incoming): Promise<string> {
        await this.beforeSend?.();
        try {
            const result = await dws(['chat', '+messages-send-card', ...(message.kind === 'direct' ? ['--receiver-open-dingtalk-id', message.sender] : ['--group', message.conversation]), '--profile', this.profile, '-f', 'json', '--yes'], this.root);
            const id = bizId(result); if (!id) throw new DwsError(true); return id;
        } catch(error) { if (error instanceof DwsError && !error.uncertain) return ''; throw error; }
    }
    async update(card: string, text: string, status: number) {
        await this.beforeSend?.();
        return dws(['chat', '+messages-update-card', '--biz-id', card, '--content', text, '--flow-status', String(status), '--profile', this.profile, '-f', 'json', '--yes'], this.root);
    }
    async send(message: Incoming, id: string, text: string) {
        const marker = text.match(/^【[^【】\r\n]{1,80}\s*·\s*AI】/)?.[0] || '【AI 代答】';
        const parts = text.startsWith(marker)
            ? splitReply(text.slice(marker.length), 6000 - Buffer.byteLength(marker)).map(part => marker + part)
            : splitReply(text);
        for (const [index, part] of parts.entries()) {await this.beforeSend?.();await dws(['chat', '+messages-send', '--as', 'user', ...(message.kind === 'direct' ? ['--open-dingtalk-id', message.sender] : ['--group', message.conversation]), '--text', part, '--idempotency-key', `${id}-${index}`, '--profile', this.profile, '-f', 'json', '--yes'], this.root);}
    }
}

async function nicknameIdentity(root:string, profile:string, call=dws) {
    const status=await call(['event','status','--profile',profile,'-f','json'],root);
    const identity=status.identity;
    if(!identity?.open_dingtalk_id || `${identity.corp_id}:${identity.user_id}`!==profile)throw Error('DWS identity does not match configured profile');
    return identity;
}
export async function dingtalkNickname(root:string, profile:string, group:string, call=dws) {
    await nicknameIdentity(root,profile,call);
    const result=await call(['chat','group','user-settings','query','--groups',group,'--profile',profile,'-f','json'],root);
    const found:any[]=[];
    const visit=(value:any)=>{
        if(!value||typeof value!=='object')return;
        if((value.openConversationId||value.conversationId||value.cid)===group && Object.prototype.hasOwnProperty.call(value,'groupNick'))found.push(value);
        else for(const child of Object.values(value))visit(child);
    };
    visit(result);
    if(found.length!==1 || (found[0].groupNick!==null&&typeof found[0].groupNick!=='string'))throw Error('无法确认钉钉当前群昵称，未修改');
    const nickname=found[0].groupNick||'';
    if(nickname)return {nickname,name:''};
    const me=await call(['contact','+me','--profile',profile,'-f','json'],root);
    const data=me.data||me,user=data.user||data;
    return {nickname,name:typeof user.name==='string'?user.name:''};
}
export async function setDingtalkNickname(root:string, profile:string, group:string, nickname:string, call=dws) {
    await nicknameIdentity(root,profile,call);
    return call(['chat','group','update-nick','--conversation-id',group,...(nickname?['--nick',nickname]:[]),'--profile',profile,'-f','json','--yes'],root);
}

export async function dingtalkGroupName(root:string,profile:string,group:string,call=dws) {
    await nicknameIdentity(root,profile,call);
    const result=await call(['chat','+conversation-info','--group',group,'--profile',profile,'-f','json'],root);
    const names:string[]=[];
    const visit=(value:any,depth=0)=>{
        if(!value||typeof value!=='object'||depth>5)return;
        const id=value.openConversationId||value.open_conversation_id||value.conversationId||value.conversation_id;
        if(id&&id!==group)return;
        const name=value.title||value.name||value.conversationName;
        if(typeof name==='string'&&name.trim())names.push(name.trim().slice(0,256));
        else for(const key of ['data','result','conversation','conversationInfo'])visit(value[key],depth+1);
    };
    visit(result);if(names.length!==1)throw Error('Group name unavailable');return names[0];
}
