import * as fs from 'node:fs';
import * as path from 'node:path';
import { confined, knowledgeDirectory, MessageConfig } from './messagingPolicy';

export type GroupWorkRequest = { owner:string; agentId:string; root:string; channel:string; account:string; group:string; message:string; tool:string; args:any; cancel?:()=>void };
export type GroupWorkApproval = (request:GroupWorkRequest,signal:AbortSignal)=>Promise<void>;
/** Same public-knowledge boundary as retrieval; never expand access using a skill or a group message. */
export function groupKnowledgePath(root:string,config:MessageConfig,relative:unknown,list=false) {
    if(typeof relative!=='string'||!relative||path.isAbsolute(relative))throw Error('Use an approved relative knowledge path');
    const parts=relative.replace(/\\/g,'/').split('/');
    if(parts.some(part=>!part||part.startsWith('.')||/^(account|credentials|secrets)$/i.test(part)))throw Error('Private knowledge path');
    let candidate=root;
    for(const part of parts){candidate=path.join(candidate,part);if(fs.lstatSync(candidate).isSymbolicLink())throw Error('Knowledge symlinks are not allowed');}
    const target=confined(root,relative);
    const allowed=config.knowledge.some(dir=>{const base=knowledgeDirectory(root,dir),rel=path.relative(base,target);return !rel||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));});
    if(!allowed)throw Error('File outside approved public knowledge');
    if(!list&&!/\.(md|txt)$/i.test(target))throw Error('Only public text knowledge is readable');
    return target;
}
export function readGroupKnowledge(root:string,config:MessageConfig,name:string,args:any) {
    const target=groupKnowledgePath(root,config,args?.path,name==='list_dir');
    if(name==='list_dir')return fs.readdirSync(target,{withFileTypes:true}).filter(e=>!e.isSymbolicLink()&&!e.name.startsWith('.')&&!/^(account|credentials|secrets)$/i.test(e.name)&&(e.isDirectory()||/\.(md|txt)$/i.test(e.name))).slice(0,500).map(e=>({name:e.name,directory:e.isDirectory()}));
    if(fs.statSync(target).size>256000)throw Error('File too large');
    return fs.readFileSync(target,'utf8');
}
