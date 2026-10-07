const readline = require('node:readline');
const fs = require('node:fs');
let currentModel = 'fixture', effort = 'medium';
const config = () => [
  {id:'model-config',category:'model',type:'select',currentValue:currentModel,options:[{group:'models',name:'Models',options:[{value:'fixture',name:'Fixture model'},{value:'fast',name:'Fast model'}]}]},
  ...(currentModel==='fixture'?[{id:'reasoning-effort',category:'thought_level',type:'select',currentValue:effort,options:[{value:'low',name:'Light'},{value:'medium',name:'Balanced'},{value:'high',name:'Deep'}]}]:[])
];
let prompt, cancelled = false;
const send = value => {
  const line = JSON.stringify({jsonrpc:'2.0',...value}) + '\n';
  const bytes = Buffer.from(line); const split = bytes.indexOf(Buffer.from('中文')) + 1;
  if (split > 0) { process.stdout.write(bytes.subarray(0,split)); process.stdout.write(bytes.subarray(split)); }
  else process.stdout.write(line);
};
const reply = (id,result) => send({id,result});
const update = value => send({method:'session/update',params:{sessionId:'same-thread',update:value}});
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 const log=process.argv.find(a=>a.startsWith('--log=')); if(log)fs.appendFileSync(log.slice(6),JSON.stringify(m)+'\n');
 if(m.method==='initialize') return reply(m.id,{protocolVersion:1,agentCapabilities:{loadSession:!process.argv.includes('--no-load')},authMethods:[{id:'cli',name:'CLI login'}]});
 if(m.method==='session/new') {
   if(process.argv.includes('--auth-required')) return send({id:m.id,error:{code:-32000,message:'Authentication required'}});
   return reply(m.id,process.argv.includes('--config-options')?{sessionId:'same-thread',configOptions:config()}:{sessionId:'same-thread',models:{currentModelId:'fixture',availableModels:[{modelId:'fixture',name:'Fixture model'}]}});
 }
 if(m.method==='session/set_model'&&process.argv.includes('--config-options'))return send({id:m.id,error:{code:-32601,message:'Use session/set_config_option'}});
 if(m.method==='session/set_config_option') {
   if(m.params.configId==='model-config'){currentModel=m.params.value;effort='medium';}
   else if(m.params.configId==='reasoning-effort'&&currentModel==='fixture')effort=m.params.value;
   else return send({id:m.id,error:{code:-32602,message:'Incorrect config ID'}});
   update({sessionUpdate:'config_option_update',configOptions:config()});return reply(m.id,{configOptions:config()});
 }
 if(m.method==='session/load'||m.method==='session/set_model') return reply(m.id,{});
 if(m.method==='session/prompt') {
   prompt=m;cancelled=false;
   update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'中文😀'}});
   if(m.params.prompt[0].text.includes('cursor-question'))return send({id:'cursor-question',method:'cursor/ask_question',params:{toolCallId:'tool',questions:[{id:'q',prompt:'Choose?',options:[{id:'yes',label:'Yes'}]}]}});
   if(m.params.prompt[0].text.includes('cursor-plan'))return send({id:'cursor-plan',method:'cursor/create_plan',params:{toolCallId:'tool',plan:'Review this plan'}});
   if(m.params.prompt[0].text.includes('permission')) return send({id:'approval',method:'session/request_permission',params:{sessionId:'same-thread',toolCall:{title:'Read local file'},options:[{optionId:'yes',kind:'allow_once'},{optionId:'no',kind:'reject_once'}]}});
   if(m.params.prompt[0].text.includes('wait')) return;
   return setTimeout(()=>{
     if(cancelled) return;
     update({sessionUpdate:'tool_call',toolCallId:'tool',title:'Read file',kind:'read',status:'in_progress',rawInput:{path:'fixture.txt'}});
     update({sessionUpdate:'tool_call_update',toolCallId:'tool',status:'completed',rawOutput:{text:'output'}});
     reply(m.id,{stopReason:'end_turn'});
   },25);
 }
 if(m.method==='session/cancel') {cancelled=true;return reply(prompt.id,{stopReason:'cancelled'});}
 if(m.id==='approval'||m.id==='cursor-question'||m.id==='cursor-plan') {
   update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(m.result)}});
   return reply(prompt.id,{stopReason:'end_turn'});
 }
});
