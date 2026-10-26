export type CircleIdentity = {channel:'dingtalk'|'feishu';account:string;id:string};
export type CircleMember = {id:string;name:string;kind:'human'|'persona';personaId?:string;identity?:CircleIdentity};
export type CircleRole = {id:string;name:string;responsibility:string;skills:string[];holders:string[];primaryHolder?:string|null};
export type Circle = {id:string;parentId:string|null;name:string;goal:string;publicDescription:string;archived:boolean;members:string[];roles:CircleRole[];binding?:CircleIdentity;platform?:'dingtalk'|'feishu'};
export type Organization = {version:1;revision:number;name:string;members:CircleMember[];circles:Circle[];im?:{channel:CircleIdentity['channel'];account:string}};
export type GroupSnapshot = {name:string;description?:string;members:{id:string;name:string}[]};
export type CircleConflict = {field:string;kind:'concurrent'|'removal';local:any;remote:any};
export const emptyOrganization = ():Organization => ({version:1,revision:0,name:'我的组织',members:[],circles:[]});
function text(v:any,max=16000){if(typeof v!=='string'||v.length>max||v.includes('\0'))throw Error('Invalid circle text');return v;}
function id(v:any){if(typeof v!=='string'||!v.trim()||v.length>256||/[\x00-\x1f]/.test(v))throw Error('Invalid stable ID');return v;}
function list(v:any,max=1000):any[]{if(!Array.isArray(v)||v.length>max)throw Error('Invalid circle list');return v;}
function unique(rows:{id:string}[]){if(new Set(rows.map(r=>r.id)).size!==rows.length)throw Error('Duplicate ID');}
export function identity(v:any):CircleIdentity{if(!v||!['dingtalk','feishu'].includes(v.channel))throw Error('Invalid channel');return {channel:v.channel,account:id(v.account),id:id(v.id)};}
export const identityKey=(v:CircleIdentity)=>JSON.stringify([v.channel,v.account,v.id]);
export function organization(value:any):Organization {
    if(value?.version!==1||!Number.isSafeInteger(value.revision)||value.revision<0)throw Error('Unsupported organization version');
    const im=value.im?identity({...value.im,id:'organization'}):null;
    const members:CircleMember[]=list(value.members).map(m=>{
        if(!['human','persona'].includes(m.kind))throw Error('Invalid member kind');
        return {id:id(m.id),name:text(m.name,80),kind:m.kind,...(m.kind==='persona'?{personaId:id(m.personaId)}:m.identity?{identity:identity(m.identity)}:{})};
    });unique(members);
    const identities=new Set<string>();for(const m of members){const key=m.kind==='persona'?'persona:'+m.personaId:m.identity?identityKey(m.identity):'';if(key&&identities.has(key))throw Error('Duplicate member identity');if(key)identities.add(key);}
    const refs=(v:any)=>[...new Set(list(v).map(id))].map(key=>{if(!members.some(m=>m.id===key))throw Error('Unknown member');return key;});
    const circles:Circle[]=list(value.circles,200).map(c=>{
        if(c.platform!==undefined&&!['dingtalk','feishu'].includes(c.platform))throw Error('Invalid circle platform');
        if(c.binding&&c.platform&&c.binding.channel!==c.platform)throw Error('Circle platform does not match binding');
        const roles:CircleRole[]=list(c.roles,100).map(r=>{
            const holders=refs(r.holders),primaryHolder=r.primaryHolder==null?null:id(r.primaryHolder);
            if(primaryHolder&&!holders.includes(primaryHolder))throw Error('Primary owner must be a role holder');
            return {id:id(r.id),name:text(r.name,80),responsibility:text(r.responsibility),skills:list(r.skills,30).map(s=>text(s,256)),holders,...(r.primaryHolder!==undefined?{primaryHolder}:{})};
        });unique(roles);
        return {id:id(c.id),parentId:c.parentId?id(c.parentId):null,name:text(c.name,80),goal:text(c.goal),publicDescription:text(c.publicDescription||'',100),archived:c.archived===true,members:refs(c.members),roles,...(c.platform?{platform:c.platform}:{}),...(c.binding?{binding:identity(c.binding)}:{})};
    });unique(circles);if(circles.some(c=>!c.name.trim()||c.roles.some(r=>!r.name.trim())))throw Error('Circle and role names are required');
    const bindings=new Set<string>();
    for(const c of circles){const seen=new Set([c.id]);let parent=c.parentId;while(parent){if(seen.has(parent))throw Error('Circle nesting cycle');seen.add(parent);const row=circles.find(x=>x.id===parent);if(!row)throw Error('Unknown parent circle');parent=row.parentId;}
        if(c.binding&&!c.archived){const key=identityKey(c.binding);if(bindings.has(key))throw Error('Group already bound to another circle');bindings.add(key);}}
    if(im&&circles.some(c=>(c.platform&&c.platform!==im.channel)||(c.binding&&(c.binding.channel!==im.channel||c.binding.account!==im.account))))throw Error('圈子平台或已绑定账号与组织 IM 不一致，请先处理群绑定');
    return {version:1,revision:value.revision,name:text(value.name,80),members,circles,...(im?{im:{channel:im.channel,account:im.account}}:{})};
}
export function circleMembers(org:Organization,c:Circle){const ids=new Set([...c.members,...c.roles.flatMap(r=>r.holders)]);return org.members.filter(m=>ids.has(m.id));}
/** Public group projection; display names never become identity keys. */
export function circleDescription(org:Organization,c:Circle):string {
    if(!c.goal.trim()&&!c.roles.length)return c.publicDescription;
    const clean=(v:string)=>v.replace(/\s+/g,' ').trim();
    const name=(id:string)=>clean(org.members.find(m=>m.id===id)?.name||id);
    const roles=c.roles.map(r=>`${clean(r.name)}:${r.holders.map(name).join('&')||'待分配'}`);
    const owners=[...new Set(c.roles.map(r=>r.primaryHolder).filter((id):id is string=>!!id))];
    return [`目标：${clean(c.goal)||'待明确'}`,roles.length?`角色：${roles.join('；')}`:'',owners.length?`DRI:${owners.map(name).join('&')}`:''].filter(Boolean).join('\n');
}
export function validateGroupDescription(b:CircleIdentity,s:GroupSnapshot){
    if(b.channel==='feishu'&&[...(s.description||'')].length>100)throw Error('飞书群描述最多 100 字，请缩短圈子目标或角色名称后重新预览');
}
export function circleSnapshot(org:Organization,c:Circle):GroupSnapshot {
    return {name:c.name,description:circleDescription(org,c),members:circleMembers(org,c).filter(m=>m.kind==='human'&&m.identity&&c.binding&&m.identity.channel===c.binding.channel&&m.identity.account===c.binding.account).map(m=>({id:m.identity!.id,name:m.name}))};
}
/** Stable-ID three-way merge. Removing a member is never an automatic action. */
export function reconcile(base:GroupSnapshot,local:GroupSnapshot,remote:GroupSnapshot){
    const merged:GroupSnapshot={name:local.name,members:[]},conflicts:CircleConflict[]=[];
    for(const field of ['name','description'] as const){
        if(field==='description'&&remote.description===undefined){merged.description=local.description;continue;}
        const b=base[field]||'',l=local[field]||'',r=remote[field]||'';
        if(l!==b&&r!==b&&l!==r){conflicts.push({field,kind:'concurrent',local:l,remote:r});merged[field]=l;}else merged[field]=l===b?r:l;
    }
    for(const key of new Set([...base.members,...local.members,...remote.members].map(m=>m.id))){
        const b=base.members.find(m=>m.id===key),l=local.members.find(m=>m.id===key),r=remote.members.find(m=>m.id===key);
        if(b&&(!l||!r)){conflicts.push({field:'member:'+key,kind:'removal',local:l||null,remote:r||null});if(l||r)merged.members.push((l||r)!);}
        else if(l||r)merged.members.push((r||l)!);
    }
    return {merged,conflicts};
}
export function circleAgentContext(org:Organization,personaId:string,binding:CircleIdentity){
    return org.circles.filter(c=>!c.archived&&c.binding&&identityKey(c.binding)===identityKey(binding)&&circleMembers(org,c).some(m=>m.personaId===personaId)).map(c=>{
        const roles=c.roles.filter(r=>r.holders.some(h=>org.members.some(m=>m.id===h&&m.personaId===personaId)));
        return `\n# Circle: ${c.name}\n${c.goal}\n`+roles.map(r=>`${r.name}: ${r.responsibility}\n${r.skills.join('\n')}`).join('\n');
    }).join('\n');
}

/** Explicit pull preview only. Display names must resolve uniquely to existing IDs. */
export function importCircleDescription(org:Organization,c:Circle,description:string,newId:()=>string){
    const lines=description.replace(/\r\n/g,'\n').split('\n').filter(s=>s.trim());
    if(!lines.length)return;
    if(!lines.every(s=>/^(目标[：:]|角色[：:]|DRI[：:])/.test(s)))throw Error('群资料格式无法解析，请使用目标、角色、DRI 三行格式');
    const value=(key:string)=>{const matches=lines.filter(s=>new RegExp('^'+key+'[：:]').test(s));if(matches.length>1)throw Error('群资料包含重复字段');return matches[0]?.replace(new RegExp('^'+key+'[：:]'),'').trim();};
    const resolve=(name:string)=>{const matches=org.members.filter(m=>m.name===name.trim());if(matches.length!==1)throw Error('成员名称无法唯一匹配：'+name+'；请先明确关联成员身份');return matches[0].id;};
    const goal=value('目标'),roles=value('角色'),dri=value('DRI');if(goal!==undefined)c.goal=goal==='待明确'?'':goal;
    if(roles!==undefined){const names=new Set<string>();c.roles=roles?roles.split(/[；;]/).map(entry=>{
        const match=entry.match(/^([^:：]+)[:：](.*)$/);if(!match||names.has(match[1].trim()))throw Error('角色格式不明确或角色名称重复');
        const name=match[1].trim();names.add(name);const existing=c.roles.filter(r=>r.name===name);if(existing.length>1)throw Error('本地角色名称重复，请先明确角色');
        const holders=match[2].trim()==='待分配'||!match[2].trim()?[]:[...new Set(match[2].split('&').map(resolve))];
        const r=existing[0];return {...(r||{id:newId(),responsibility:'',skills:[]}),name,holders,primaryHolder:r?.primaryHolder&&holders.includes(r.primaryHolder)?r.primaryHolder:null};
    }):[];}
    if(dri!==undefined){const owners=dri?[...new Set(dri.split('&').map(resolve))]:[];const assigned=new Set<string>();
        for(const r of c.roles){const candidates=owners.filter(id=>r.holders.includes(id));if(candidates.length>1){if(r.primaryHolder&&candidates.includes(r.primaryHolder))assigned.add(r.primaryHolder);else throw Error('角色有多位 DRI 候选，请先明确主要负责人：'+r.name);}else{r.primaryHolder=candidates[0]||null;if(r.primaryHolder)assigned.add(r.primaryHolder);}}
        for(const owner of owners.filter(id=>!assigned.has(id))){if(c.roles.some(r=>r.name==='DRI'))throw Error('DRI 角色已存在，请明确其主要负责人');c.roles.push({id:newId(),name:'DRI',responsibility:'',skills:[],holders:[owner],primaryHolder:owner});}
    }
}
