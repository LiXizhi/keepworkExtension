const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('models')) { console.log('native-model\tNative model\nfast-model\tFast model'); process.exit(0); }
if (!args.includes('--input-format') || args.includes('--acp') || args.includes('--dangerously-skip-permissions')) process.exit(2);
const id = args.includes('--conversation') ? args[args.indexOf('--conversation') + 1] : require('node:crypto').randomUUID();
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
send({event:'init',conversation_id:id,init:{cwd:process.cwd()}});
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
    const message = JSON.parse(line);
    if (message.event !== 'user') process.exit(3);
    const content = message.message.content;
    if (content.includes('crash')) process.exit(7);
    if (content.includes('wait')) return;
    const denied = content.includes('denied');
    const config = path.join(process.cwd(),'.agents/mcp_config.json');
    const text = content.includes('inspect') ? JSON.stringify({pid:process.pid,args,cwd:process.cwd(),mcp:fs.existsSync(config)?JSON.parse(fs.readFileSync(config,'utf8')):null,hasCapability:!!process.env.KEEPWORK_AICHAT_CAPABILITY}) : '中文😀';
    send({event:'step_update',step_update:{conversation_id:id,step_index:1,step_type:'agent_response',state:'ACTIVE',text_delta:text}});
    send({event:'step_update',step_update:{conversation_id:id,step_index:2,step_type:'tool',state:'DONE',tool_name:'read_file',tool_info:{parameters:{path:'fixture.txt'},output:'read result'}}});
    send({event:'result',result:{conversation_id:id,status:'SUCCESS',response:text,...(denied?{denied_actions:[{action:'mcp',display_name:'CallMcpTool'}]}:{})}});
});
