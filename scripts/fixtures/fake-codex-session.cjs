const readline=require('node:readline');
const out=m=>process.stdout.write(JSON.stringify(m)+'\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);let result={};
 if(m.method==='initialize')result={userAgent:'fixture'};
 if(m.method==='account/read')result={account:{type:'chatgpt'}};
 if(m.method==='model/list')result={data:[{id:'fixture'}]};
 if(m.method==='thread/start')result={thread:{id:'codex-thread'}};
 if(m.method==='thread/resume'||m.method==='thread/read')result={thread:{id:'codex-thread',turns:[]}};
 if(m.method==='turn/start'){
   result={turn:{id:'turn'}};
   setTimeout(()=>{
     out({method:'item/completed',params:{threadId:'codex-thread',item:{id:'a',type:'agentMessage',text:'fixture reply'}}});
     out({method:'turn/completed',params:{threadId:'codex-thread',turn:{id:'turn',status:'completed'}}});
   },25);
 }
 if(m.id!==undefined)out({id:m.id,result});
});
