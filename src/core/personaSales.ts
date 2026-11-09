import {randomUUID} from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type SalesState = {
    url:string; token:string; crmPersonaId:string; credentialId:string; expiresAt:string;
    campaignId:string; objective:string; enabled:boolean; intervalMinutes:number; maxDailyCycles:number;
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
    for (const key of ['crmPersonaId','credentialId','campaignId'])
        if (typeof input[key]!=='string' || !/^[\w-]{1,160}$/.test(input[key])) throw Error('CRM 记录标识无效');
    const objective=typeof input.objective==='string'?input.objective.trim():'';
    if (!objective || objective.length>4000) throw Error('销售目标需要 1–4000 字');
    const intervalMinutes=input.intervalMinutes ?? 30, maxDailyCycles=input.maxDailyCycles ?? 24;
    if (!Number.isInteger(intervalMinutes) || intervalMinutes<5 || intervalMinutes>1440 ||
        !Number.isInteger(maxDailyCycles) || maxDailyCycles<1 || maxDailyCycles>96) throw Error('巡查间隔需为5–1440分钟，每日工作轮次需为1–96次');
    if (!Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt)<=Date.now()) throw Error('CRM 授权已过期');
    const same=previous?.campaignId===input.campaignId && previous?.url===url.href.replace(/\/$/,'') && previous?.crmPersonaId===input.crmPersonaId;
    return {url:url.href.replace(/\/$/,''),token:input.token,crmPersonaId:input.crmPersonaId,
        credentialId:input.credentialId,expiresAt:input.expiresAt,campaignId:input.campaignId,objective,
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

export async function verifySalesConnection(s:SalesState) {
    const response=await fetch(s.url+'/api/v1/me',{headers:{Authorization:'Bearer '+s.token},redirect:'error',signal:AbortSignal.timeout(15000)});
    if (!response.ok) throw Error('CRM 授权验证失败');
    const me=await response.json() as any;
    if (me.user?.agent?.id!==s.crmPersonaId) throw Error('CRM 分身身份不匹配');
    for (const grant of ['marketing-campaigns:read','marketing-tasks:read','sales-reports:read','sales-reports:write'])
        if (!me.user.agent.permissions.includes(grant)) throw Error('销售分身缺少授权：'+grant);
    const campaign=await salesRequest(s,{method:'GET',path:'/marketing-campaigns/'+s.campaignId});
    if (campaign.status!=='启用') throw Error('营销活动未启用');
}

export const salesTools = [
    ['crm_request','Read and act on this sales persona’s CRM. Only the bound campaign and its tasks/reports are available. Read current version, the daemon assigns a stable idempotency key per task action. Verify actual receipts.',{
        method:{type:'string',enum:['GET','POST']},path:{type:'string'},query:{type:'object'},data:{type:'object'},idempotencyKey:{type:'string'},
    }],
    ['sales_report','Report verified progress to the owner and CRM. Evidence must be paths successfully read or written in this cycle.',{
        content:{type:'string'},evidence:{type:'array',items:{type:'string'}},
    }],
    ['sales_learn','Save a small improvement for later cycles with observed evidence. Does not change objective, grants, budget or owner-authored skills.',{
        observation:{type:'string'},nextAction:{type:'string'},evidence:{type:'array',items:{type:'string'}},
    }],
    ['sales_ask_human','Pause for a human decision in AIChat. Explain the decision, recommendation, and supporting CRM evidence. Continue only after the actual owner response.',{
        question:{type:'string'},recommendation:{type:'string'},evidence:{type:'array',items:{type:'string'}},
    }],
].map(([name,description,properties])=>({type:'function',function:{name,description,parameters:{type:'object',properties}}}));

// Only owner-bound SKILL.md files are readable during autonomous sales, never general workspace tools.
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

export const salesInstructions = '你是一名持续工作的虚拟销售。先核对当前活动和待办，按真实客户问题的优先级处理，认领任务后再写入结果。'
    +'根据同伴目录的职责用 send_persona_message 协商文案、分析和跟进，同伴的建议需要你核对业务证据。'
    +'每轮按真实回执用 sales_report 汇报结果、下一步和阻碍。有依据的改进用 sales_learn 保存，下轮检验效果，不能把推测写成销量或收入。'
    +'技能、权限、预算、对外承诺和渠道授权由主人决定。需要人类决定时用 sales_ask_human 并等待，拒绝后停止相关动作。'
    +'GET /marketing-campaigns/活动ID 读官方资料，GET /marketing-tasks/任务ID 读要求。内部备稿用 POST /marketing-tasks/任务ID/actions/claim-task（data.version），然后同一路径 actions/submit-campaign-article（data.title、content、认领后的version）。咨询先 GET /marketing-tasks/任务ID/inquiry-history，再认领并 POST 同一任务 actions/answer-inquiry（data.answer、version）。不要为等待人类而提前认领。'
    +'本站咨询可在授权内使用 answer-inquiry；外部平台发布只报告真实回执。403、版本冲突、超时或结果未知先核查，不能换键重做。'
    +'轮询得到无工作时结束本轮，保持安静。只处理配置中的活动，不改授权、不自建定时任务、不修改自身目标和限额。';

/** A model can operate only on the task selected by the daemon this round. */
export class SalesCycle {
    evidence:Set<string>;
    reported=false;
    finishedTask=false;
    private outcome='';
    asked=false;
    constructor(readonly state:SalesState,readonly job:string,readonly channel:string,readonly task:string,
        private save:()=>void, private notify:(text:string,id:string)=>void) {
        this.evidence=new Set(['/marketing-campaigns/'+state.campaignId,...(task?['/marketing-tasks/'+task]:[])]);
    }
    async tool(name:string,a:any,signal:AbortSignal) {
        const s=this.state, base='/marketing-tasks/'+this.task;
        const check=()=>{if(signal.aborted || !s.enabled || s.pending || Date.parse(s.expiresAt)<=Date.now())throw Error('销售工作已停止或待决定');};
        check();
        if(name==='crm_request'){
            const read=a.method==='GET' && (a.path==='/marketing-campaigns/'+s.campaignId || this.task && [base,base+'/inquiry-history'].includes(a.path));
            const write=a.method==='POST' && this.task && ['claim-task','submit-campaign-article','answer-inquiry'].some(action=>a.path===base+'/actions/'+action);
            if(!read&&!write)throw Error('本轮未授权此操作；额外权限、对外发布或承诺请向负责人请示');
            if(write && (!a.data || !Number.isInteger(a.data.version)))throw Error('先读取任务当前版本');
            const args=read?{method:'GET',path:a.path}:{method:'POST',path:a.path,data:a.data,idempotencyKey:this.job+':'+a.path.split('/').pop()};
            try {
                const result=await salesRequest(s,args,signal);
                if(write && (!result || result.id!==this.task || result.truncated))throw Error('业务回执不完整');
                if(result?.id===this.task && result.status==='完成'){
                    this.finishedTask=true;
                    this.outcome=a.path.endsWith('/submit-campaign-article')?'文稿已提交内部审核：'+result.article_id:
                        a.path.endsWith('/answer-inquiry')?'答复已保存至原访客咨询页':'CRM 任务状态：完成';
                }
                if(typeof result?.article_id==='string' && a.path.endsWith('/submit-campaign-article'))this.evidence.add('/articles/'+result.article_id);
                this.evidence.add(a.path);
                return result;
            }catch(error){if(write){s.enabled=false;s.status='写入未确认，请核查';this.notify(s.status+'：'+a.path,this.job+'-unknown');this.save();}throw error;}
        }
        if(!['sales_report','sales_learn','sales_ask_human'].includes(name))throw Error('本轮未提供该工具');
        const evidence:string[]=Array.isArray(a.evidence)?[...new Set<string>(a.evidence)]:[];
        if(!evidence.length||evidence.length>12||evidence.some(e=>!this.evidence.has(e)))throw Error('请引用本轮已核对的 CRM 路径');
        const field=(key:string)=>{if(typeof a[key]!=='string'||!a[key].trim()||a[key].length>2400)throw Error('需要简明的'+key);return a[key].trim();};
        const kind=name==='sales_report'?'工作汇报':name==='sales_learn'?'复盘改进':'请示';
        if(name==='sales_report' && this.task && !this.finishedTask)throw Error('尚无完成回执；无法继续时请用 sales_ask_human 提交请示');
        const content=name==='sales_report'?(this.outcome?this.outcome+'\n':'')+field('content'):name==='sales_learn'?field('observation')+'\n下一轮：'+field('nextAction'):field('question')+'\n建议：'+field('recommendation');
        const result=await salesRequest(s,{method:'POST',path:'/sales-reports',idempotencyKey:this.job+':'+name,data:{
            name:kind+' · '+new Date().toISOString().slice(0,10),kind,campaign_id:s.campaignId,channel_account_id:this.channel,content,evidence:evidence.join('\n'),
        }},signal);
        if(!result?.id)throw Error('CRM 未返回汇报编号');
        if(name==='sales_learn'){
            s.learning=[...s.learning.filter(x=>x.reportId!==result.id),{observation:a.observation,nextAction:a.nextAction,evidence,reportId:result.id}].slice(-12);
        }else if(name==='sales_ask_human'){
            s.pending={id:result.id,question:a.question,recommendation:a.recommendation,evidence};s.status='等你决定';this.asked=true;this.reported=true;
        }else {s.lastReport={id:result.id,content,evidence};this.reported=true;}
        this.save();this.notify(kind+'：'+content+'\n依据：'+evidence.join('、'),result.id);
        return {id:result.id,kind,status:s.status};
    }
}
