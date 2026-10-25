import { roleApprovalProperties, roleNeedsApproval } from './agentRolePolicy';
import { AichatClient } from './aichatPresence';
import { AichatWorkspaceFiles, WORKSPACE_FILE_TOOL } from './aichatWorkspaceFiles';
// Generated from the canonical AIChat ES modules; bundled statically into each daemon.
const { COMPACT_PROMPT } = require('./vendor/aichat-runtime/context.cjs');
const { createAgentRuntime } = require('./vendor/aichat-runtime/agent.cjs');
export interface RuntimeInput {
    id: string; prompt: string; question: string; history: {role:string;content:string}[];
    root?: string; model?: string; tools: any[]; skills?: string[];
    members?: Record<string, any>; owner?: string; workspaceId?: string;
}
export type RuntimeOptions = {
    roleScopedWrites?: boolean;
    fetch?: typeof fetch;
    approve?: (name:string,args:any,signal:AbortSignal)=>Promise<void>;
    workspaceFiles?: AichatWorkspaceFiles;
    persist?: (snapshot:any)=>void | Promise<void>;
    emit?: (event:any)=>void;
};

/** One request, no tool execution and no automatic retry after uncertain submission. */
export async function keepworkRuntimeRequest(login: AichatClient | null, options:any, fetchImpl: typeof fetch = fetch) {
    if (!login?.token) throw Error('需要登录 AIChat');
    const base = new URL(login.baseURL || 'https://api.keepwork.com/core/v0');
    if (base.protocol !== 'https:' || !['api.keepwork.com','keepwork.com','api-dev.kp-para.cn'].includes(base.hostname)
        || base.username || base.password || base.search || base.hash || base.pathname.replace(/\/$/,'') !== '/core/v0') throw Error('Unsupported Keepwork API origin');
    const body:any = { model: options.model || 'keepwork-pro', messages: options.messages, stream: false, reasoning: false, max_tokens: options.maxTokens || 6000 };
    if (options.tools?.length) body.localTools = options.tools;
    const response = await fetchImpl(`${base.href.replace(/\/$/,'')}/gpt/chat`, { method:'POST', redirect:'error', headers:{'Content-Type':'application/json',Authorization:`Bearer ${login.token}`}, body:JSON.stringify(body), signal:options.abortController?.signal });
    if ([401,403].includes(response.status)) throw Error('需要重新登录 AIChat');
    if (!response.ok) throw Error(`Keepwork model request failed (${response.status}); not retried`);
    const result:any = await response.json();
    if (!result || typeof result !== 'object' || result.error) throw Error('Keepwork model returned an invalid response');
    return result;
}

/** Internal owner-scoped service for personas and custom agent teams. */
export function createMcpAgentRuntime(login:AichatClient|null, executeTool:(name:string,args:any,signal:AbortSignal)=>Promise<unknown>, options:RuntimeOptions = {}) {
    const read = async (file:string,spec:any) => {
        if (options.workspaceFiles && spec.owner && spec.workspaceId) {
            const result:any = await options.workspaceFiles.execute(spec.owner,spec.workspaceId,{operation:'read',path:file,endLine:1000});
            const data=JSON.parse(result.content?.find((c:any)=>c.type==='text')?.text || '{}');
            if(data.totalLines>data.endLine)throw Error('Workspace instructions exceed runtime read limit');
            return String(data.content || '');
        }
        if (!spec.workspace) throw Error('No authorized workspace');
        return String(await executeTool('read_file',{path:file},spec.signal));
    };
    const runtime = createAgentRuntime({
        request:(request:any)=>keepworkRuntimeRequest(login,request,options.fetch),
        summarize:async(history:any[],spec:any)=>{
            const result=await keepworkRuntimeRequest(login,{model:spec.model,messages:[{role:'system',content:COMPACT_PROMPT},{role:'user',content:JSON.stringify(history)}],abortController:{signal:spec.signal}},options.fetch);
            if(typeof result.result!=='string'||!result.result.trim())throw Error('Context compaction returned no summary');
            return result.result;
        },
        execute:async(name:string,args:any,spec:any)=>{
            if(name==='workspace_file'&&options.workspaceFiles&&spec.owner&&spec.workspaceId){
                if(!['read','list','search'].includes(args.operation)&&(!options.roleScopedWrites||roleNeedsApproval(args))){
                    if(!options.approve)throw Error('Owner approval unavailable');
                    await options.approve(name,args,spec.signal);
                }
                if(spec.signal.aborted)throw Error('Cancelled');
                return options.workspaceFiles.execute(spec.owner,spec.workspaceId,args);
            }
            return executeTool(name,args,spec.signal);
        },
        workspaceContext:async(spec:any)=>{
            if (!spec.workspace && !spec.workspaceId) return '\nNo workspace is bound. File and terminal access require an explicit workspace binding.';
            let instructions='';
            try { instructions=await read('AGENTS.md',spec); } catch(error) { if (!/ENOENT|not found/i.test((error as Error).message)) throw error; }
            const grant=spec.owner&&spec.workspaceId?options.workspaceFiles?.snapshot(spec.owner,spec.workspaceId):null;
            const brain=grant?.spaces.find(space=>space.aliases.includes('.brain'));
            const brainContext=brain
                ? '\n# Second brain\n'+(brain.id===grant?.primaryId?'The Primary workspace is the second brain. Bare paths resolve here.':'The second brain is separate from the Primary workspace; bare paths stay on Primary.')
                    +'\nUse workspace_file with //.brain/ for second-brain files, for example //.brain/_wiki/index.md.\nSecond-brain location: '+(brain.root || brain.name || brain.id)
                : '';
            return '\nWorkspace: '+(spec.workspace || spec.workspaceId)+brainContext+'\n\n# Workspace instructions (AGENTS.md)\n'+instructions+'\nOnly advertised tools are available. Browser canvases, voice, UI navigation and browser JavaScript are unavailable. Workspace aliases are not OS paths.';
        },
        resolveSkill:async(id:string,spec:any)=>{
            if (!/^[\w.-]+(?:\/[\w.-]+)*$/.test(id) || id.split('/').includes('..')) throw Error('Invalid skill identifier');
            const file=id.endsWith('/SKILL.md')?id:`.github/skills/${id}/SKILL.md`;
            return {content:await read(file,spec)};
        },
        persist:options.persist, emit:options.emit,
    });
    return { ...runtime, registerWorkspaces(owner:string,id:string,grant:any) {
        if(!options.workspaceFiles)throw Error('Workspace provider unavailable');
        return options.workspaceFiles.register(owner,id,grant);
    }, async answer(input:RuntimeInput,signal:AbortSignal) {
        if (!login?.token) throw Error('需要登录 AIChat');
        const result=await runtime.turn({id:input.id,prompt:input.prompt,text:input.question,history:input.history,
            workspace:input.root || '',owner:input.owner,workspaceId:input.workspaceId,model:input.model || 'keepwork-pro',
            tools:[...input.tools,...(options.workspaceFiles&&input.workspaceId?[{type:'function',function:{name:WORKSPACE_FILE_TOOL.name,description:WORKSPACE_FILE_TOOL.description,parameters:options.roleScopedWrites?{...WORKSPACE_FILE_TOOL.inputSchema,properties:{...WORKSPACE_FILE_TOOL.inputSchema.properties,...roleApprovalProperties}}:WORKSPACE_FILE_TOOL.inputSchema}}]:[])],skills:input.skills || [],members:input.members || {},signal,conversationId:input.id});
        return result.answer as string;
    } };
}
