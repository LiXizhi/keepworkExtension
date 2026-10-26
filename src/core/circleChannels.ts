import {dws,dingtalkGroupName} from './messagingDingtalk';
import {lark,feishuIdentity,feishuGroups} from './messagingFeishu';
import {CircleIdentity,GroupSnapshot} from './circleModel';
export type CircleMessage={id:string;sender:string;name:string;text:string;time:number;kind:string;url?:string};
export type CirclePage={messages:CircleMessage[];cursor:string;incomplete:boolean};
const data=(v:any)=>v.result??v.data??v;
function rows(v:any,keys:string[]){const d=data(v);if(Array.isArray(d))return d;for(const key of keys)if(Array.isArray(d[key]))return d[key];throw Error('Unexpected channel response; synchronization paused');}
export class CircleChannels {
    constructor(private callDws=dws,private callLark=lark){}
    async verify(root:string,b:CircleIdentity){
        if(b.channel==='feishu')await feishuIdentity(root,b.account,this.callLark);
        else{const v=await this.callDws(['event','status','--profile',b.account,'-f','json'],root);if(`${v.identity?.corp_id}:${v.identity?.user_id}`!==b.account)throw Error('Channel account changed');}
    }
    private labels=new Map<string,{time:number;value:{organization:string;accountName:string}}>();
    async accountLabel(root:string,b:CircleIdentity){
        const key=JSON.stringify([root,b.channel,b.account]),cached=this.labels.get(key);if(cached&&Date.now()-cached.time<60000)return cached.value;
        const clean=(v:any)=>typeof v==='string'?v.slice(0,160):'';let value={organization:'',accountName:''};
        try{
            if(b.channel==='dingtalk'){
                const response=await this.callDws(['profile','list','-f','json'],root);
                const row=response.profiles?.find((p:any)=>(p.profile||`${p.corpId||p.corp_id}:${p.userId||p.user_id}`)===b.account);
                if(row)value={organization:clean(row.corpName||row.corp_name),accountName:clean(row.userName||row.user_name)};
            }else{
                const response=await this.callLark(['auth','status','--json','--profile',b.account.split(':')[0]],root),user=response.identities?.user;
                if(`${response.appId}:${user?.openId}`===b.account)value={organization:clean(user.corpName||user.tenantName),accountName:clean(user.userName||user.name)};
            }
        }catch{/* Display metadata is optional; never expose CLI diagnostics. */}
        if(this.labels.size>100)this.labels.clear();this.labels.set(key,{time:Date.now(),value});return value;
    }
    async operator(root:string,b:CircleIdentity){
        if(b.channel==='feishu'){const user=await feishuIdentity(root,b.account,this.callLark);return {id:user.self,name:user.self};}
        const v=await this.callDws(['event','status','--profile',b.account,'-f','json'],root),user=v.identity;
        if(!user||`${user.corp_id}:${user.user_id}`!==b.account||!user.open_dingtalk_id)throw Error('无法核实 Agent 背后真人的钉钉 openDingtalkId，请重新连接渠道');
        return {id:String(user.open_dingtalk_id),name:String(user.user_name||user.open_dingtalk_id)};
    }
    private async call(root:string,b:CircleIdentity,args:string[],write=false){const value=await (b.channel==='feishu'?this.callLark([...args,'--as','user','--profile',b.account.split(':')[0],'--format','json',...(write&&args.includes('delete')?['--yes']:[])],root):this.callDws([...args,'--profile',b.account,'-f','json',...(write?['--yes']:[])],root));if(value?.success===false||value?.ok===false||value?.failedCount||value?.failures?.length||value?.partial)throw Error('Channel operation incomplete');return value;}
    /** Joined groups only; never infer membership from public search results. */
    async discover(root:string,b:CircleIdentity){return (await this.joined(root,b)).filter(g=>g.name.startsWith('X-'));}
    private async joined(root:string,b:CircleIdentity){
        await this.verify(root,b);const groups=new Map<string,{id:string;name:string;isOwner:boolean}>(),seen=new Set<string>();let cursor='';
        for(let page=0;page<20;page++){
            const v=data(await this.call(root,b,b.channel==='feishu'?['im','+chat-list','--types','group','--page-size','100',...(cursor?['--page-token',cursor]:[])]:['chat','group','list-all','--limit','100',...(cursor?['--cursor',cursor]:[])]));
            for(const row of rows(v,['chats','groups','items','list'])){
                const id=row.chat_id||row.openConversationId||row.conversationId,name=row.name||row.title||row.conversationName;
                if(typeof id!=='string'||typeof name!=='string')throw Error('Group identity unavailable; discovery paused');
                if(row.chat_mode!=='p2p'&&!['dissolved','dissolved_save'].includes(row.chat_status))groups.set(id,{id,name,isOwner:['群主','群管理员'].includes(row.myRole)});
            }
            const next=String(v.page_token||v.next_page_token||v.nextCursor||v.next_cursor||'');
            if(v.truncations?.length)throw Error('Incomplete group list');
            if(!next||next==='0'){if(v.has_more||v.hasMore)throw Error('Incomplete group list');return [...groups.values()];}
            if(v.has_more===false||v.hasMore===false)return [...groups.values()];
            if(seen.has(next))throw Error('Repeated group cursor');seen.add(next);cursor=next;
        }throw Error('Incomplete group list; discovery paused');
    }
    /** Platform owner or explicitly reported group administrator; never an ordinary member. */
    async requireOwner(root:string,b:CircleIdentity){
        await this.verify(root,b);
        if(b.channel==='feishu'){
            const info=data(await this.call(root,b,['im','chats','get','--chat-id',b.id,'--user-id-type','open_id']));
            const self=b.account.slice(b.account.indexOf(':')+1);if(info.owner_id!==self&&!info.user_manager_id_list?.includes(self))throw Error('只有群主或管理员可以更新群；无法核实身份时禁止写入');
        }else{
            // list-all reports the authenticated user's role; do not compare the
            // unrelated corp userId and openDingtalkId namespaces or accept admin.
            const group=(await this.joined(root,b)).find(g=>g.id===b.id);
            if(!group?.isOwner)throw Error('只有群主或管理员可以更新群；无法核实当前账号权限时禁止写入');
        }
    }
    async search(root:string,b:CircleIdentity,query:string,contacts=false){
        await this.verify(root,b);if(!contacts&&b.channel==='feishu')return feishuGroups(root,b.account,query,this.callLark);
        const v=await this.call(root,b,b.channel==='feishu'?['contact','+search-user','--query',query]:contacts?['contact','user','search','--query',query]:['chat','search','--query',query]);
        return rows(v,contacts?['users','items','list']:['groups','items','list']).map((r:any)=>({id:String(contacts?(r.open_id||r.openDingtalkId||r.userId||r.user_id):(r.openConversationId||r.chat_id||r.conversationId)||''),name:String(r.name||r.title||r.nick||r.display_name||'')})).filter((r:any)=>r.id);
    }
    /** Exact reserved heading only; never adopt an unrelated group announcement. */
    private async goalNotice(root:string,b:CircleIdentity):Promise<{id:string;description:string}|null>{
        let cursor='';const seen=new Set<string>(),matches=new Map<string,{id:string;description:string}>();
        for(let page=0;page<20;page++){
            const v=data(await this.call(root,b,['chat','group','notice','list','--conversation-id',b.id,'--limit','100',...(cursor?['--cursor',cursor]:[])]));
            for(const row of rows(v,['list','items','notices','noticeList'])){
                const id=row.dataId||row.noticeId;if(typeof id!=='string'||!id)throw Error('群公告身份不可用，停止同步');
                const detail=data(await this.call(root,b,['chat','group','notice','get','--conversation-id',b.id,'--notice-id',id]));
                const content=detail.content??detail.markdown;
                // Summary-only responses cannot prove absence or safely replace a notice.
                if(typeof content!=='string')throw Error('无法完整读取群公告正文，停止 X:goal 同步');
                const normalized=content.replace(/\r\n/g,'\n');
                if(normalized.split('\n')[0].trim()==='# X:goal')matches.set(id,{id,description:normalized.split('\n').slice(1).join('\n').replace(/^\n/,'')});
            }
            const next=String(v.nextPageCursor||'');
            if(v.hasMore===false||(!v.hasMore&&!next)){if(matches.size>1)throw Error('发现多条 X:goal 公告，请先明确保留一条');return [...matches.values()][0]||null;}
            if(!next||seen.has(next))throw Error('群公告分页不完整，停止同步');seen.add(next);cursor=next;
        }throw Error('群公告分页超过限制，停止同步');
    }
    private async updateGoalNotice(root:string,b:CircleIdentity,description:string,remote:GroupSnapshot,check:()=>void){
        const notice=await this.goalNotice(root,b);
        if((notice?.description||'')!==(remote.description||''))throw Error('X:goal 公告已变化，请重新预览');
        if(notice?.description===description)return;
        await this.requireOwner(root,b);check();
        await this.call(root,b,['chat','group','notice',notice?'edit':'create','--conversation-id',b.id,...(notice?['--notice-id',notice.id]:[]),'--content','# X:goal\n\n'+description],true);
    }
    /** Company directory only. Never enumerate chats; stop at 100 unique people. */
    async directory(root:string,b:CircleIdentity,check=()=>{}){
        const deadline=Date.now()+60000,guard=()=>{check();if(Date.now()>deadline)throw Error('公司通讯录读取超时，请稍后重试；本次未保存成员');};
        await this.verify(root,b);guard();
        const queue=[b.channel==='dingtalk'?'1':'0'],seen=new Set<string>(),members=new Map<string,{id:string;name:string}>();let limited=false;
        while(queue.length&&members.size<100){
            guard();const dept=queue.shift()!;if(seen.has(dept))continue;seen.add(dept);if(seen.size>100){limited=true;break;}
            if(b.channel==='dingtalk'){
                const value=await this.call(root,b,['contact','dept','list-members','--depts',dept]);guard();
                for(const row of rows(value,['deptUserList','users','members','list'])){const m=row.userInfo||row;const id=m.openDingtalkId||m.userId;if(!id)throw Error('公司成员缺少平台身份');members.set(String(id),{id:String(id),name:String(m.name||m.userName||id)});if(members.size===100){limited=true;break;}}
                if(members.size===100)break;
                const children=await this.call(root,b,['contact','dept','list-children','--dept',dept]);guard();
                for(const d of rows(children,['departments','list','items'])){const id=d.deptId??d.dept_id;if(id===undefined)throw Error('公司部门信息不完整');if(!seen.has(String(id)))queue.push(String(id));}
            }else{
                const read=async(path:string,params:any)=>{guard();const raw=await this.call(root,b,['api','GET',path,'--params',JSON.stringify(params)]);if(raw.code&&raw.code!==0)throw Error('无法读取公司通讯录，请检查飞书通讯录权限');guard();return data(raw);};
                let token='';const tokens=new Set<string>();
                do{const value=await read('/open-apis/contact/v3/users/find_by_department',{department_id:dept,department_id_type:'open_department_id',user_id_type:'open_id',page_size:Math.min(50,100-members.size),...(token?{page_token:token}:{})});
                    for(const m of rows(value,['items'])){if(!m.open_id)throw Error('公司成员缺少 open_id');members.set(m.open_id,{id:m.open_id,name:String(m.name||m.open_id)});if(members.size===100){limited=true;break;}}
                    if(members.size===100||!value.has_more)break;token=value.page_token;if(!token||tokens.has(token))throw Error('公司通讯录分页不完整');tokens.add(token);
                }while(true);
                if(members.size===100)break;
                token='';tokens.clear();do{const value=await read('/open-apis/contact/v3/departments/'+encodeURIComponent(dept)+'/children',{department_id_type:'open_department_id',page_size:50,...(token?{page_token:token}:{})});for(const d of rows(value,['items'])){if(!d.open_department_id)throw Error('公司部门信息不完整');if(!seen.has(d.open_department_id))queue.push(d.open_department_id);}if(!value.has_more)break;token=value.page_token;if(!token||tokens.has(token))throw Error('公司部门分页不完整');tokens.add(token);}while(true);
            }
        }
        return {members:[...members.values()].slice(0,100),groups:0,source:'company',limit:100,limited:limited||queue.length>0};
    }
    async snapshot(root:string,b:CircleIdentity,includeDescription=true,check=()=>{}):Promise<GroupSnapshot>{
        check();await this.verify(root,b);check();
        if(b.channel==='feishu'){
            const info=data(await this.call(root,b,['im','chats','get','--chat-id',b.id]));
            const result=data(await this.call(root,b,['im','+chat-members-list','--chat-id',b.id,'--member-types','user','--page-all','--page-limit','20']));
            if(result.has_more||result.truncations?.length||!Array.isArray(result.users))throw Error('Incomplete member list; synchronization paused');
            return {name:String(info.name),description:typeof info.description==='string'?info.description:undefined,members:result.users.map((m:any)=>({id:String(m.member_id||m.open_id),name:String(m.name||m.member_id||m.open_id)}))};
        }
        const name=await dingtalkGroupName(root,b.account,b.id,this.callDws),members:{id:string;name:string}[]=[];let cursor='0';const seen=new Set();
        for(let page=0;page<20;page++){
            check();const v=data(await this.call(root,b,['chat','group','members','--id',b.id,'--cursor',cursor]));
            const bucket=rows(v,['members','list','userList']);
            for(const m of bucket){const key=m.openDingtalkId||m.userId||m.userid;if(!key)throw Error('Member identity unavailable');members.push({id:String(key),name:String(m.name||m.nick||m.memberEmpName||key)});}
            const next=String(v.nextCursor??v.next_cursor??'');if(!next||next==='0'||v.hasMore===false)return {name,description:includeDescription?(await this.goalNotice(root,b))?.description||'':undefined,members};if(seen.has(next))throw Error('Repeated member cursor');seen.add(next);cursor=next;
        }throw Error('Incomplete member list; synchronization paused');
    }
    async create(root:string,b:CircleIdentity,s:GroupSnapshot,type:string,check=()=>{},dryRun=false){
        await this.verify(root,b);
        const users=s.members.map(m=>m.id).join(',');
        if(b.channel==='dingtalk'&&!users)throw Error('钉钉建群需要至少一名已解析的真人成员');
        const args=b.channel==='feishu'?['im','+chat-create','--name',s.name,'--owner',b.account.slice(b.account.indexOf(':')+1),'--type','private','--description',s.description||'',...(users?['--users',users]:[])]:['chat','group','create','--name',s.name,'--users',users,'--type',type==='EXTERNAL'?'EXTERNAL':'INTERNAL'];
        check();if(dryRun){await this.call(root,b,[...args,'--dry-run']);return '';}
        const v=data(await this.call(root,b,args,true)),key=v.chat_id||v.openConversationId||v.conversationId;
        if(!key)throw Error('Creation result unknown; verify group before retrying');return String(key);
    }
    async update(root:string,b:CircleIdentity,s:GroupSnapshot,remote:GroupSnapshot,remove:string[]=[],check=()=>{}){
        await this.requireOwner(root,b);
        check();if(s.name!==remote.name||(b.channel==='feishu'&&s.description!==remote.description))await this.call(root,b,b.channel==='feishu'?['im','+chat-update','--chat-id',b.id,'--name',s.name,'--description',s.description||'']:['chat','group','rename','--id',b.id,'--name',s.name],true);
        if(b.channel==='dingtalk'&&s.description!==undefined&&s.description!==remote.description)await this.updateGoalNotice(root,b,s.description,remote,check);
        const add=s.members.filter(m=>!remote.members.some(r=>r.id===m.id)).map(m=>m.id);
        for(const [ids,operation] of [[add,'add'],[remove,'remove']] as [string[],string][]){if(!ids.length)continue;
            await this.requireOwner(root,b);check();const v=data(await this.call(root,b,b.channel==='feishu'?['im','chat.members',operation==='add'?'create':'delete','--chat-id',b.id,'--member-id-type','open_id','--data',JSON.stringify({id_list:ids})]:['chat','group','members',operation,'--id',b.id,'--users',ids.join(',')],true));
            if(v.invalid_id_list?.length||v.not_existed_id_list?.length||v.pending_approval_id_list?.length)throw Error('Some members were not applied; refresh before retry');
        }
    }
    async history(root:string,b:CircleIdentity,cursor=''):Promise<CirclePage>{
        await this.verify(root,b);
        const v=data(await this.call(root,b,b.channel==='feishu'?['im','+chat-messages-list','--chat-id',b.id,'--page-size','50','--no-reactions',...(cursor?['--page-token',cursor]:[])]:['chat','+chat-messages','--group',b.id,'--limit','50',...(cursor?['--time',cursor]:[])]));
        const messages=rows(v,['messages','items']).map((m:any)=>{
            let body=m.text||m.content?.text||m.body?.content||m.content||'';if(typeof body==='string'){try{body=JSON.parse(body).text||body;}catch{}}else body=JSON.stringify(body);
            return {id:String(m.message_id||m.messageId||m.id||''),sender:String(m.sender?.id||m.sender?.open_id||m.sender?.sender_id?.open_id||m.senderOpenDingTalkId||m.senderId||''),name:String(m.sender?.name||m.senderName||''),text:String(body).slice(0,32000),time:(()=>{const raw=m.create_time||m.createTime||m.timestamp||m.time;const n=Number(raw)||Date.parse(raw);if(!Number.isFinite(n)||n<=0)throw Error('Message timestamp unavailable');return n<1e12?n*1000:n;})(),kind:String(m.msg_type||m.message_type||m.messageType||'text'),...((()=>{try{const u=new URL(m.url||m.message_url||'');return u.protocol==='https:'&&/(^|\.)(feishu\.cn|larksuite\.com|dingtalk\.com)$/.test(u.hostname);}catch{return false;}})()?{url:String(m.url||m.message_url)}:{})};
        });if(messages.some(m=>!m.id||!m.sender))throw Error('Message ID unavailable');
        return {messages,cursor:String(v.page_token||v.next_page_token||v.nextPage?.time||''),incomplete:!!(v.partial||v.failedCount||v.truncations?.length||(v.has_more&&!v.page_token&&!v.next_page_token))};
    }
    async send(root:string,b:CircleIdentity,requestId:string,text:string,reply?:CircleMessage,check=()=>{}){
        await this.verify(root,b);
        const args=b.channel==='feishu'?(reply?['im','+messages-reply','--message-id',reply.id]:['im','+messages-send','--chat-id',b.id]):(reply?['chat','message','reply','--group',b.id,'--ref-msg-id',reply.id,'--ref-sender',reply.sender,'--content',text,'--uuid',requestId]:['chat','+messages-send','--as','user','--group',b.id]);
        if(b.channel==='feishu')args.push('--content',JSON.stringify({text}),'--msg-type','text','--idempotency-key',requestId);
        else if(!reply)args.push('--text',text,'--idempotency-key',requestId);
        check();await this.call(root,b,args,true);
    }
}
