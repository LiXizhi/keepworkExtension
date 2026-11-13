import {randomUUID} from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const JOB_ROLES = ['线索研究员','SDR','客服','客户成功','运营','销售助理','运营分析'] as const;
type JobRecord = {id:string; kind?:string; role?:string; status?:string; version?:number; subject_module?:string; subject_id?:string; payload_json?:string; payload?:Record<string,unknown>; [key:string]:unknown};

export type SalesState = {
    url:string; token:string; crmPersonaId:string; credentialId:string; expiresAt:string;
    role:string; campaignId?:string; objective:string; enabled:boolean; intervalMinutes:number; maxDailyCycles:number;
    next:number; day:string; cycles:number; status:string; lastError?:string; lastRun?:string; lastTask?:string;
    learning:Array<{observation:string; nextAction:string; evidence:string[]; reportId:string}>;
    pending?:{id:string;question:string;recommendation:string;evidence:string[]};
    ownerDecisions?:Array<{id:string;question:string;answer:string}>;
    decision?:{id:string;question:string;answer:string;applied:boolean;feedbackId?:string};
    lastReport?:{id:string;content:string;evidence:string[]};
};

export function salesView(s?:SalesState) {
    if (!s) return null;
    const {token,...view}=s;
    return view;
}

export function salesConfiguration(input:any, previous?:SalesState):SalesState {
    const url=new URL(String(input.url||''));
    if ((url.protocol!=='https:' && !(url.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) ||
        url.username || url.password || url.search || url.hash || !/^[\w/-]*$/.test(url.pathname))
        throw Error('需要 HTTPS CRM 地址或本机测试地址');
    if (!/^kwcrm_[a-f0-9]{64}$/.test(input.token||'')) throw Error('CRM 授权无效');
    for (const key of ['crmPersonaId','credentialId'])
        if (typeof input[key]!=='string' || !/^[\w-]{1,160}$/.test(input[key])) throw Error('CRM 记录标识无效');
    const role=String(input.role||previous?.role||'SDR');
    if (!(JOB_ROLES as readonly string[]).includes(role)) throw Error('销售分身角色无效');
    if (input.campaignId!==undefined && (typeof input.campaignId!=='string' || !/^[\w-]{1,160}$/.test(input.campaignId))) throw Error('CRM 活动标识无效');
    const objective=typeof input.objective==='string'?input.objective.trim():'';
    if (!objective || objective.length>4000) throw Error('销售目标需要 1–4000 字');
    const intervalMinutes=input.intervalMinutes ?? 30, maxDailyCycles=input.maxDailyCycles ?? 24;
    if (!Number.isInteger(intervalMinutes) || intervalMinutes<5 || intervalMinutes>1440 ||
        !Number.isInteger(maxDailyCycles) || maxDailyCycles<1 || maxDailyCycles>96) throw Error('巡查间隔需为5–1440分钟，每日工作轮次需为1–96次');
    if (!Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt)<=Date.now()) throw Error('CRM 授权已过期');
    const same=previous?.role===role && previous?.url===url.href.replace(/\/$/,'') && previous?.crmPersonaId===input.crmPersonaId;
    return {url:url.href.replace(/\/$/,''),token:input.token,crmPersonaId:input.crmPersonaId,
        credentialId:input.credentialId,expiresAt:input.expiresAt,role,campaignId:input.campaignId||previous?.campaignId,objective,
        enabled:true,intervalMinutes,maxDailyCycles,next:Date.now(),day:previous?.day||'',cycles:previous?.cycles||0,
        status:'待巡查',learning:same?previous!.learning:[],
        ...(same?{ownerDecisions:previous!.ownerDecisions,lastTask:previous!.lastTask,pending:previous!.pending,decision:previous!.decision,lastReport:previous!.lastReport}:{})};
}

export async function salesRequest(s:SalesState,args:any,signal?:AbortSignal) {
    if (!args || !['GET','POST','PATCH'].includes(args.method) || typeof args.path!=='string' ||
        !/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(args.path) || args.personaId!==undefined)
        throw Error('CRM 请求参数无效');
    if (args.method!=='GET' && (typeof args.idempotencyKey!=='string' || !/^[\w:.-]{1,100}$/.test(args.idempotencyKey)))
        throw Error('写入需要预先保存的稳定幂等键');
    const request=args.path==='/catalog' && args.method==='GET'
        ? {requestId:randomUUID(),command:'crm_catalog',args:{}}
        : {requestId:randomUUID(),command:'crm_request',args};
    const response=await fetch(s.url+'/api/v1/ai-tool',{method:'POST',headers:{
        'Content-Type':'application/json',Authorization:'Bearer '+s.token,
    },body:JSON.stringify(request),redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(25000),...(signal?[signal]:[])])});
    const content=await response.text();
    if (content.length>150000) throw Error('CRM 回执过大，请缩小查询范围');
    let receipt:any;
    try {receipt=JSON.parse(content);} catch {throw Error('CRM 未返回有效回执');}
    if (!response.ok || receipt.ok!==true) throw Object.assign(Error('CRM 请求未成功（HTTP '+response.status+'），请核对记录与授权'),{status:response.status});
    return receipt.result;
}

export async function salesCommand(s:SalesState,command:string,args:Record<string,unknown>,signal?:AbortSignal) {
    const response=await fetch(s.url+'/api/v1/ai-tool',{method:'POST',headers:{
        'Content-Type':'application/json',Authorization:'Bearer '+s.token,
    },body:JSON.stringify({requestId:randomUUID(),command,args}),redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(25000),...(signal?[signal]:[])])});
    const content=await response.text();
    if (content.length>150000) throw Error('CRM 回执过大，请缩小查询范围');
    let receipt:any;
    try {receipt=JSON.parse(content);} catch {throw Error('CRM 未返回有效回执');}
    if (!response.ok || receipt.ok!==true) throw Object.assign(Error('CRM 请求未成功（HTTP '+response.status+'），请核对记录与授权'),{status:response.status});
    return receipt.result ?? receipt;
}

export async function verifySalesConnection(s:SalesState) {
    const response=await fetch(s.url+'/api/v1/me',{headers:{Authorization:'Bearer '+s.token},redirect:'error',signal:AbortSignal.timeout(15000)});
    if (!response.ok) throw Error('CRM 授权验证失败');
    const me=await response.json() as any;
    if (me.user?.agent?.id!==s.crmPersonaId) throw Error('CRM 分身身份不匹配');
    for (const grant of ['agent-jobs:read','agent-jobs:write'])
        if (!me.user.agent.permissions.includes(grant)) throw Error('销售分身缺少授权：'+grant);
}

export const salesTools = [
    ['crm_request','读取当前 CRM 作业或作业关联的客户、线索和咨询。只能读取本轮领取的作业范围。',{method:{type:'string',enum:['GET']},path:{type:'string'}}],
    ['sales_report','完成当前 CRM 作业并报告已核对的结果。对外消息需要同时提供正文和审批内容，CRM 会创建消息和审批记录。',{content:{type:'string'},evidence:{type:'array',items:{type:'string'}},body:{type:'string'},channel:{type:'string'},customerId:{type:'string'},leadId:{type:'string'}}],
    ['sales_learn','保存一条有证据的本地复盘，供后续作业参考；不会改变 CRM 权限或作业状态。',{observation:{type:'string'},nextAction:{type:'string'},evidence:{type:'array',items:{type:'string'}}}],
    ['sales_ask_human','把当前作业交给人工。若需要审核对外消息，提供 body；CRM 会创建待审批消息，否则作业标记为结果未知。',{question:{type:'string'},recommendation:{type:'string'},evidence:{type:'array',items:{type:'string'}},body:{type:'string'},channel:{type:'string'},customerId:{type:'string'},leadId:{type:'string'}}],
].map(([name,description,properties])=>({type:'function',function:{name,description,parameters:{type:'object',properties}}}));

export function salesSkillContext(root:string,prompt:string){
    const heading='\n\n【已配置技能 · AIChat】\n',at=prompt.lastIndexOf(heading);
    if(at<0)return '';
    let skills:any;try{skills=JSON.parse(prompt.slice(at+heading.length));}catch{return '';}
    if(!Array.isArray(skills))return '';
    const blocks:string[]=[];
    for(const skill of skills.slice(0,24)){
        if(!/^[\w-]{1,80}$/.test(skill?.name)||skill.instructions!=='执行时读取当前第二大脑中的 .github/skills/'+skill.name+'/SKILL.md 并按该技能办理。')continue;
        if(!root)throw Error('无法读取已绑定的第二大脑技能：'+skill.name);
        const base=fs.realpathSync(root),file=path.join(base,'.github','skills',skill.name,'SKILL.md');
        if(fs.realpathSync(file)!==file||!fs.statSync(file).isFile()||fs.statSync(file).size>64000)throw Error('绑定技能路径无效或过大：'+skill.name);
        blocks.push(skill.name+'：'+fs.readFileSync(file,'utf8'));
        if(blocks.reduce((sum,b)=>sum+b.length,0)>24000)throw Error('本次绑定技能超过上下文上限，请精简后恢复');
    }
    return blocks.join('\n');
}

export const salesInstructions = '你是一名持续工作的 CRM 作业执行分身。先读取本轮领取的作业和关联记录，按作业目标处理，最后必须用 sales_report 或 sales_ask_human 提交真实回执。'
    +'作业外的客户、线索、消息和权限不可读取；不要猜测记录编号、发送状态或审批结果。需要对外消息时只提交正文和依据，由 CRM 创建消息并进入审批或自动策略。'
    +'sales_learn 只能保存有证据的复盘，不能替代作业完成。遇到403、版本冲突、超时或结果未知先停止并报告，不能换标识重做。没有待办时结束本轮。';

export class SalesCycle {
    evidence:Set<string>;
    reported=false;
    finishedJob=false;
    private outcome='';
    asked=false;
    readonly job:string;
    readonly task:string;
    constructor(readonly state:SalesState, readonly jobRecord:JobRecord,
        private save:()=>void, private notify:(text:string,id:string)=>void) {
        this.job=String(jobRecord.id);
        this.task=this.job;
        this.evidence=new Set(['/agent-jobs/'+this.job]);
        if(jobRecord.subject_module&&jobRecord.subject_id)this.evidence.add('/'+jobRecord.subject_module+'/'+jobRecord.subject_id);
    }
    private payload() {
        if (this.jobRecord.payload && typeof this.jobRecord.payload==='object') return this.jobRecord.payload;
        try { const parsed=JSON.parse(String(this.jobRecord.payload_json||'{}')); return parsed && typeof parsed==='object' ? parsed : {}; } catch { return {}; }
    }
    private subjectPath(pathValue:string) {
        const module=String(this.jobRecord.subject_module||''), id=String(this.jobRecord.subject_id||'');
        if(!module||!id)return false;
        const base='/'+module+'/'+id;
        return pathValue===base || pathValue.startsWith(base+'/');
    }
    private check(signal:AbortSignal) { if(signal.aborted || !this.state.enabled || Date.parse(this.state.expiresAt)<=Date.now())throw Error('销售工作已停止或授权已过期'); }
    async tool(name:string,a:any,signal:AbortSignal) {
        const s=this.state;this.check(signal);
        if(name==='crm_request'){
            if(a?.method!=='GET'||typeof a.path!=='string'||!(a.path==='/agent-jobs/'+this.job||this.subjectPath(a.path)))throw Error('本轮只允许读取当前作业及其关联记录');
            const result=await salesRequest(s,{method:'GET',path:a.path},signal);this.evidence.add(a.path);return result;
        }
        const evidence:string[]=Array.isArray(a?.evidence)?[...new Set<string>(a.evidence)]:[];
        if(!evidence.length||evidence.length>12||evidence.some(e=>!this.evidence.has(e)))throw Error('请引用本轮已核对的 CRM 路径');
        const field=(key:string)=>{if(typeof a?.[key]!=='string'||!a[key].trim()||a[key].length>2400)throw Error('需要简明的'+key);return a[key].trim();};
        if(name==='sales_learn'){
            const observation=field('observation'),nextAction=field('nextAction');
            const reportId='learning-'+randomUUID();s.learning=[...s.learning,{observation,nextAction,evidence,reportId}].slice(-12);this.save();this.notify('已保存复盘：'+observation,reportId);return {id:reportId,status:'已保存'};
        }
        if(name!=='sales_report'&&name!=='sales_ask_human')throw Error('本轮未提供该工具');
        const question=name==='sales_ask_human'?field('question'):'';
        const content=name==='sales_report'?field('content'):question+'\n建议：'+field('recommendation');
        const body=typeof a?.body==='string'?a.body.trim():'';
        if(body.length>4000)throw Error('对外消息正文不能超过4000字');
        const payload=this.payload();
        const customerId=String(a?.customerId||payload.customer_id||'');
        const leadId=String(a?.leadId||payload.lead_id||'');
        const approval=body?{kind:'outbound_message',conclusion:name==='sales_report'?'作业对外消息':'人工审核对外消息',reason:question||'作业结果需要人工确认',content:{body,text:body,channel:String(a?.channel||payload.channel||'simulated'),customer_id:customerId||undefined,lead_id:leadId||undefined},evidence}:undefined;
        const result={summary:content,evidence,job_kind:this.jobRecord.kind||null,learning:s.learning.slice(-3)};
        const receipt=await salesCommand(s,'finish_job',{id:this.job,result, ...(approval?{approval}:{unknown:!approval&&name==='sales_ask_human'})},signal);
        if(!receipt?.recordId&&!receipt?.record?.id)throw Error('CRM 未返回作业完成回执');
        this.finishedJob=true;this.reported=true;this.asked=name==='sales_ask_human';this.outcome=content;
        const id=String(receipt.approvalId||receipt.recordId||this.job);s.lastReport={id,content,evidence};
        s.status=receipt.pendingApproval?'待 CRM 审批':receipt.status==='人工待办'?'人工待处理':(this.asked?'人工待处理':'待巡查');
        this.save();this.notify((receipt.pendingApproval?'已提交 CRM 审批：':'已完成 CRM 作业：')+content,id);return receipt;
    }
}
