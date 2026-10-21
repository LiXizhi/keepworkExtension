import * as http from 'node:http';
import { MessagingService, channelConflict } from '../core/messaging';
import { messagingWorkerHtml } from '../core/messagingExecutor';
export async function handleMessagingHttp(req: http.IncomingMessage, res: http.ServerResponse, url: URL, service: MessagingService) {
    res.setHeader('Cache-Control','no-store'); res.setHeader('Referrer-Policy','no-referrer');
    const json = (status: number, data: any) => { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(data)); };
    const body = async () => { let data = ''; for await (const chunk of req) { data += chunk; if (Buffer.byteLength(data) > 131072) throw new Error('Request too large'); } return JSON.parse(data || '{}'); };
    try {
        const route = url.pathname;
        if (route === '/messaging/events' && req.method === 'GET') {
            res.writeHead(200,{'Content-Type':'text/event-stream','X-Accel-Buffering':'no'});
            const update = () => { if (!res.destroyed && !res.writableEnded && !res.write('event: status\ndata: '+JSON.stringify({bindings:service.list()})+'\n\n')) res.end(); };
            const unwatch = service.watch(update,() => res.end());
            const heartbeat = setInterval(() => { if (!res.write(': messaging\n\n')) res.end(); },25000); heartbeat.unref();
            res.on('close',()=>{clearInterval(heartbeat);unwatch();}); update(); return;
        }
        if (route === '/messaging/worker' && req.method === 'GET') { res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-src https://keepwork.com https://cdn.keepwork.com http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'"}); res.end(messagingWorkerHtml); return; }
        if (route.startsWith('/messaging/worker/')) {
            const key = String(req.headers.authorization || '').replace(/^Bearer /,''), owner = String(req.headers['x-agent-owner'] || '');
            if (route.endsWith('/claim') && req.method === 'POST') { json(200,service.workers.claim(key,owner)); return; }
            if (route.endsWith('/tool') && req.method === 'POST') { const data=await body();json(200,{result:await service.workers.tool(key,owner,data.id,data.name,data.args)});return; }
            if (route.endsWith('/result') && req.method === 'POST') { const data = await body(); service.workers.result(key,owner,String(data.text || ''),data.error); json(200,{ok:true}); return; }
            if (route.endsWith('/alive') && req.method === 'GET') { json(service.workers.alive(key,owner) ? 200 : 410,{alive:service.workers.alive(key,owner)}); return; }
        }
        if (route === '/messaging/config' && req.method === 'GET') {
            const root = url.searchParams.get('root'); const bindings = service.list().filter(row => !root || row.root.toLowerCase() === root.toLowerCase());
            json(200,{bindings:bindings.map(row => { try { return {...row,...service.rules(row.id)}; } catch(error) { return {...row,error:(error as Error).message}; } }), defaults:service.defaults(root)}); return;
        }
        if (route === '/messaging/config' && req.method === 'POST') { json(200,service.configure(await body())); return; }
        if (route === '/messaging/profiles' && req.method === 'POST') { json(200,{profiles:await service.profiles(String((await body()).root || ''))}); return; }
        if (route === '/messaging/groups' && req.method === 'POST') { const data=await body();json(200,{groups:await service.groups(String(data.root||''),String(data.profile||''),String(data.query||''))});return; }
        if (route === '/messaging/status' && req.method === 'GET') { json(200,{bindings:service.list()}); return; }
        if (route === '/messaging/start' && req.method === 'POST') { const {id,switchFromRoot} = await body(); const binding=service.view(id); if(switchFromRoot !== undefined) await service.switchChannel(binding.channel as 'dingtalk'|'feishu',binding.root,String(switchFromRoot)); await service.start(id); json(200,service.view(id)); return; }
        if (route === '/messaging/stop' && req.method === 'POST') { const {id} = await body(); service.stop(id); json(200,service.view(id)); return; }
        json(404,{error:'Messaging route not found'});
    } catch(error) { const conflict=channelConflict(error); json(conflict?409:400,conflict||{error:(error as Error).message}); }
}
