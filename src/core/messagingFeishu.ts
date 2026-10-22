import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Incoming, splitReply, automatedSender, automatedText } from './messagingPolicy';

export const FEISHU_MESSAGE_SCOPES = 'contact:user.basic_profile:readonly offline_access search:message im:chat:read im:message:readonly im:message.group_msg:get_as_user im:message.p2p_msg:get_as_user im:message.send_as_user';
export function resolveLark(): string {
    const binary = process.platform === 'win32' ? 'lark-cli.exe' : 'lark-cli';
    const dirs = (process.env.PATH || '').split(path.delimiter);
    const candidates = [process.env.KEEPWORK_LARK_PATH || '', path.join(os.homedir(), '.local/bin', binary),
        ...dirs.map(dir => path.join(dir, binary)),
        ...[process.env.APPDATA && path.join(process.env.APPDATA, 'npm'), ...dirs, '/usr/local/lib', '/opt/homebrew/lib'].filter(Boolean).map(dir => path.join(dir!, 'node_modules/@larksuite/cli/bin', binary))];
    const found = candidates.find(file => path.isAbsolute(file) && fs.existsSync(file) && fs.statSync(file).isFile());
    if (!found) throw Error('Lark CLI unavailable; install @larksuite/cli');
    return found;
}
// Never return raw CLI diagnostics: they can include account or credential data.
export function lark(args: string[], cwd: string, signal?: AbortSignal): Promise<any> {
    return new Promise((resolve, reject) => {
        const child = spawn(resolveLark(), args, {cwd, shell:false, windowsHide:true, stdio:'pipe', signal});
        let output = '', diagnostics = '', settled = false;
        const finish = (error?: Error, value?: any) => { if (settled) return; settled=true; clearTimeout(timer); error ? reject(error) : resolve(value); };
        const timer = setTimeout(() => {child.kill(); finish(Error('Feishu CLI timed out'));}, 45000);
        child.stdin.end(); child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => {output+=chunk;if(output.length>4_000_000){child.kill();finish(Error('Feishu response too large'));}});
        child.stderr.on('data', chunk => {diagnostics=(diagnostics+chunk).slice(-8000);});
        child.on('error', () => finish(Error(signal?.aborted ? 'Cancelled' : 'Lark CLI unavailable')));
        child.on('close', code => {
            let value: any; try {value=JSON.parse(output);} catch { /* classified below */ }
            if (!code && value && value.ok!==false && !value.error && (!value.code || value.code===0)) return finish(undefined,value);
            const errorText=output+' '+diagnostics;
            finish(Error(/scope|permission|9999167[29]|forbidden/i.test(errorText) ? 'Feishu permission denied; authorize personal messaging scopes: '+FEISHU_MESSAGE_SCOPES : /token|auth login|unauthorized|未登录/i.test(errorText) ? 'Feishu login required' : 'Feishu CLI request failed'));
        });
    });
}
export async function feishuIdentity(root: string, profile?: string, call = lark) {
    const value=await call(['auth','status','--json','--verify',...(profile?['--profile',profile.split(':')[0]]:[])],root);
    const user=value.identities?.user;
    if(user?.status!=='ready'||user.available!==true||user.verified!==true||!user.openId||!value.appId)throw Error('Feishu login required');
    const id=value.appId+':'+user.openId;
    if(profile&&id!==profile)throw Error('Feishu identity does not match configured profile');
    return {id,self:String(user.openId)};
}
export function feishuIncoming(row: any, chat: any, self: string): Incoming | null {
    const sender=row.sender?.id||row.sender?.open_id;
    const numeric=Number(row.create_time);const time=Number.isFinite(numeric)?numeric:Date.parse(row.create_time);
    if(row.deleted||!row.message_id||!sender||!Number.isFinite(time)||!time||!['text','post'].includes(row.msg_type||row.message_type)||typeof row.content!=='string')return null;
    if(automatedSender(row))return null;
    let content=row.content;
    try {const parsed=JSON.parse(content);if(typeof parsed.text==='string')content=parsed.text;} catch { /* shortcuts render plain text */ }
    const mentionedSelf=!!self && Array.isArray(row.mentions) && row.mentions.some((m:any)=>(typeof m.id==='string'?m.id:m.id?.open_id)===self);
    return {id:row.message_id,conversation:chat.chat_id,sender,text:content,time:time<1e12?time*1000:time,automated:automatedText(content),
        mentionedSelf, thread:typeof row.thread_id === 'string' ? row.thread_id : undefined,
        kind:chat.chat_mode==='p2p'?'direct':mentionedSelf?'mention':'group'};
}
// One sweep at a time; bounded pages fail visibly instead of advancing past unread data.
export async function pollFeishu(root:string, profile:string, file:string, onMessage:(message:Incoming)=>void, onError:(error:Error)=>void, onPoll:(time:number)=>void, call=lark, interval=600000, signal?:AbortSignal) {
    const controller=new AbortController(); let timer:NodeJS.Timeout|undefined;
    const abort=()=>{controller.abort();clearTimeout(timer);};
    if(signal?.aborted)throw Error('Cancelled');
    signal?.addEventListener('abort',abort,{once:true});
    // Search the last 11 minutes (10-minute interval plus overlap) across conversations. Never enumerate the account's chats.
    // One search page per tick bounds work even for very large accounts.
    let checkpoint:{since:number;window?:{start:number;end:number;token:string}}={since:Date.now()};
    try{const saved=JSON.parse(fs.readFileSync(file,'utf8'));if(Number.isFinite(saved.since))checkpoint={since:saved.since,window:saved.window};}catch{/* first connection */}
    const save=()=>{fs.writeFileSync(file+'.tmp',JSON.stringify(checkpoint),{mode:0o600});fs.renameSync(file+'.tmp',file);};
    save();
    const sweep=async()=>{
        const identity=await feishuIdentity(root,profile,(args,cwd)=>call(args,cwd,controller.signal));
        if(controller.signal.aborted)throw Error('Cancelled');
        const end=Date.now();
        const window=checkpoint.window||{start:Math.max(checkpoint.since,end-660000),end,token:''};
        checkpoint.window=window;save();
        const result=await call(['im','+messages-search','--start',new Date(window.start).toISOString().replace(/\.\d{3}Z$/, '+00:00'),'--end',new Date(window.end).toISOString().replace(/\.\d{3}Z$/, '+00:00'),
            '--page-size','50','--no-reactions','--as','user','--profile',profile.split(':')[0],'--format','json',
            ...(window.token?['--page-token',window.token]:[])],root,controller.signal);
        if(controller.signal.aborted)throw Error('Cancelled');
        const data=result.data||result;
        if(!Array.isArray(data.messages))throw Error('Unexpected Feishu search response');
        if(data.has_more&&(!data.page_token||data.page_token===window.token))throw Error('Feishu pagination incomplete');
        for(const row of data.messages){
            if(!row.chat_id||!['p2p','group'].includes(row.chat_type))continue;
            const message=feishuIncoming(row,{chat_id:row.chat_id,chat_mode:row.chat_type},identity.self);
            if(message&&message.time>=window.start&&message.time<=window.end)onMessage(message);
        }
        // Continue dense windows next tick; never burst through all their pages.
        if(data.has_more)window.token=data.page_token;else delete checkpoint.window;
        save();onPoll(end);
    };
    const schedule=()=>{if(controller.signal.aborted)return;timer=setTimeout(()=>{void sweep().then(schedule).catch(error=>{if(!controller.signal.aborted)onError(error);});},interval);timer.unref();};
    try{await sweep();schedule();}catch(error){controller.abort();throw error;}
    return ()=>{abort();signal?.removeEventListener('abort',abort);};
}
// Read only the active conversation, never other chats. Bounds are explicit in the model prompt.
export async function feishuConversation(root: string, profile: string, target: Incoming, signal?: AbortSignal, call = lark): Promise<Incoming[]> {
    const identity = await feishuIdentity(root, profile, (args, cwd) => call(args, cwd, signal));
    const read = async (selector: string[]) => {
        const result = await call(['im', ...selector, '--order', 'desc', '--page-size', '50', '--no-reactions', '--as', 'user', '--profile', profile.split(':')[0], '--format', 'json'], root, signal);
        const data = result.data || result;
        if (!Array.isArray(data.messages)) throw Error('Unexpected Feishu conversation response');
        return data.messages;
    };
    const rows = await read(['+chat-messages-list', '--chat-id', target.conversation]);
    const thread = target.thread || rows.find((row: any) => row.message_id === target.id)?.thread_id;
    if (thread) rows.push(...await read(['+threads-messages-list', '--thread', thread]));
    const messages = new Map<string, Incoming>();
    for (const row of rows) {
        // Include bot/AI messages and media placeholders as context, never as reply triggers.
        const normalized = feishuIncoming({...row, sender_type:undefined, senderType:undefined, sender:{id:row.sender?.id || row.sender?.open_id},
            msg_type:'text', content:typeof row.content === 'string' ? row.content : '[非文本消息]'},
            {chat_id:target.conversation, chat_mode:target.kind === 'direct' ? 'p2p' : 'group'}, identity.self);
        if (normalized) messages.set(normalized.id, {...normalized, automated:automatedSender(row) || normalized.automated});
    }
    if (signal?.aborted) throw Error('Cancelled');
    return [...messages.values()].sort((a,b) => a.time-b.time || a.id.localeCompare(b.id));
}
export { conversationContext as feishuContext } from './messagingPolicy';

export class FeishuDelivery {
    constructor(private root:string,private profile:string){}
    async create(_message:Incoming){return '';}
    async update(_card:string,_text:string,_status:number){}
    async send(message:Incoming,id:string,text:string){
        await feishuIdentity(this.root,this.profile);
        for(const [index,part] of splitReply(text).entries())await lark(['im','+messages-reply','--as','user','--profile',this.profile.split(':')[0],'--message-id',message.id,'--text',part,'--idempotency-key',createHash('sha256').update(id+':'+index).digest('hex').slice(0,48),'--format','json'],this.root);
    }
}
