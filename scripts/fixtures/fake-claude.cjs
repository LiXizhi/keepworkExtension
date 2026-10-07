const readline=require('node:readline');
if(process.argv.includes('--version')){console.log('fixture Claude 1.0');process.exit(0);}
const session=process.argv.find(a=>a.startsWith('--session-id=')||a.startsWith('--resume='))?.split('=')[1];
const log=process.argv.find(a=>a.startsWith('--log='))?.slice(6);
if(log)require('node:fs').appendFileSync(log,JSON.stringify(process.argv.slice(2))+'\n');
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
let prompt;
function finish(text='中文😀',error=false){
 send({type:'assistant',message:{id:'assistant',content:[{type:'thinking',thinking:'Checking files'},{type:'text',text}]}});
 send({type:'assistant',message:{id:'tools',content:[{type:'tool_use',id:'tool',name:'Read',input:{path:'fixture.txt'}}]}});
 send({type:'user',message:{content:[{type:'tool_result',tool_use_id:'tool',content:'output'}]}});
 send({type:'result',subtype:error?'error_during_execution':'success',is_error:error,result:text});
}
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(log && process.argv.includes('--log-rpc'))require('node:fs').appendFileSync(log,JSON.stringify(m)+'\n');
 if(m.type==='control_request'){
  if(m.request.subtype==='initialize'&&process.argv.includes('--startup-result-error'))return send({type:'result',subtype:'error_during_execution',is_error:true,result:'Authentication required'});
  if(m.request.subtype==='initialize'&&process.argv.includes('--auth-required'))return send({type:'control_response',response:{subtype:'error',request_id:m.request_id,error:'Authentication required'}});
  send({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{models:[{value:'fixture',displayName:'Fixture model'}]}}});
  if(m.request.subtype==='initialize')send({type:'system',subtype:'init',session_id:session});
  if(m.request.subtype==='interrupt')send({type:'result',subtype:'success',result:'Interrupted'});
  return;
 }
 if(m.type==='user'){
  prompt=m.message.content[0].text;
  if(prompt.includes('crash'))return process.exit(1);
  if(prompt.includes('wait'))return;
  if(prompt.includes('permission')||prompt.includes('question'))return send({type:'control_request',request_id:'approval-'+session,request:{subtype:'can_use_tool',tool_name:prompt.includes('question')?'AskUserQuestion':'Read',input:prompt.includes('question')?{questions:[{question:'Choose?',options:[{label:'yes'}]}]}:{path:'fixture.txt',apiToken:'SECRET_NOT_IN_CACHE'}}});
  if(prompt.includes('stream')){
   send({type:'stream_event',event:{type:'message_start',message:{id:'streamed'}}});
   send({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'text',text:''}}});
   send({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'中文😀'}}});
   send({type:'assistant',message:{id:'streamed',content:[{type:'text',text:'中文😀'}]}});
   return send({type:'result',subtype:'success',result:'中文😀'});
  }
  return setTimeout(()=>finish(),25);
 }
 if(m.type==='control_response')finish(JSON.stringify(m.response.response),m.response.response.behavior==='deny');
});
