import * as fs from 'node:fs';
import * as path from 'node:path';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash,randomUUID} from 'node:crypto';
import {Circle,Organization,CircleIdentity,GroupSnapshot,organization,emptyOrganization,identityKey,circleMembers,circleSnapshot,validateGroupDescription,importCircleDescription,reconcile,circleAgentContext} from './circleModel';
import {CircleChannels,CircleMessage} from './circleChannels';
import {MessageAgent} from './personaMessaging';
type Binding={id:string;channel:string;profile:string;root:string;enabled:boolean};
type State={groups:Record<string,any>;receipts:Record<string,any>;discovery?:Record<string,any>;memberSync?:Record<string,any>};
export type CircleDependencies={root:(owner:string)=>string;bindings:(owner:string)=>Binding[];allowed:(owner:string,id:string)=>boolean;agents:(owner:string)=>MessageAgent[];pause:(owner:string,binding:string,group:string)=>void};
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const groupVersion=(s:GroupSnapshot)=>JSON.stringify([s.name,s.description??null,s.members.map(m=>m.id).sort()]);
/** Only a validated host owner can invoke this service. No external-message tool grants. */
export class Circles {
    // Request-local selection: simultaneous tabs never change one another's organization.
    private organizationContext=new AsyncLocalStorage<string>();
    private organizationId(){return this.organizationContext.getStore()||'default';}
    private scope(owner:string,root:string){return hash(owner+'\0'+root+(this.organizationId()==='default'?'':'\0'+this.organizationId()));}
    private organizations(root:string){
        const directory=path.dirname(this.organizationContext.run('default',()=>this.file(root)));
        const ids=['default',...(fs.existsSync(directory)?fs.readdirSync(directory).filter(f=>/^organization\.[a-f0-9]{64}\.json$/.test(f)).map(f=>f.slice(13,-5)):[])];
        return ids.map(id=>({id,organization:this.organizationContext.run(id,()=>this.read(root))}));
    }
    private boundElsewhere(root:string,b:CircleIdentity){const id=this.organizationId();return this.organizations(root).some(o=>o.id!==id&&o.organization.circles.some(c=>c.binding&&identityKey(c.binding)===identityKey(b)));}
    async refreshAll(owner:string){const root=this.root(owner);for(const row of this.organizations(root)){this.guard(owner,root);await this.request(owner,'refresh',{organizationId:row.id,expectedScope:this.organizationContext.run(row.id,()=>this.scope(owner,root))}).catch(()=>{});}}
    private locks=new Map<string,Promise<any>>();private owners=new Set<string>();private timer:NodeJS.Timeout;private closed=false;
    private previews=new Map<string,{owner:string;root:string;organizationId:string;revision:number;input:any}>();
    constructor(private home:string,private deps:CircleDependencies,private channel=new CircleChannels()){
        fs.mkdirSync(home,{recursive:true});
        this.timer=setInterval(()=>{for(const owner of this.owners)void this.refreshAll(owner).catch(()=>{});},600000);this.timer.unref();
    }
    register(owner:string){this.owners.add(owner);}
    observe(owner:string,b:CircleIdentity,message:CircleMessage){
        // Serialize verified listener events with organization writes and catch-up.
        try{const root=this.root(owner),prior=this.locks.get(root)||Promise.resolve();
            const task=prior.catch(()=>{}).then(()=>{
                this.guard(owner,root);for(const row of this.organizations(root))this.organizationContext.run(row.id,()=>{const org=row.organization;if(!org.circles.some(c=>!c.archived&&c.binding&&identityKey(c.binding)===identityKey(b)))return;
                const state=this.state(owner,root),record=state.groups[identityKey(b)]||={};
                record.messages=[...(record.messages||[]).filter((m:CircleMessage)=>m.id!==message.id),message].slice(-10000);record.lastMessagesAt=Date.now();this.save(owner,root,state);});
            });this.locks.set(root,task);void task.catch(()=>{}).finally(()=>{if(this.locks.get(root)===task)this.locks.delete(root);});
        }catch{/* No projection is created without a valid owner brain. */}
    }
    close(){this.closed=true;clearInterval(this.timer);this.previews.clear();}
    private root(owner:string){const root=this.deps.root(owner);if(!root||!path.isAbsolute(root)||!fs.statSync(root).isDirectory())throw Error('请绑定可用的本机第二大脑目录');return fs.realpathSync(root);}
    private file(root:string,create=false){let current=root;for(const name of ['.aichat','circles']){current=path.join(current,name);if(fs.existsSync(current)){if(fs.lstatSync(current).isSymbolicLink()||!fs.statSync(current).isDirectory())throw Error('Unsafe circles directory');}else if(create)fs.mkdirSync(current);}
        const file=path.join(current,this.organizationId()==='default'?'organization.json':'organization.'+this.organizationId()+'.json');if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())throw Error('Unsafe circles file');return file;}
    read(root:string){const file=this.file(root);if(!fs.existsSync(file))return emptyOrganization();if(fs.statSync(file).size>2_000_000)throw Error('Organization too large');return organization(JSON.parse(fs.readFileSync(file,'utf8')));}
    private write(root:string,value:Organization,revision:number){const old=this.read(root);if(old.revision!==revision)throw Error('组织已变化，请刷新后重新预览');const next=organization({...value,revision:revision+1});const file=this.file(root,true),tmp=file+'.'+randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(next,null,2),{mode:0o600});fs.renameSync(tmp,file);return next;}
    private state(owner:string,root:string):State{const file=path.join(this.home,this.scope(owner,root)+'.json');if(!fs.existsSync(file))return {groups:{},receipts:{}};return JSON.parse(fs.readFileSync(file,'utf8'));}
    private save(owner:string,root:string,s:State){const file=path.join(this.home,this.scope(owner,root)+'.json'),tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(s),{mode:0o600});fs.renameSync(tmp,file);}
    private guard(owner:string,root:string,binding?:Binding){if(this.closed||this.root(owner)!==root)throw Error('第二大脑或账号连接已变化');if(binding&&(!this.deps.bindings(owner).some(b=>b.id===binding.id&&b.profile===binding.profile&&b.root===root)||!this.deps.allowed(owner,binding.id)))throw Error('Channel unavailable or this computer is not the active gateway');}
    private binding(owner:string,root:string,b:CircleIdentity){const row=this.deps.bindings(owner).find(x=>x.root===root&&x.channel===b.channel&&x.profile===b.account);if(!row)throw Error('请先连接此账号的消息渠道');this.guard(owner,root,row);return row;}
    private circle(org:Organization,id:string){const c=org.circles.find(c=>c.id===id);if(!c)throw Error('Unknown circle');return c;}
    private async projectedGroup(owner:string,root:string,org:Organization,c:Circle){
        const result=circleSnapshot(org,c),personas=circleMembers(org,c).filter(m=>m.kind==='persona');
        if(!personas.length||!c.binding)return {...result,operators:[]};
        const agents=this.deps.agents(owner);
        for(const m of personas){const a=agents.find(a=>a.id===m.personaId);if(!a||a.owner!==owner||a.root!==root)throw Error('Agent 必须属于当前真人账号及第二大脑');}
        const operator=await this.channel.operator(root,c.binding);this.guard(owner,root,this.binding(owner,root,c.binding));
        const known=org.members.find(m=>m.kind==='human'&&m.identity&&identityKey(m.identity)===identityKey({...c.binding!,id:operator.id}));
        const human={id:operator.id,name:known?.name||operator.name};
        if(!result.members.some(m=>m.id===human.id))result.members.push(human);
        return {...result,operators:personas.map(m=>({personaId:m.personaId,name:m.name,human,channel:c.binding!.channel,account:c.binding!.account}))};
    }
    private checkNames(owner:string,org:Organization){
        const agents=this.deps.agents(owner),names=new Map<string,string>();
        const add=(agent:MessageAgent,b:CircleIdentity)=>{const key=JSON.stringify([b.channel,b.account,agent.name.normalize('NFKC').trim().toLowerCase()]);const old=names.get(key);if(old&&old!==agent.id)throw Error('同一消息账号的智能体名称必须唯一');names.set(key,agent.id);};
        for(const a of agents)if(a.messaging?.enabled)for(const b of a.messaging.groups)add(a,b);
        for(const current of [org,...this.organizations(this.root(owner)).filter(o=>o.id!==this.organizationId()).map(o=>o.organization)])for(const c of current.circles)if(c.binding&&!c.archived)for(const m of circleMembers(current,c)){if(m.kind!=='persona')continue;const a=agents.find(a=>a.id===m.personaId);if(!a)throw Error('圈子中有已删除的智能体，请移除其角色分配');add(a,c.binding);}
    }
    private revision(org:Organization,n:number){if(org.revision!==n)throw Error('组织已变化，请刷新后重新预览');}
    private ticket(owner:string,root:string,org:Organization,input:any){const ticket=randomUUID();this.previews.set(ticket,{owner,root,organizationId:this.organizationId(),revision:org.revision,input:structuredClone(input)});if(this.previews.size>100)this.previews.delete(this.previews.keys().next().value!);return ticket;}
    private consume(owner:string,root:string,org:Organization,ticket:string){const p=this.previews.get(ticket);if(!p||p.owner!==owner||p.root!==root||p.organizationId!==this.organizationId())throw Error('请重新预览');this.revision(org,p.revision);this.previews.delete(ticket);return p.input;}
    private async effect(owner:string,root:string,state:State,key:string,fn:()=>Promise<any>,payloadHash='',intent?:any){
        const previous=state.receipts[key];if(previous){if(previous.payloadHash!==payloadHash)throw Error('Request ID was already used for different content');if(previous.status==='done')return previous.value;throw Error('操作结果待核实，未自动重试');}
        state.receipts[key]={status:'unknown',time:Date.now(),payloadHash,...(intent?{intent}: {})};this.save(owner,root,state);
        try{const value=await fn();state.receipts[key]={...state.receipts[key],status:'done',time:Date.now(),value:value??null};this.save(owner,root,state);return value;}
        catch(error){state.receipts[key].error=(error as Error).message;this.save(owner,root,state);throw error;}
    }
    request(owner:string,action:string,input:any):Promise<any>{
        this.owners.add(owner);let root:string;try{root=this.root(owner);}catch(e){return Promise.reject(e);}
        const organizationId=input.organizationId??'default';
        if(organizationId!=='default'&&!/^[a-f0-9]{64}$/.test(organizationId))return Promise.reject(Error('Invalid organization ID'));
        const prior=this.locks.get(root)||Promise.resolve();const task=prior.catch(()=>{}).then(()=>this.organizationContext.run(organizationId,()=>{
            if(organizationId!=='default'&&!fs.existsSync(this.file(root)))throw Error('组织不存在，请重新选择');
            return this.run(owner,root,action,input);
        }));this.locks.set(root,task);
        return task.finally(()=>{if(this.locks.get(root)===task)this.locks.delete(root);});
    }
    private importMembers(org:Organization,c:Circle,s:GroupSnapshot){
        const desired=new Set(s.members.map(m=>m.id));
        const matches=(m:any)=>m.identity&&c.binding&&m.identity.channel===c.binding.channel&&m.identity.account===c.binding.account;
        const keep=(id:string)=>{const m=org.members.find(m=>m.id===id);return !m||!matches(m)||desired.has(m.identity!.id);};
        c.members=c.members.filter(keep);for(const role of c.roles){role.holders=role.holders.filter(keep);if(role.primaryHolder&&!role.holders.includes(role.primaryHolder))role.primaryHolder=null;}
        for(const remote of s.members){let member=org.members.find(m=>matches(m)&&m.identity!.id===remote.id);if(!member){member={id:randomUUID(),kind:'human',name:remote.name,identity:{...c.binding!,id:remote.id}};org.members.push(member);}
            if(!circleMembers(org,c).some(m=>m.id===member!.id))c.members.push(member.id);}
        c.name=s.name;if(s.description!==undefined&&!c.goal.trim()&&!c.roles.length)c.publicDescription=s.description;
    }
    private async discover(owner:string,root:string,org:Organization,state:State){
        // Unassigned X- groups have one deterministic home; other organizations bind explicitly.
        if(this.organizationId()!=='default')return org;
        for(const binding of this.deps.bindings(owner).filter(b=>b.root===root&&b.enabled&&['feishu','dingtalk'].includes(b.channel)&&this.deps.allowed(owner,b.id))){
            const accountKey=JSON.stringify([binding.channel,binding.profile]),status=(state.discovery||={})[accountKey]={lastChecked:Date.now(),error:''};
            try{
                this.guard(owner,root,binding);const account={channel:binding.channel,account:binding.profile,id:'discover'} as CircleIdentity;
                const groups=await this.channel.discover(root,account);this.guard(owner,root,binding);
                for(const group of groups){
                    const b={...account,id:group.id},key=identityKey(b);
                    if(!group.name.startsWith('X-')||state.groups[key]?.ignored||this.boundElsewhere(root,b)||org.circles.some(c=>c.binding&&identityKey(c.binding)===key))continue;
                    const remote=await this.channel.snapshot(root,b);this.guard(owner,root,binding);if(!remote.name.startsWith('X-'))continue;
                    const next=structuredClone(org),c:Circle={id:randomUUID(),parentId:null,name:remote.name,goal:'',publicDescription:'',archived:false,members:[],roles:[],binding:b};
                    next.circles.push(c);this.importMembers(next,c,remote);org=this.write(root,next,org.revision);
                    state.groups[key]={base:remote,lastSynced:Date.now(),discovered:true};this.save(owner,root,state);
                }
            }catch(error){status.error=(error as Error).message;}
            this.save(owner,root,state);
        }return org;
    }
    private async sync(owner:string,root:string,org:Organization,c:Circle,state:State,resolutions?:Record<string,'local'|'remote'>){
        if(!c.binding||c.archived)return org;const original=JSON.stringify(org),binding=this.binding(owner,root,c.binding),key=identityKey(c.binding),record=state.groups[key]||={};
        const remote=await this.channel.snapshot(root,c.binding);this.guard(owner,root,binding);
        const local=await this.projectedGroup(owner,root,org,c),base:GroupSnapshot=record.base||remote,result=reconcile(base,local,remote);
        record.operators=local.operators.map(o=>({...o,present:remote.members.some(m=>m.id===o.human.id)}));
        const removals:string[]=[];
        const fingerprint=hash(JSON.stringify(result.conflicts));if(resolutions&&record.conflictFingerprint!==fingerprint)throw Error('冲突内容已变化，请刷新后重新选择');if(record.conflictFingerprint!==fingerprint)record.decisions={};record.conflictFingerprint=fingerprint;record.decisions={...(record.decisions||{}),...(resolutions||{})};resolutions=record.decisions;
        for(const conflict of result.conflicts){const choice=resolutions?.[conflict.field];if(!choice)continue;const selected=conflict[choice];
            if(conflict.field.startsWith('member:')){const id=conflict.field.slice(7);result.merged.members=result.merged.members.filter(m=>m.id!==id);if(selected)result.merged.members.push(selected);else removals.push(id);}
            else (result.merged as any)[conflict.field]=selected;
        }
        record.conflicts=result.conflicts.filter(x=>!resolutions?.[x.field]);record.lastChecked=Date.now();record.descriptionSupported=remote.description!==undefined;
        if(record.conflicts.length){this.save(owner,root,state);return org;}
        const desired={...result.merged,...(remote.description===undefined?{description:undefined}:{})};
        this.guard(owner,root,binding);this.revision(this.read(root),org.revision);
        // Refresh and conflict resolution are local-only. Outbound changes need a fresh owner preview.
        this.importMembers(org,c,{...desired,...(remote.description===undefined?{description:c.publicDescription}:{})});
        if(JSON.stringify(org)!==original)org=this.write(root,org,org.revision);record.base=remote;record.pendingPublish=groupVersion(remote)!==groupVersion({...await this.projectedGroup(owner,root,org,c),...(remote.description===undefined?{description:undefined}:{})});record.lastSynced=Date.now();record.error='';this.save(owner,root,state);return org;
    }
    private async catchup(owner:string,root:string,c:Circle,state:State){
        if(!c.binding)return;const binding=this.binding(owner,root,c.binding),record=state.groups[identityKey(c.binding)]||={};
        const known=new Map<string,CircleMessage>((record.messages||[]).map((m:CircleMessage)=>[m.id,m]));const priorIds=new Set(known.keys()),resuming=!!record.catchupCursor;let cursor=record.catchupCursor||'',incomplete=false,finished=false;const cursors=new Set<string>();
        for(let page=0;page<5;page++){
            const result=await this.channel.history(root,c.binding,cursor);this.guard(owner,root,binding);
            const overlaps=!resuming&&result.messages.some(m=>priorIds.has(m.id));result.messages.forEach(m=>known.set(m.id,m));
            incomplete=result.incomplete;cursor=result.cursor;
            if(!cursor||overlaps){finished=true;break;}if(cursors.has(cursor))throw Error('Repeated history cursor');cursors.add(cursor);if(page===4)incomplete=true;
        }
        record.messages=[...known.values()].sort((a,b)=>a.time-b.time).slice(-10000);record.catchupCursor=finished?'':cursor;record.incomplete=incomplete;record.lastMessagesAt=Date.now();this.save(owner,root,state);
    }
    private async run(owner:string,root:string,action:string,input:any):Promise<any>{
        this.guard(owner,root);const scope=this.scope(owner,root);
        if(input.expectedScope!==undefined&&input.expectedScope!==scope)throw Error('第二大脑已切换，请重新读取圈子');
        let org=this.read(root);const state=this.state(owner,root);
        const snapshot=async()=>{const labels=await Promise.all(this.deps.bindings(owner).filter(b=>b.root===root).map(async b=>({account:b.profile,channel:b.channel,...await this.channel.accountLabel?.(root,{channel:b.channel as CircleIdentity['channel'],account:b.profile,id:'label'})})));this.guard(owner,root);return ({scope,organizationId:this.organizationId(),organizations:this.organizations(root).map(o=>({id:o.id,name:o.organization.name})),organization:org,agents:this.deps.agents(owner).map(p=>({id:p.id,name:p.name})),channels:this.deps.bindings(owner).filter(b=>b.root===root).map(b=>({channel:b.channel,account:b.profile,...labels.find(l=>l.account===b.profile&&l.channel===b.channel),enabled:b.enabled,available:this.deps.allowed(owner,b.id)})),memberSync:org.im?state.memberSync?.[JSON.stringify(org.im)]||null:null,sync:Object.fromEntries(Object.entries(state.groups).filter(([key])=>org.circles.some(c=>c.binding&&identityKey(c.binding)===key))),receipts:state.receipts,discovery:state.discovery||{}});};
        if(action==='read')return snapshot();
        if(action==='createOrganization'){
            this.revision(org,input.expectedRevision);
            if(typeof input.name!=='string'||!input.name.trim()||input.name.trim().length>80||!/^[-\w]{1,80}$/.test(input.requestId||''))throw Error('Invalid organization name or request ID');
            const id=hash(owner+'\0'+input.requestId),name=input.name.trim();
            return this.organizationContext.run(id,()=>{
                if(fs.existsSync(this.file(root))){if(this.read(root).name!==name)throw Error('Request ID was already used for different content');}
                else this.write(root,{...emptyOrganization(),name},0);
                return this.run(owner,root,'read',{});
            });
        }
        if(action==='preview'){
            this.revision(org,input.expectedRevision);const next=organization({...input.organization,revision:org.revision});if(next.im)this.binding(owner,root,{...next.im,id:'organization'});
            for(const c of org.circles){const changed=next.circles.find(n=>n.id===c.id);if(c.binding&&(!changed?.binding||identityKey(c.binding)!==identityKey(changed.binding)))throw Error('请通过解绑操作解除群关联');}
            for(const c of next.circles)if(c.binding&&!org.circles.some(o=>o.id===c.id&&o.binding&&identityKey(o.binding)===identityKey(c.binding!)))throw Error('请通过部署操作绑定群');
            const agents=this.deps.agents(owner);for(const m of next.members)if(m.kind==='persona'&&!agents.some(a=>a.id===m.personaId)&&!org.members.some(old=>old.id===m.id&&old.personaId===m.personaId))throw Error('Unknown persona');this.checkNames(owner,next);
            return {ticket:this.ticket(owner,root,org,next),before:org,after:next};
        }
        if(action==='apply'){
            let next=this.consume(owner,root,org,input.ticket);
            if(next.kind==='members'){
                this.binding(owner,root,{...next.organization.im,id:'organization'});
                org=this.write(root,next.organization,org.revision);(state.memberSync||={})[JSON.stringify(org.im)]={lastSynced:Date.now(),count:next.count,groups:next.groups,source:next.source,limit:next.limit,limited:next.limited};this.save(owner,root,state);return snapshot();
            }
            if(next.kind==='pull'){
                const bound=this.binding(owner,root,next.binding),actual=await this.channel.snapshot(root,next.binding);this.guard(owner,root,bound);
                if(groupVersion(actual)!==groupVersion(next.remote))throw Error('群资料已变化，请重新从群预览');
                const projected=await this.projectedGroup(owner,root,next.organization,this.circle(next.organization,next.circleId));
                const record=state.groups[identityKey(next.binding)]||={};record.base=actual;record.conflicts=[];record.decisions={};record.lastSynced=Date.now();
                record.operators=projected.operators.map(o=>({...o,present:actual.members.some(m=>m.id===o.human.id)}));record.pendingPublish=groupVersion(actual)!==groupVersion(projected);
                next=next.organization;org=this.write(root,next,org.revision);this.save(owner,root,state);return snapshot();
            }
            org=this.write(root,next,org.revision);return snapshot();
        }
        if(action==='membersPreview'){
            this.revision(org,input.expectedRevision);if(!org.im)throw Error('请先配置组织 IM 平台与账号');
            const account={...org.im,id:'organization'},binding=this.binding(owner,root,account);
            const result=await this.channel.directory(root,account,()=>this.guard(owner,root,binding));this.guard(owner,root,binding);
            const next=structuredClone(org);
            for(const remote of result.members){const identity={...org.im,id:remote.id};const existing=next.members.find(m=>m.kind==='human'&&m.identity&&identityKey(m.identity)===identityKey(identity));if(existing)existing.name=remote.name;else next.members.push({id:randomUUID(),kind:'human',name:remote.name,identity});}
            const normalized=organization(next);
            return {ticket:this.ticket(owner,root,org,{kind:'members',organization:normalized,count:result.members.length,groups:result.groups,source:result.source,limit:result.limit,limited:result.limited}),before:org,after:normalized,memberSync:{count:result.members.length,groups:result.groups,source:result.source,limit:result.limit,limited:result.limited}};
        }
        if(action==='search'){const b={channel:input.channel,account:input.account,id:'search'} as CircleIdentity;this.binding(owner,root,b);return {items:await this.channel.search(root,b,String(input.query||'').slice(0,64),input.contacts===true)};}
        if(action==='refresh'){org=await this.discover(owner,root,org,state);for(const row of [...org.circles]){const c=this.circle(org,row.id);if(!c.binding||c.archived)continue;try{org=await this.sync(owner,root,org,c,state);await this.catchup(owner,root,c,state);}catch(e){const key=identityKey(c.binding);(state.groups[key]||={}).error=(e as Error).message;this.save(owner,root,state);}}return snapshot();}
        const c=this.circle(org,input.circleId);
        if(action==='deployPreview'){
            this.revision(org,input.expectedRevision);if(c.archived||c.binding)throw Error('Circle is archived or already bound');
            if(org.im&&(org.im.channel!==input.channel||org.im.account!==input.account))throw Error('请选择组织配置的 IM 账号');if(c.platform&&c.platform!==input.channel)throw Error('请选择圈子指定的平台');
            const b={channel:input.channel,account:input.account,id:input.groupId||'new'} as CircleIdentity;this.binding(owner,root,b);if(input.groupId&&this.boundElsewhere(root,b))throw Error('此群已绑定其他组织的圈子');await this.channel.verify(root,b);
            const temp={...c,binding:b};this.checkNames(owner,{...org,circles:org.circles.map(x=>x.id===c.id?temp:x)});const members=circleMembers(org,c),humans=members.filter(m=>m.kind==='human');
            if(humans.some(m=>!m.identity||m.identity.channel!==b.channel||m.identity.account!==b.account))throw Error('请为所有真人选择目标渠道的联系人');
            const target=input.groupId?await this.channel.snapshot(root,b):null;
            const desired=await this.projectedGroup(owner,root,org,temp);if(!input.groupId&&!desired.name.startsWith('X-'))desired.name='X-'+desired.name;
            validateGroupDescription(b,desired);
            if(!input.groupId)await this.channel.create(root,b,desired,input.type,()=>this.guard(owner,root),true);
            const payload={kind:'deploy',circleId:c.id,binding:b,create:!input.groupId,type:input.type==='EXTERNAL'?'EXTERNAL':'INTERNAL',desired};
            return {ticket:this.ticket(owner,root,org,payload),...payload,target,personas:members.filter(m=>m.kind==='persona'),operators:desired.operators};
        }
        if(action==='deploy'){
            const p=this.consume(owner,root,org,input.ticket);if(p.kind!=='deploy'||p.circleId!==c.id||c.binding||c.archived)throw Error('Preview does not match circle');const binding=this.binding(owner,root,p.binding);
            const key='deploy:'+c.id+':'+hash(JSON.stringify(p));
            if(p.create&&Object.entries(state.receipts).some(([k,r])=>k.startsWith('deploy:'+c.id+':')&&r.status==='unknown'))throw Error('建群结果待核实，请先查找并绑定已经创建的群');
            if(p.create)p.binding.id=await this.effect(owner,root,state,key,()=>this.channel.create(root,p.binding,p.desired,p.type,()=>{this.guard(owner,root,binding);this.revision(this.read(root),org.revision);}));
            this.guard(owner,root,binding);if(this.boundElsewhere(root,p.binding))throw Error('此群已绑定其他组织的圈子');c.binding=p.binding;c.platform=p.binding.channel;if(p.create)c.name=p.desired.name;org=this.write(root,org,org.revision);
            if(p.create)await this.channel.requireOwner(root,c.binding!);
            const remote=await this.channel.snapshot(root,c.binding!);this.guard(owner,root,binding);
            if(!p.create){const bound=this.circle(org,c.id);this.importMembers(org,bound,{...remote,name:bound.name,description:bound.publicDescription,members:[...remote.members,...p.desired.members.filter((m:any)=>!remote.members.some(r=>r.id===m.id))]});org=this.write(root,org,org.revision);}
            (state.groups[identityKey(c.binding!)]||={}).base=remote;this.save(owner,root,state);
            if(p.create&&c.binding!.channel==='dingtalk'&&remote.description!==p.desired.description){
                const operation='publish:'+identityKey(c.binding!)+':initial-goal';
                const intent={kind:'publish',circleId:c.id,binding:c.binding,remote,desired:p.desired,remove:[]};
                await this.effect(owner,root,state,operation,async()=>{await this.channel.update(root,c.binding!,p.desired,remote,[],()=>{this.guard(owner,root,binding);this.revision(this.read(root),org.revision);});const verified=await this.channel.snapshot(root,c.binding!);this.guard(owner,root,binding);if(groupVersion(verified)!==groupVersion(p.desired))throw Error('X:goal 公告结果待核实');},hash(JSON.stringify(intent)),intent);
            }
            if(!p.create){for(const [key,receipt] of Object.entries(state.receipts))if(key.startsWith('deploy:'+c.id+':')&&receipt.status==='unknown'){receipt.status='linked';receipt.linkedGroup={...c.binding};receipt.verifiedAt=Date.now();}this.save(owner,root,state);}
            org=await this.sync(owner,root,org,this.circle(org,c.id),state);return snapshot();
        }
        if(action==='unbind'){this.revision(org,input.expectedRevision);if(input.confirm!==true)throw Error('请确认解绑，外部群将保留');if(c.binding){(state.groups[identityKey(c.binding)]||={}).ignored=true;this.save(owner,root,state);}delete c.binding;org=this.write(root,org,org.revision);return snapshot();}
        if(!c.binding||c.archived)throw Error('请选择已部署的活动圈子');const binding=this.binding(owner,root,c.binding),key=identityKey(c.binding),record=state.groups[key]||={};
        if(action==='verifyReceipt'){
            const receipt=state.receipts[input.receiptId];
            if(!receipt||receipt.status!=='unknown'||receipt.intent?.kind!=='publish'||identityKey(receipt.intent.binding)!==key)throw Error('此回执无法通过当前群核实');
            const actual=await this.channel.snapshot(root,c.binding);this.guard(owner,root,binding);this.revision(this.read(root),org.revision);
            const complete=groupVersion(actual)===groupVersion(receipt.intent.desired);
            receipt.status=complete?'done':'reviewed';receipt.value=complete?null:undefined;receipt.verifiedAt=Date.now();receipt.observed=actual;
            record.pendingPublish=groupVersion(actual)!==groupVersion({...await this.projectedGroup(owner,root,org,c),...(actual.description===undefined?{description:undefined}:{})});
            if(complete){record.base=actual;record.lastSynced=Date.now();if(!record.pendingPublish){record.conflicts=[];record.decisions={};}}
            this.save(owner,root,state);
            return {status:receipt.status,expected:receipt.intent.desired,actual,snapshot:await snapshot()};
        }
        if(action==='pullPreview'){
            this.revision(org,input.expectedRevision);
            const remote=await this.channel.snapshot(root,c.binding);this.guard(owner,root,binding);
            const next=structuredClone(org),target=this.circle(next,c.id);
            this.importMembers(next,target,remote);
            if(remote.description!==undefined)importCircleDescription(next,target,remote.description,randomUUID);
            const normalized=organization(next);this.checkNames(owner,normalized);
            return {ticket:this.ticket(owner,root,org,{kind:'pull',organization:normalized,circleId:c.id,binding:c.binding,remote}),before:org,after:normalized,source:{binding:c.binding,snapshot:remote}};
        }
        if(action==='publishPreview'){
            this.revision(org,input.expectedRevision);await this.channel.requireOwner(root,c.binding);
            const remote=await this.channel.snapshot(root,c.binding);this.guard(owner,root,binding);
            const humans=circleMembers(org,c).filter(m=>m.kind==='human');
            if(humans.some(m=>!m.identity||m.identity.channel!==c.binding!.channel||m.identity.account!==c.binding!.account))throw Error('请为所有真人选择目标渠道的联系人');
            const desired=await this.projectedGroup(owner,root,org,c);if(remote.description===undefined)delete desired.description;
            validateGroupDescription(c.binding!,desired);
            const payload={kind:'publish',circleId:c.id,binding:c.binding,remote,desired,remove:remote.members.filter(m=>!desired.members.some(d=>d.id===m.id)).map(m=>m.id)};
            return {ticket:this.ticket(owner,root,org,payload),...payload};
        }
        if(action==='publish'){
            if(!/^[-\w]{1,50}$/.test(input.requestId||''))throw Error('Invalid request ID');
            const p=this.consume(owner,root,org,input.ticket);if(p.kind!=='publish'||p.circleId!==c.id||identityKey(p.binding)!==key)throw Error('Preview does not match circle');
            await this.channel.requireOwner(root,c.binding);const remote=await this.channel.snapshot(root,c.binding);
            this.guard(owner,root,binding);if(groupVersion(remote)!==groupVersion(p.remote))throw Error('群已变化，请刷新后重新预览');
            const operation='publish:'+key+':'+input.requestId;
            if(Object.entries(state.receipts).some(([k,r])=>k.startsWith('publish:'+key+':')&&r.status==='unknown'))throw Error('操作结果待核实，请先在平台核实已完成步骤');
            await this.effect(owner,root,state,operation,async()=>{
                await this.channel.update(root,c.binding!,p.desired,remote,p.remove,()=>{this.guard(owner,root,binding);this.revision(this.read(root),org.revision);});
                const verified=await this.channel.snapshot(root,c.binding!);this.guard(owner,root,binding);
                if(groupVersion(verified)!==groupVersion(p.desired))throw Error('群更新部分完成，请刷新核实');
                record.base=verified;record.pendingPublish=false;record.conflicts=[];record.decisions={};record.lastSynced=Date.now();
                for(const [priorKey,prior] of Object.entries(state.receipts))if(priorKey.startsWith('publish:'+key+':')&&prior.status==='reviewed'){prior.status='superseded';prior.resolvedBy=operation;}
            },hash(JSON.stringify(p)),{kind:'publish',binding:{...c.binding},desired:p.desired});
            this.save(owner,root,state);return snapshot();
        }
        if(action==='resolve'){this.revision(org,input.expectedRevision);org=await this.sync(owner,root,org,c,state,input.resolutions);return snapshot();}
        if(action==='history'){
            const page=await this.channel.history(root,c.binding,String(input.cursor||''));this.guard(owner,root,binding);
            const messages=new Map<string,CircleMessage>((record.messages||[]).map((m:CircleMessage)=>[m.id,m]));for(const m of page.messages)messages.set(m.id,m);
            record.messages=[...messages.values()].sort((a,b)=>a.time-b.time).slice(-10000);record.cursor=page.cursor;record.incomplete=page.incomplete;record.lastMessagesAt=Date.now();this.save(owner,root,state);return page;
        }
        if(action==='send'){
            if(typeof input.text!=='string'||!input.text.trim()||input.text.length>16000||!/^[-\w]{1,50}$/.test(input.requestId))throw Error('Invalid message');
            const reply=input.replyId?(record.messages||[]).find((m:CircleMessage)=>m.id===input.replyId):undefined;if(input.replyId&&!reply)throw Error('请先加载被回复消息');
            this.guard(owner,root,binding);this.revision(this.read(root),org.revision);this.deps.pause(owner,binding.id,c.binding.id);
            await this.effect(owner,root,state,'send:'+key+':'+input.requestId,()=>this.channel.send(root,c.binding!,input.requestId,input.text,reply,()=>{this.guard(owner,root,binding);this.revision(this.read(root),org.revision);}),hash(JSON.stringify([input.text,input.replyId||''])));return {status:'sent'};
        }
        throw Error('Unknown circles action');
    }
    assignments(agent:MessageAgent){try{if(this.root(agent.owner)!==agent.root)return [];return this.organizations(agent.root).flatMap(({id,organization:org})=>this.organizationContext.run(id,()=>{const state=this.state(agent.owner,agent.root);return org.circles.filter(c=>c.binding&&!c.archived&&circleMembers(org,c).some(m=>m.personaId===agent.id)&&!state.groups[identityKey(c.binding)]?.operators?.some((o:any)=>o.personaId===agent.id&&!o.present)).map(c=>({...c.binding!,name:c.name}));}));}catch{return [];}}
    context(agent:MessageAgent,b:CircleIdentity){try{if(this.root(agent.owner)!==agent.root)return '';return this.organizations(agent.root).map(o=>circleAgentContext(o.organization,agent.id,b)).filter(Boolean).join('\n');}catch{return '';}}
}

