const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript');
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(process.env.AICHAT_TRANSPORT_PROOF&&f.endsWith('aichatRuntime.ts')?process.env.AICHAT_TRANSPORT_PROOF:f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,f);
const {keepworkRuntimeRequest,createMcpAgentRuntime}=require('../src/core/aichatRuntime.ts');
const {readKeepworkModelStream}=require('../src/core/keepworkModelStream.ts');
const event=value=>'data: '+JSON.stringify(value)+'\r\n\r\n';
function stream(text,size=3){const bytes=new TextEncoder().encode(text);let offset=0;return new Response(new ReadableStream({pull(controller){if(offset>=bytes.length)return controller.close();controller.enqueue(bytes.slice(offset,offset+size));offset+=size;}}),{headers:{'content-type':'text/event-stream; charset=utf-8'}});}
const tool={id:'crm-read',type:'function',function:{name:'crm_read',arguments:'{"query":"试玩"}'}};
test('real service shape: non-stream loses tools; SSE preserves one finalized call and completes the model loop',async()=>{
 let requests=0,executions=0;
 const runtime=createMcpAgentRuntime({token:'fixture'},async(name,args)=>{executions++;assert.equal(name,'crm_read');assert.equal(args.query,'试玩');return '待认领任务';},{fetch:async(_url,init)=>{
  const body=JSON.parse(init.body);requests++;
  // Reproduce the observed coreservice aggregation contract, not an invented JSON tool response.
  if(!body.stream)return new Response(JSON.stringify({result:''}));
  if(requests===1)return stream(event({tool_calls_delta:[{index:0,function:{arguments:'{"query":'}}]})+event({result:'',stop_reason:'tool_calls',isLocalTool:true,tool_calls:[tool]}));
  assert.ok(body.messages.some(m=>m.role==='tool'&&m.content==='待认领任务'));
  return stream(event({result:'已读取'})+event({result:'任务',stop_reason:'stop'}));
 }});
 try{assert.equal(await runtime.answer({id:'crm-stream',prompt:'read',question:'go',history:[],tools:[{type:'function',function:{name:'crm_read',parameters:{type:'object'}}}]},new AbortController().signal),'已读取任务');assert.equal(executions,1);assert.equal(requests,2);}finally{runtime.close();}
});
test('truncated, malformed, length-limited or unfinished tool streams fail without executing or retrying',async()=>{
 for(const text of [event({tool_calls_delta:[tool]}),event({stop_reason:'tool_calls'}),event({stop_reason:'length',tool_calls:[tool]}),'data: {broken}\n\n',event({error:{message:'private provider error'}}),'data: {"result":"cut"}']){
  let requests=0,executions=0;const runtime=createMcpAgentRuntime({token:'fixture'},async()=>{executions++;},{fetch:async()=>{requests++;return stream(text);}});
  try{await assert.rejects(runtime.answer({id:'bad',prompt:'',question:'go',history:[],tools:[]},new AbortController().signal));assert.equal(executions,0);assert.equal(requests,1);}finally{runtime.close();}
 }
});
test('cancellation releases an idle stream, transport is bounded and JSON response compatibility remains',async()=>{
 const controller=new AbortController();let cancelled=false;
 const response=new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}});
 const pending=readKeepworkModelStream(response,controller.signal);controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(cancelled,true);
 await assert.rejects(readKeepworkModelStream(stream('data: '+'x'.repeat(2*1024*1024),100000)),/limit/);
 assert.deepEqual(await keepworkRuntimeRequest({token:'fixture'},{},async()=>new Response(JSON.stringify({result:'compatible'}))),{result:'compatible'});
});

test('tool deltas followed by normal stop or DONE cannot silently become text-only success',async()=>{
 for(const delta of [{tool_calls_delta:[tool]},{choices:[{delta:{tool_calls:[tool]}}]}]){
  for(const ending of [event({result:'claimed success',stop_reason:'stop'}),'data: [DONE]\n\n']){
   let requests=0,executions=0;const events=[];
   const runtime=createMcpAgentRuntime({token:'private-token'},async()=>{executions++;},{emit:e=>events.push(e),fetch:async()=>{requests++;return stream(event(delta)+ending);}});
   try{await assert.rejects(runtime.answer({id:'delta-only',prompt:'',question:'go',history:[],tools:[]},new AbortController().signal),/omitted finalized/);assert.equal(requests,1);assert.equal(executions,0);
    const diagnostic=events.find(e=>e.type==='model-response');assert.equal(diagnostic.toolDeltaFrames,1);assert.equal(diagnostic.finalizedToolCalls,0);
    assert.doesNotMatch(JSON.stringify(diagnostic),/private-token|claimed success|crm-read|query/);
   }finally{runtime.close();}
  }
 }
});

test('transport diagnostics distinguish text-only response from finalized calls without capturing content',async()=>{
 const summaries=[];
 await keepworkRuntimeRequest({token:'private-token'},{tools:[tool]},async()=>stream(event({result:'private prose',stop_reason:'stop'})),s=>summaries.push(s));
 await keepworkRuntimeRequest({token:'private-token'},{tools:[tool]},async()=>stream(event({tool_calls_delta:[tool]})+event({tool_calls:[tool],stop_reason:'tool_calls'})),s=>summaries.push(s));
 assert.deepEqual(summaries.map(s=>[s.advertisedTools,s.toolDeltaFrames,s.finalizedToolCalls,s.completed]),[[1,0,0,true],[1,1,1,true]]);
 assert.doesNotMatch(JSON.stringify(summaries),/private|crm-read|query/);
});
