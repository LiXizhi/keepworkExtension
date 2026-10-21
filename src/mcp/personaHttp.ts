import * as http from 'node:http';
import { ownerKey } from '../core/agentSessions';
import { Personas } from '../core/personas';
import { MessagingService, messagingNeedsLogin, channelConflict } from '../core/messaging';

export async function handlePersonaHttp(req:http.IncomingMessage,res:http.ServerResponse,url:URL,personas:Personas,messaging:MessagingService){
    res.setHeader('Cache-Control','no-store');
    const send=(status:number,value:any)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
    try{
        const owner=ownerKey(String(req.headers.origin||''),String(req.headers['x-agent-owner']||''));
        let input:any={};if(req.method==='POST'){if(!String(req.headers['content-type']).startsWith('application/json'))throw Error('JSON required');let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>131072)throw Error('Request too large');}input=JSON.parse(raw||'{}');}
        const parts=url.pathname.split('/').filter(Boolean),id=parts[2],action=parts[3];
        if(id==='events'&&req.method==='GET'){
            res.writeHead(200,{'Content-Type':'text/event-stream','X-Accel-Buffering':'no'});
            const update=()=>{if(!res.destroyed&&!res.writableEnded&&!res.write('event: changed\ndata: {}\n\n'))res.end();};
            const stop=personas.watch(owner,update,()=>res.end());const timer=setInterval(()=>{if(!res.write(': alive\n\n'))res.end();},25000);timer.unref();
            res.on('close',()=>{clearInterval(timer);stop();});update();return;
        }
        if(!id&&req.method==='GET'){send(200,{agents:personas.list(owner)});return;}
        if(!id&&req.method==='POST'){send(200,personas.upsert(owner,input));return;}
        if(!action&&req.method==='GET'){send(200,personas.read(owner,id,Number(url.searchParams.get('before')||Infinity)));return;}
        // Resolve ownership even for channel routes.
        personas.read(owner,id);
        if(action==='inbox'&&req.method==='GET'){send(200,messaging.inboxView(owner,id,url.searchParams.get('binding')||'',url.searchParams.get('conversation')||'',Number(url.searchParams.get('before')||Infinity)));return;}
        if(req.method!=='POST'){send(405,{error:'Method not allowed'});return;}
        switch(action){
            case 'messages':send(200,personas.submit(owner,id,input));return;
            case 'clear':send(200,personas.clear(owner,id));return;
            case 'read':send(200,personas.markRead(owner,id));return;
            case 'cancel':send(200,await personas.cancel(owner,id));return;
            case 'approval-revoke':send(200,personas.revokeApproval(owner,id));return;
            case 'respond':send(200,personas.respond(owner,id,input));return;
            case 'schedules':send(200,personas.schedule(owner,id,input));return;
            case 'remove':await personas.remove(owner,id);send(200,{ok:true});return;
            case 'channel-connect':{const agent=personas.read(owner,id);try{if(input.channel && !['dingtalk','feishu'].includes(input.channel))throw Error('Unknown channel');if(input.switchFromRoot !== undefined) await messaging.switchChannel(input.channel || 'dingtalk',String(input.root||agent.root||''),String(input.switchFromRoot));send(200,await (input.channel==='feishu'?messaging.connectFeishuAgent(owner,id,String(input.root||agent.root||''),agent.prompt):messaging.connectAgent(owner,id,String(input.root||agent.root||''),agent.prompt)));}catch(error){if(!messagingNeedsLogin(error))throw error;send(200,{status:'needs-login',listening:false,needsLogin:true});}return;}
            case 'channel-login':{const agent=personas.read(owner,id);if(input.switchFromRoot !== undefined) await messaging.switchChannel('dingtalk',String(input.root||agent.root||''),String(input.switchFromRoot));send(200,await messaging.loginAgent(owner,id,String(input.root||agent.root||''),agent.prompt));return;}
            case 'bind':{const result=messaging.bindAgent(owner,id,input.binding);messaging.setAgentPrompt(owner,id,personas.read(owner,id).prompt);send(200,result);return;}
            case 'inbox':send(200,messaging.inboxAction(owner,id,input.binding,input.conversation||'',input.action));return;
            case 'reply':send(200,await messaging.manualReply(owner,id,input.binding,input.conversation,input.requestId,input.text));return;
            case 'channel-start':messaging.assertAgentBinding(owner,id,input.binding);await messaging.start(input.binding);send(200,{ok:true});return;
            case 'channel-stop':messaging.assertAgentBinding(owner,id,input.binding);messaging.stop(input.binding);send(200,{ok:true});return;
            default:send(404,{error:'Unknown Agent operation'});
        }
    }catch(error){const conflict=channelConflict(error);send(conflict?409:400,conflict||{error:(error as Error).message});}
}
