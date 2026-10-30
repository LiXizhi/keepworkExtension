import * as fs from 'node:fs';
import { dws } from './messagingDingtalk';
import { Incoming, automatedText } from './messagingPolicy';

// The event status endpoint on some DWS versions omits the personal open ID.
// Resolve the authenticated stable user ID; never infer identity from a name.
export async function dingtalkHistorySelf(root:string, profile:string, call=dws):Promise<string> {
    const userId=profile.split(':')[1];
    const value=await call(['chat','+search-msg','--senders',userId,'--limit','1','--no-reactions','--profile',profile,'--format','json'],root);
    const matches=value.resolvedFilters?.senders;
    const row=Array.isArray(matches)&&matches.length===1?matches[0]:null;
    if(row?.status!=='resolved'||row.profile!==profile||row.selected?.userId!==userId||!row.selected?.openDingTalkId)
        throw Error('无法核实本人钉钉身份，暂不自动补答');
    return row.selected.openDingTalkId;
}

const DAY = 86400000;
const OVERLAP = 10 * 60000;
export interface DingTalkSyncState { since: number; pending?: { start: number; end: number; cursor: string; visited?: string[] } }
export interface RecoveredMessage extends Incoming { direction: string }
// DWS list-all uses China-local wall times, independent of the daemon's timezone.
function wallTime(time: number) { return new Date(time + 8 * 3600000).toISOString().slice(0,19).replace('T',' '); }
export function historyPage(value: any, self: string, userId: string): { messages: RecoveredMessage[]; next: string } {
    const result = value?.result;
    if (value?.success !== true || !result || !Array.isArray(result.conversationMessagesList) || typeof result.hasMore !== 'boolean' || value.partial || value.failures?.length)
        throw Error('钉钉历史消息读取不完整，保留补收位置');
    const messages: RecoveredMessage[] = [];
    for (const chat of result.conversationMessagesList) {
        if (typeof chat.singleChat !== 'boolean' || !Array.isArray(chat.messages)) throw Error('钉钉历史会话格式无法识别');
        for (const row of chat.messages) {
            const conversation = row.openConversationId || chat.openConversationId;
            const raw = row.createTime;
            const time = typeof raw === 'number' ? (raw < 1e12 ? raw * 1000 : raw)
                : Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(raw) ? raw.replace(' ','T') + '+08:00' : raw);
            if (!row.openMessageId || !conversation || !row.senderOpenDingTalkId || !Number.isFinite(time) || time <= 0)
                throw Error('钉钉历史消息缺少身份或时间，保留补收位置');
            const text = typeof row.content === 'string' && row.content.trim() ? row.content : '[非文本消息]';
            messages.push({id:String(row.openMessageId), conversation:String(conversation), sender:String(row.senderOpenDingTalkId), time,
                text:text.slice(0,16000), kind:chat.singleChat?'direct':'group',
                direction:(self && row.senderOpenDingTalkId===self) || row.sender===userId || row.senderOpenDingTalkId===userId ? 'out':'in',
                automated:/^(robot|bot|app)$/i.test(row.sendType||'') || text==='[非文本消息]' || automatedText(text)});
        }
    }
    const next = result.hasMore ? String(result.nextCursor || '') : '';
    if (result.hasMore && (!next || next==='0')) throw Error('钉钉历史消息分页游标缺失');
    return {messages, next};
}

/** One bounded page per step. Inbox must commit before the cursor can advance. */
export class DingTalkHistorySync {
    state: DingTalkSyncState;
    constructor(private file: string, seed: number, private profile: string, private root: string, private self: string,
        private store: (rows: RecoveredMessage[]) => Promise<void>, private call = dws) {
        try {
            this.state = JSON.parse(fs.readFileSync(file,'utf8'));
            const p = this.state.pending;
            if (!Number.isFinite(this.state.since) || this.state.since <= 0 || (p && (!Number.isFinite(p.start) || !Number.isFinite(p.end) || p.end<=p.start || typeof p.cursor!=='string')))
                throw Error('Invalid checkpoint');
        } catch (error: any) {
            if (error.code !== 'ENOENT') throw Error('钉钉补收记录无法读取，未跳过历史消息');
            this.state = {since:Math.max(1,Math.floor(seed/1000)*1000)};
            this.save();
        }
    }
    private save() { fs.writeFileSync(this.file+'.tmp',JSON.stringify(this.state),{mode:0o600});fs.renameSync(this.file+'.tmp',this.file); }
    async step(now: number, active: () => boolean): Promise<boolean> {
        if (!active()) return false;
        if (!this.state.pending) {
            const start = Math.max(1,this.state.since-OVERLAP), end = Math.min(Math.floor(now/1000)*1000,start+DAY);
            if (end<=this.state.since) return false;
            this.state.pending = {start,end,cursor:'0'}; this.save();
        }
        const p = this.state.pending;
        const value = await this.call(['chat','message','list-all','--start',wallTime(p.start),'--end',wallTime(p.end),
            '--cursor',p.cursor,'--limit','100','--profile',this.profile,'--format','json'],this.root);
        if (!active()) return false;
        const page = historyPage(value,this.self,this.profile.split(':')[1]);
        if (page.next && (page.next===p.cursor || p.visited?.includes(page.next))) throw Error('钉钉历史消息分页没有前进');
        await this.store(page.messages.filter(m=>m.time>=p.start && m.time<=p.end));
        if (!active()) return false;
        if (page.next) this.state.pending = {...p,cursor:page.next,visited:[...(p.visited||[]),p.cursor]};
        else this.state = {since:p.end};
        this.save();
        return !!page.next || p.end < Math.floor(now/1000)*1000;
    }
}
