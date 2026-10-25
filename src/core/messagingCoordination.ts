import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {createHash, randomUUID} from 'node:crypto';

export const COORDINATION = 'account.coordination.v1';
export const coordinationKey = (...parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
function save(file:string,value:unknown) { fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(value),{mode:0o600});fs.renameSync(file+'.tmp',file); }
export function computerIdentity(home:string) {
    const file=path.join(home,'computer.json');
    try {const id=JSON.parse(fs.readFileSync(file,'utf8')).id;if(typeof id==='string'&&/^[a-zA-Z0-9-]{1,80}$/.test(id))return id;}catch{}
    const id=randomUUID();save(file,{id});return id;
}
type Resource = {eligible:boolean;reason:string;view:any;confirmed:boolean;epoch:string};
/** One connection per verified Keepwork account, independent of browser lifetime. */
export class MessagingCoordinator {
    private socket:any;
    private pending=new Map<string,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}>();
    private resources=new Map<string,Resource>();
    private journal:Record<string,{resource:string;key:string;time:number}>={};
    private timer?:NodeJS.Timeout;
    private busy=false;
    private closed=false;
    private online=false;
    private reconnectAt=0;
    private lastPong=0;
    private generation=0;
    status='connecting';
    private journalFile:string;
    constructor(readonly username:string,private token:string,readonly computerId:string,home:string,private changed:()=>void,
        private gateway=process.env.AICHAT_RELAY_GATEWAY || 'https://us1.gameserver.keepwork.com',private fetchImpl=fetch,private WebSocketImpl:any=(globalThis as any).WebSocket) {
        const endpoint = new URL(this.gateway);
        if (endpoint.username || endpoint.password || (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost','127.0.0.1'].includes(endpoint.hostname)))) throw Error('Invalid coordination gateway');
        this.gateway = endpoint.href.replace(/\/$/, '');
        const identity = this.gateway === 'https://us1.gameserver.keepwork.com' ? [username] : [this.gateway,username];
        this.journalFile=path.join(home,coordinationKey(...identity)+'.journal.json');
        try{this.journal=JSON.parse(fs.readFileSync(this.journalFile,'utf8'));}catch(e:any){if(e.code!=='ENOENT')this.status='journal-unavailable';}
        this.timer=setInterval(()=>void this.tick(),10000);this.timer.unref();
    }
    setToken(token:string) {if(token!==this.token){this.token=token;this.disconnect(false);}}
    register(resource:string,eligible:boolean,reason='') {const r=this.resources.get(resource);if(r){r.eligible=eligible;r.reason=reason;}else this.resources.set(resource,{eligible,reason,view:null,confirmed:false,epoch:''});void this.tick();}
    snapshot(resource:string) {const r=this.resources.get(resource);return {computerId:this.computerId,name:os.hostname(),status:this.status,online:this.online,...r?.view,
        degraded:!this.online&&!!r?.confirmed,reason:r?.reason||'',mode:!this.online?(r?.confirmed?'offline-active':'waiting'):r?.view?.lease?.computerId===this.computerId?(r.view.lease.draining?'draining':'active'):'standby'};}
    canRun(resource:string,admit=false) {const r=this.resources.get(resource);if(!r?.eligible)return false;
        if(!this.online)return this.status==='disconnected'&&r.confirmed;
        if(this.status!=='online')return false;
        return r.view?.lease?.computerId===this.computerId && r.view.lease.connection===this.selfId && r.view.lease.expires>Date.now() && (!admit||!r.view.lease.draining);}
    private selfId='';
    private update(resource:string,value:any) {const r=this.resources.get(resource);if(!r)return;r.view=value;
        const owns=value?.lease?.connection===this.selfId&&value?.lease?.computerId===this.computerId;
        r.confirmed=owns;r.epoch=owns?value.lease.epoch:'';this.changed();}
    async request(resource:string,op:string,extra:any={}) {
        if(!this.online)throw Error('coordination-unavailable');
        const requestId=randomUUID(),r=this.resources.get(resource);
        return new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(requestId);reject(Error('coordination-outcome-unknown'));},8000);timer.unref();
            this.pending.set(requestId,{resolve:value=>{this.update(resource,value);resolve(value);},reject,timer});
            try {this.socket.send(JSON.stringify({type:COORDINATION,requestId,resource,op,epoch:r?.epoch,...extra}));}catch{clearTimeout(timer);this.pending.delete(requestId);reject(Error('coordination-unavailable'));}});
    }
    private async connect() {
        const epoch=++this.generation;
        const response=await this.fetchImpl(this.gateway+'/api/join',{method:'POST',headers:{Authorization:'Bearer '+this.token,'Content-Type':'application/json'},body:JSON.stringify({username:this.username,project:'aichat',roleId:'messaging',roomType:'account'}),redirect:'error',signal:AbortSignal.timeout(8000)});
        const join:any=await response.json();if(epoch!==this.generation||this.closed)return;
        if(response.status===401||response.status===403)throw Error('login-required');
        if(!response.ok||join.visibility!=='private'||join.ownerUsername!==this.username)throw Error('join-failed');
        const url=new URL(join.url);if(url.protocol!=='wss:'&&!(['localhost','127.0.0.1'].includes(url.hostname)&&this.gateway.startsWith('http://')))throw Error('wss-required');
        const socket=this.socket=new this.WebSocketImpl(join.url);
        socket.onopen=()=>{if(epoch===this.generation)socket.send(JSON.stringify({type:'hello',playerId:join.playerId,instanceId:join.instanceId,roomId:join.roomId,ticket:join.ticket}));};
        socket.onmessage=(event:any)=>{if(epoch!==this.generation)return;try{const m=JSON.parse(String(event.data));
            if(m.type==='welcome'){
                if(m.room?.ownerUsername!==this.username||m.room?.visibility!=='private'||!m.capabilities?.includes(COORDINATION)){this.disconnect(false);this.status='server-upgrade-required';this.changed();return;}
                this.selfId=m.self.id;this.online=true;this.status='reconciling';this.lastPong=Date.now();void this.tick();
            }else if(m.type==='pong')this.lastPong=Date.now();
            else if(m.type===COORDINATION&&m.kind==='state'){this.update(m.resource,m.value);}
            else if(m.type===COORDINATION){const p=this.pending.get(m.requestId);if(p){clearTimeout(p.timer);this.pending.delete(m.requestId);m.ok?p.resolve(m.value):p.reject(Error(m.error||'coordination-failed'));}}
        }catch{}};
        socket.onclose=()=>{if(epoch===this.generation)this.disconnect(true);};socket.onerror=()=>socket.close();
    }
    private disconnect(allowOffline:boolean) {++this.generation;const socket=this.socket;this.socket=null;socket?.close();this.online=false;this.selfId='';this.status=allowOffline?'disconnected':'connecting';this.reconnectAt=Date.now()+10000;
        if(!allowOffline)for(const r of this.resources.values())r.confirmed=false;
        for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('coordination-outcome-unknown'));}this.pending.clear();this.changed();}
    private async tick() {
        if(this.closed||this.busy||['journal-unavailable','login-required'].includes(this.status))return;this.busy=true;
        try{
            if(!this.online){if(this.socket&&Date.now()-this.lastPong>25000)this.disconnect(true);if(!this.socket&&Date.now()>=this.reconnectAt){this.lastPong=Date.now();await this.connect();}return;}
            if(Date.now()-this.lastPong>25000){this.disconnect(true);return;}this.socket.send(JSON.stringify({type:'ping'}));
            // Reconcile receipts before registering as eligible after any reconnect.
            for(const [id,item] of Object.entries(this.journal)){if(item.time<Date.now()-7*86400000){delete this.journal[id];continue;}await this.request(item.resource,'merge',item);delete this.journal[id];save(this.journalFile,this.journal);}
            for(const [resource,r] of this.resources){
                await this.request(resource,'register',{computerId:this.computerId,name:os.hostname(),eligible:r.eligible,reason:r.reason});
                if(r.epoch)await this.request(resource,r.eligible?'renew':'release');
            }
            this.status='online';this.changed();
        }catch(e:any){if(e.message==='login-required'){this.disconnect(false);this.status='login-required';this.changed();}else if(this.online){this.status=e.message||'coordination-error';for(const r of this.resources.values())r.confirmed=false;this.changed();}else{this.status='disconnected';this.reconnectAt=Date.now()+10000;}}
        finally{this.busy=false;}
    }
    async claim(resource:string,key:string,time:number) {
        if(!Number.isFinite(time)||time<Date.now()-7*86400000||time>Date.now()+60000)throw Error('invalid-work');
        if(!this.canRun(resource,true)||this.status==='reconciling')return false;
        if(this.online)return (await this.request(resource,'claim',{key,time})).accepted===true;
        const id=resource+':'+key;if(this.journal[id])return false;
        if(Object.keys(this.journal).length>=10000)throw Error('offline-journal-full');
        this.journal[id]={resource,key,time};save(this.journalFile,this.journal);return true;
    }
    async sending(resource:string,key:string,time:number) {
        if(!this.canRun(resource))throw Error('gateway-not-owner');
        if(this.online)await this.request(resource,'sending',{key,time});
        else {this.journal[resource+':'+key]={resource,key,time};save(this.journalFile,this.journal);}
    }
    async complete(resource:string,key:string,time:number) {if(this.online)await this.request(resource,'complete',{key,time});}
    close(){this.closed=true;clearInterval(this.timer);this.disconnect(false);}
}
