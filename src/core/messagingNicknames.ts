import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

export type NicknameTarget = { channel:'dingtalk'|'feishu'; account:string; group:string; root:string; names:string[] };
export type NicknameState = { nickname:string; name:string };
type RecordState = { original:string; base:string; applied:string; pending?:string; manual?:boolean; editBase?:{original:string;base:string} };
export type NicknameAdapter = { read(target:NicknameTarget):Promise<NicknameState>; write(target:NicknameTarget,nickname:string):Promise<unknown> };
export const nicknameKey = (target:NicknameTarget) => createHash('sha256').update(JSON.stringify([target.channel,target.account,target.group])).digest('hex');

/** Local recovery metadata only. No startup writes or blind retry after an uncertain CLI result. */
export class MessagingNicknames {
    private records:Record<string,RecordState> = {};
    private damaged=false;
    private queue:Promise<unknown> = Promise.resolve();
    constructor(private file:string, private adapter:NicknameAdapter) {
        try {
            const data=JSON.parse(fs.readFileSync(file,'utf8'));
            if(!data||typeof data!=='object'||Array.isArray(data))throw Error('Invalid nickname records');
            for(const [key,row] of Object.entries(data) as [string,any][])
                if(/^[a-f0-9]{64}$/.test(key)&&row&&['original','base','applied'].every(k=>typeof row[k]==='string')&&(row.pending===undefined||typeof row.pending==='string')&&(row.manual===undefined||typeof row.manual==='boolean')&&(row.editBase===undefined||(typeof row.editBase?.original==='string'&&typeof row.editBase?.base==='string')))this.records[key]=row;else this.damaged=true;
        } catch { this.damaged=fs.existsSync(file); }
    }
    has(target:NicknameTarget) { return !!this.records[nicknameKey(target)]; }
    private save() {
        fs.mkdirSync(path.dirname(this.file),{recursive:true});
        fs.writeFileSync(this.file+'.tmp',JSON.stringify(this.records),{mode:0o600});fs.renameSync(this.file+'.tmp',this.file);
    }
    sync(target:NicknameTarget, current:()=>boolean=()=>true):Promise<string> {
        const task=this.queue.catch(()=>{}).then(()=>this.apply(target,current));
        this.queue=task;return task;
    }
    private reconcile(key:string,nickname:string):RecordState|undefined {
        const record=this.records[key];
        if(record?.pending===undefined)return record;
        if(nickname===record.pending){record.applied=record.pending;if(record.editBase)Object.assign(record,record.editBase);}
        else if(nickname!==record.applied)throw Error('群昵称已被手动修改，保留当前昵称');
        delete record.pending;delete record.editBase;
        if(record.manual)delete this.records[key];
        this.save();return this.records[key];
    }
    /** Owner-requested edits preserve every unrelated nickname slot, including manual changes. */
    edit(target:NicknameTarget,name:string,remove:boolean,current:()=>boolean):Promise<string> {
        const task=this.queue.catch(()=>{}).then(async()=>{
            if(!current())throw Error('Assignment cancelled');
            if(this.damaged)throw Error('群昵称恢复记录无法读取，未修改群昵称');
            const before=await this.adapter.read(target);
            const key=nicknameKey(target),old=this.reconcile(key,before.nickname);
            const managed=old&&old.applied===before.nickname?old:undefined;
            const parts=before.nickname.replace(/＆/g,'&').split('&').map(s=>s.trim());
            const base=parts[0]||before.name;
            if(!base)throw Error('无法读取本人名称，未修改群昵称');
            if(remove&&!parts.slice(1).some(s=>s.normalize('NFKC').toLowerCase()===name.normalize('NFKC').trim().toLowerCase()))return before.nickname;
            const slots=parts.slice(1).filter(s=>s&&s.normalize('NFKC').toLowerCase()!==name.normalize('NFKC').trim().toLowerCase());
            if(!remove)slots.push(name);
            const desired=[base,...slots].join(' & ');
            if(Buffer.byteLength(desired,'utf8')>300)throw Error('群昵称超过 300 字节');
            const latest=await this.adapter.read(target);
            if(!current()||latest.nickname!==before.nickname)throw Error('群昵称或分身已变化，请重试');
            if(desired===before.nickname)return desired;
            // Explicit owner edits establish a new manual baseline; never overwrite an unknown outcome.
            const baselineSlot=(value:string)=>{
                const bits=value.replace(/＆/g,'&').split('&').map(s=>s.trim());
                const norm=name.normalize('NFKC').trim().toLowerCase();
                if(remove&&!bits.slice(1).some(s=>s.normalize('NFKC').toLowerCase()===norm))return value;
                const remaining=bits.slice(1).filter(s=>s&&s.normalize('NFKC').toLowerCase()!==norm);
                if(!remove)remaining.push(name);
                return [bits[0]||base,...remaining].join(' & ');
            };
            const record:RecordState=managed?{...managed,pending:desired,editBase:{original:baselineSlot(managed.original),base:baselineSlot(managed.base)}}:{original:before.nickname,base,applied:before.nickname,pending:desired,manual:true};
            this.records[key]=record;this.save();
            await this.adapter.write(target,desired);
            if((await this.adapter.read(target)).nickname!==desired)throw Error('群昵称更新结果未确认，请检查后重试');
            this.reconcile(key,desired);return desired;
        });
        this.queue=task;return task;
    }
    private async apply(target:NicknameTarget, current:()=>boolean) {
        if(!current())return '';
        if(this.damaged)throw Error('群昵称恢复记录无法读取，未修改群昵称');
        const key=nicknameKey(target), names=[...new Set(target.names)].sort();
        let record:RecordState|undefined=this.records[key];
        if(!record&&!names.length)return '';
        const before=await this.adapter.read(target);
        if(!current())return '';
        record=this.reconcile(key,before.nickname);
        if(record && before.nickname!==record.applied)throw Error('群昵称已被手动修改，保留当前昵称');
        if(!record) {
            const base=before.nickname||before.name;
            if(!base.trim())throw Error('无法读取本人名称，未修改群昵称');
            record={original:before.nickname,base,applied:before.nickname};
        }
        const existing=new Set(record.base.normalize('NFKC').split('&').slice(1).map(s=>s.trim().toLowerCase()));
        const desired=names.length?[record.base,...names.filter(name=>!existing.has(name.normalize('NFKC').trim().toLowerCase()))].join(' & '):record.original;
        if(Buffer.byteLength(desired,'utf8')>300)throw Error('群昵称超过 300 字节，请缩短智能体名称');
        if(desired===before.nickname) {
            if(names.length&&!this.records[key]){this.records[key]=record;this.save();}
            if(!names.length){delete this.records[key];this.save();}
            return desired;
        }
        // Recheck after asynchronous discovery and immediately before the external write.
        const latest=await this.adapter.read(target);
        if(!current())return '';
        if(latest.nickname!==before.nickname)throw Error('群昵称已变化，未覆盖，请重试');
        this.records[key]=record;record.pending=desired;this.save();
        await this.adapter.write(target,desired);
        const after=await this.adapter.read(target);
        if(after.nickname!==desired)throw Error('群昵称更新结果未确认，请检查后重试');
        record.applied=desired;delete record.pending;
        if(!names.length)delete this.records[key];
        this.save();return desired;
    }
}
