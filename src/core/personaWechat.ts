import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Browser, chromium, Page } from 'playwright-core';

const HOUR = 60 * 60_000;
const hosts = new Set(['wx.qq.com', 'wx2.qq.com', 'web.wechat.com', 'web2.wechat.com']);
type Preview = { name: string; preview: string; time: string; pinned: boolean };
type Binding = { owner: string; id: string; enabled: boolean; next: number; last?: number;
    profileId?: string; account?: string; status: string; rows: Preview[] };

// Only direct commands with both a recipient and literal message enter this route.
export function wechatSendCommand(input:string){
    const command=input.trim().replace(/^(?:请(?:你)?|帮我)\s*/, '');
    const match=/^(?:给|向)\s*微信(?:上(?:的)?)?\s*(.{1,100}?)\s*(?:发送|发)(?:一条消息|一条|条消息|条|个消息|个|消息)?[：:\s]*([\s\S]+)$/u.exec(command)
        || /^\/微信\s+(.{1,100}?)[：:]\s*([\s\S]+)$/u.exec(command)
        || /^send\s+(.{1,100}?)\s+(?:on|via)\s+wechat\s*:\s*([\s\S]+)$/i.exec(command);
    if(!match)return;
    const recipient=match[1].trim(),body=match[2].trim();
    if(!recipient || !body)return;
    return {recipient,body};
}

export async function firstScreen(page: Page, openName?:string, send=false): Promise<Preview[]> {
    return page.locator('.chat_list.scroll-content:visible').evaluate((list, {openName,send}) => {
        const bounds = list.getBoundingClientRect();
        // A list moved by another client is no longer the first screen.
        if (list.scrollTop > 1) throw Error('请将微信会话列表返回顶部');
        const rows = Array.from(list.querySelectorAll('.chat_item')).filter(el => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.top >= Math.max(0,bounds.top)-1 &&
                r.bottom <= Math.min(innerHeight,bounds.bottom)+1 && r.left < innerWidth && r.right > 0;
        });
        const pinned = rows.filter(el => el.classList.contains('top'));
        const selected=pinned.length ? pinned : rows.slice(0,5);
        if(openName!==undefined){
            const matches=(send?rows:selected).filter(el=>el.querySelector<HTMLElement>('.nickname')?.innerText.trim()===openName);
            if(matches.length!==1)throw Error('会话列表已变化或存在重名，请返回并重新选择');
            (matches[0] as HTMLElement).click();
        }
        return selected.map(el => {
            const value = (selector:string) => (el.querySelector<HTMLElement>(selector)?.innerText || '').trim().slice(0,500);
            return {name:value('.nickname'),preview:value('.msg'),time:value('.ext .attr'),pinned:el.classList.contains('top')};
        }).filter(row => row.name);
    }, {openName,send}, {timeout:5000});
}

const root = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(),'.local','share'),'WechatWebGroups');


async function attach(profile:string): Promise<Browser | undefined> {
    try {
        const [port, endpoint] = fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').trim().split(/\r?\n/);
        if (!/^\d+$/.test(port) || !/^\/devtools\/browser\/[\w-]+$/.test(endpoint)) return;
        return await chromium.connectOverCDP('ws://127.0.0.1:'+port+endpoint,{timeout:2000});
    } catch { return; }
}

export async function withWechatTab<T>(work:(p:Page)=>Promise<T>, profileId?:string):Promise<T> {
    if(profileId && !/^[a-f0-9]{32}$/.test(profileId))throw Error('微信浏览器配置无效');
    const profile=path.join(root,profileId ? 'persona-'+profileId : 'chrome-profile');
    let browser = await attach(profile);
    if (!browser) {
        const exe = [process.env.CHROME_PATH, ...['ProgramFiles','ProgramFiles(x86)','LOCALAPPDATA'].map(key=>
            path.join(process.env[key] || '', 'Google/Chrome/Application/chrome.exe')),
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/google-chrome'].find(file=>file && fs.existsSync(file));
        if(!exe)throw Error('请安装 Google Chrome 或设置 CHROME_PATH');
        const child = spawn(exe,['--headless','--user-data-dir='+profile,'--remote-debugging-address=127.0.0.1',
            '--remote-debugging-port=0','--no-first-run','--disable-notifications','--mute-audio','about:blank'],
            {windowsHide:true,detached:true,stdio:'ignore'});
        let failed = false;
        child.once('error',()=>{failed=true;}); child.unref();
        for (let attempt=0; attempt<50 && !failed && !browser; attempt++) {
            await new Promise(resolve=>setTimeout(resolve,200));
            browser=await attach(profile);
        }
        if (!browser) throw Error('无法打开专用无头 Chrome，请检查 Chrome 安装及配置目录');
    }
    try {
        const context=browser.contexts()[0];
        const allowed=(p:Page)=>{const u=new URL(p.url());return u.protocol==='https:' && hosts.has(u.hostname);};
        let page=context.pages().find(allowed);
        if (!page) {
            page=context.pages().find(p=>p.url()==='about:blank') || await context.newPage();
            await page.goto('https://wx.qq.com/',{waitUntil:'domcontentloaded',timeout:15000});
        }
        if (!allowed(page)) throw Error('微信网页地址异常');
        return await work(page);
    } finally { await browser.close(); } // CDP attachments disconnect; Chrome stays running.
}

export class PersonaWechat {
    private binding?:Binding;
    private busy=false;
    private file:string;
    private pairing:string;
    constructor(home:string, private change:(owner:string)=>void, private withTab=withWechatTab) {
        this.file=path.join(home,'wechat-binding.json');
        this.pairing=path.join(home,'wechat-pairing.txt');
        if(fs.existsSync(this.file)) this.binding=JSON.parse(fs.readFileSync(this.file,'utf8'));
    }
    trayStatus() {
        const binding = this.binding;
        if (!binding) return 'unbound';
        if (binding.status === '等待扫码') return 'qr';
        if (binding.status === '已连接') return binding.enabled ? 'monitoring' : 'verified';
        if (binding.status === '已绑定' || binding.status === '未绑定') return 'idle';
        return 'attention';
    }
    view(owner:string,id:string) {
        const b=this.binding;
        if(!b || b.owner!==owner || b.id!==id) return {enabled:false,status:b?'本机微信已绑定其他分身':'未绑定',qrConnectVersion:1,conversationViewVersion:1,manualCheckVersion:1,machine:os.hostname()};
        const {owner:_,id:__,profileId:___,...state}=b;
        return {...state,qrConnectVersion:1,conversationViewVersion:1,manualCheckVersion:1,machine:os.hostname()};
    }
    private save() {
        if(!this.binding)return;
        fs.writeFileSync(this.file+'.tmp',JSON.stringify(this.binding),{mode:0o600});
        fs.renameSync(this.file+'.tmp',this.file);
        this.change(this.binding.owner);
    }
    remove(owner:string,id:string) {
        if(this.binding?.owner!==owner || this.binding.id!==id)return;
        fs.rmSync(this.file,{force:true});
        this.binding=undefined;
    }
    tick(now:number) {
        if(this.binding?.enabled && this.binding.next<=now && !this.busy)
            void this.request(this.binding.owner,this.binding.id,'poll').catch(()=>{});
    }
    async send(owner:string,id:string,recipient:string,text:string,signal:AbortSignal){
        const b=this.binding;
        if(!b || b.owner!==owner || b.id!==id || !b.account)throw Error('请在该分身的微信面板连接账号');
        if(this.busy)throw Error('微信正在处理其他请求，请稍后重试');
        this.busy=true;
        try{
            return await this.withTab(async page=>{
                const account=page.locator('.header .nickname .display_name:visible');
                if((await account.textContent({timeout:4000}).catch(()=>''))?.trim()!==b.account)throw Error('微信登录已失效或账号已切换，请检查微信面板');
                signal.throwIfAborted();
                await firstScreen(page,recipient,true);
                const header=page.locator('.box_hd .title_name:visible');
                await page.waitForFunction(name=>Array.from(document.querySelectorAll<HTMLElement>('.box_hd .title_name'))
                    .some(el=>el.offsetWidth && (el.innerText.trim()===name || el.innerText.trim().replace(/\s*[（(]\d+[)）]$/,'').trim()===name)),recipient,{timeout:4000});
                const editor=page.locator('[contenteditable=true]:visible');
                if((await editor.innerText()).trim())throw Error('微信输入框中已有草稿，未发送');
                const matches=page.locator('.chat_bd.scroll-content:visible .bubble.right').filter({hasText:new RegExp('^'+text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$')});
                const before=await matches.count();
                signal.throwIfAborted();
                await editor.fill(text,{timeout:4000});
                const sendButton=page.getByRole('link',{name:/^(Send|发送)$/});
                await sendButton.waitFor({timeout:4000});
                const target=(await header.innerText()).trim();
                if((target!==recipient && target.replace(/\s*[（(]\d+[)）]$/,'').trim()!==recipient) || (await account.innerText()).trim()!==b.account || (await editor.innerText()).trim()!==text)
                    throw Error('微信发送目标或正文已变化，未发送');
                signal.throwIfAborted();
                try{
                    await sendButton.click({timeout:4000});
                    const bubble=matches.nth(before);
                    await bubble.waitFor({timeout:5000});
                    if((await header.innerText()).trim()!==target)throw Error('会话已切换');
                    const row=bubble.locator('xpath=ancestor::*[contains(concat(" ",normalize-space(@class)," ")," message ")][1]');
                    if(await row.locator('.ico_fail:visible,.web_wechat_message_fail:visible').count())throw Error('失败');
                }catch{throw Error('微信未能确认发送结果，请查看会话后再决定是否重发');}
                return '微信「'+recipient+'」中已出现本次发出的消息：'+text;
            },b.profileId);
        }finally{this.busy=false;}
    }
    async request(owner:string,id:string,action:string,code?:string,conversation?:string) {
        if(this.busy)throw Error('微信正在读取，请稍后再试');
        // A fresh QR pairs a new browser profile. Access to the existing signed-in profile still requires local pairing.
        const fresh=!this.binding && action==='connect';
        if(!this.binding && ['start','check','qr'].includes(action)){
            if(!fs.existsSync(this.pairing))fs.writeFileSync(this.pairing,randomBytes(16).toString('hex'),{mode:0o600,flag:'wx'});
            if(!code || code.trim()!==fs.readFileSync(this.pairing,'utf8').trim())
                throw Error('首次绑定请填写本机配对码，文件位于 '+this.pairing);
            this.binding={owner,id,enabled:false,next:0,status:'已绑定',rows:[]};
            this.save();
            fs.rmSync(this.pairing,{force:true});
        }
        const b:Binding|undefined=fresh ? {owner,id,profileId:createHash('sha256').update(JSON.stringify([owner,id])).digest('hex').slice(0,32),enabled:false,next:0,status:'未绑定',rows:[]} : this.binding;
        if(action==='connect')action='qr';
        if(!b || b.owner!==owner || b.id!==id)throw Error('当前分身未绑定本机微信');
        if(action==='unbind' && !b.enabled){this.remove(owner,id);this.change(owner);return this.view(owner,id);}
        if(action==='stop'){b.enabled=false;this.save();return this.view(owner,id);}
        if(action==='start' && b.enabled)return this.view(owner,id);
        if(action==='start')b.enabled=true;
        else if(!['qr','poll','confirm','check','login-status','conversation'].includes(action) || (action==='poll' && !b.enabled))throw Error('微信操作不可用');
        const scheduled=action==='poll' || action==='start';
        if(action==='conversation' && (!conversation || !b.rows.some(row=>row.name===conversation)))
            throw Error('请选择当前列表中的微信会话');
        let opened:{name:string;image:string}|undefined;
        this.busy=true;
        try {
            const qr=await this.withTab(async page=>{
                const account=page.locator('.header .nickname .display_name:visible');
                // An expired session may show a kick-off notice instead of the QR panel.
                if(action==='qr' && !(await account.count())) {
                    await page.goto('https://wx.qq.com/',{waitUntil:'domcontentloaded',timeout:15000});
                }
                await account.or(page.locator('.qrcode:visible')).first().waitFor({timeout:10000});
                if(!await account.count()){
                    b.status='等待扫码';
                    if(action==='qr' || action==='check'){
                        if(action==='check')await page.reload({waitUntil:'domcontentloaded',timeout:15000});
                        const img=page.locator('.qrcode img.img:visible').first();
                        await page.waitForFunction(()=>Array.from(document.querySelectorAll<HTMLImageElement>('.qrcode img.img')).some(i=>i.offsetWidth && i.naturalWidth>100),undefined,{timeout:8000});
                        return 'data:image/png;base64,'+(await img.screenshot({timeout:3000})).toString('base64');
                    }
                    return;
                }
                const name=(await account.innerText()).trim();
                if(!name || (b.account && b.account!==name))throw Error('微信账号与绑定账号不一致');
                if(action==='qr'){b.status='已连接';b.account=name;return;}
                if(action==='conversation' && conversation){
                    await firstScreen(page,conversation);
                    const title=page.locator('.box_hd .title_name:visible');
                    const matchesTitle=(value:string)=>value.trim()===conversation || value.trim().replace(/\s*[（(]\d+[)）]$/,'').trim()===conversation;
                    await page.waitForFunction(name=>Array.from(document.querySelectorAll<HTMLElement>('.box_hd .title_name'))
                        .some(el=>el.offsetWidth && (el.innerText.trim()===name || el.innerText.trim().replace(/\s*[（(]\d+[)）]$/,'').trim()===name)),conversation,{timeout:4000});
                    const body=page.locator('.chat_bd.scroll-content:visible');
                    await body.waitFor({timeout:4000});
                    const clip=await body.evaluate(el=>{
                        const r=el.getBoundingClientRect(),x=Math.max(0,r.left),y=Math.max(0,r.top);
                        return {x:x+scrollX,y:y+scrollY,width:Math.min(innerWidth,r.right)-x,height:Math.min(innerHeight,r.bottom)-y};
                    });
                    const shot=await page.screenshot({clip,type:'jpeg',quality:82,timeout:4000});
                    if(!matchesTitle(await title.innerText()) || !await account.isVisible())throw Error('微信会话已切换，请重新打开');
                    opened={name:conversation,image:'data:image/jpeg;base64,'+shot.toString('base64')};
                    return;
                }
                const rows=await firstScreen(page);
                b.rows=rows;b.account=name;b.last=Date.now();b.status='已连接';
            },b.profileId);
            if(fresh){
                if(!qr && !b.account)throw Error('未取得微信登录二维码，请重试');
                this.binding=b;
            }
            if(scheduled)b.next=Date.now()+HOUR;
            return {...this.view(owner,id),qr,conversation:opened};
        } catch(error){if(scheduled)b.next=Date.now()+HOUR;if(action!=='conversation')b.status=(error as Error).message.split('\n')[0].slice(0,180);throw error;}
        finally {this.busy=false;if(this.binding===b)this.save();}
    }
}
