// Offline JSON-RPC peer: stores simulated policy only in the test's temporary directory.
const fs=require('node:fs'),readline=require('node:readline');
const file=process.argv[2],responses=[];let serial=0,requestId=900,pending=new Map();
const decision={acceptWithExecpolicyAmendment:{execpolicy_amendment:['fixture-cli','send']}};
const output=value=>process.stdout.write(JSON.stringify(value)+'\n');
const finish=threadId=>{
    output({method:'item/completed',params:{threadId,item:{id:'answer-'+serial,type:'agentMessage',text:'fixture complete'}}});
    output({method:'turn/completed',params:{threadId,turn:{id:'turn-'+serial,status:'completed'}}});
};
readline.createInterface({input:process.stdin}).on('line',line=>{
    const message=JSON.parse(line),p=message.params||{};
    if(message.result){
        const thread=pending.get(message.id);if(!thread)return;
        responses.push(message);pending.delete(message.id);
        if(JSON.stringify(message.result.decision)===JSON.stringify(decision))fs.writeFileSync(file,JSON.stringify(decision));
        finish(thread);return;
    }
    if(message.method==='initialized')return;
    let result={};
    if(message.method==='initialize')result={userAgent:'offline-approval-fixture'};
    if(message.method==='thread/start')result={thread:{id:'thread-'+process.pid+'-'+(++serial)}};
    if(message.method==='model/list')result={data:[{id:'fixture',isDefault:true}]};
    if(message.method==='config/read')result={config:{approval_policy:'on-request',sandbox_mode:'workspace-write'}};
    if(message.method==='account/read')result={account:{type:'chatgpt'}};
    if(message.method==='fixture/state')result={responses,saved:fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null};
    if(message.method==='turn/start')result={turn:{id:'turn-'+serial}};
    output({id:message.id,result});
    if(message.method==='turn/start'){
        if(fs.existsSync(file)){finish(p.threadId);return;}
        const id=++requestId;pending.set(id,p.threadId);
        output({id,method:'item/commandExecution/requestApproval',params:{threadId:p.threadId,command:'fixture-cli send --content "hello\nworld"',reason:'离线授权回归测试',cwd:'/fixture',availableDecisions:['accept',decision,'cancel']}});
    }
});
