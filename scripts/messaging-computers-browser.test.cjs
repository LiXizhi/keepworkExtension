const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript');
const {chromium}=require('playwright-core');
test('messaging computers console ranks devices and exposes degraded/legacy states on desktop and mobile',async()=>{
 const old=require.extensions['.ts'];require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,f);
 let html;try{html=require('../src/mcp/dashboard.ts').dashboardHtml();}finally{require.extensions['.ts']=old;}
 const browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL||'chrome',headless:true});
 try{const page=await browser.newPage(),errors=[],posts=[];page.on('pageerror',e=>errors.push(e.message));
 const channel={channel:'dingtalk',account:'corp:user',mode:'active',order:['a','b'],revision:0,lease:{computerId:'a'},candidates:[{computerId:'a',name:'Home computer',eligible:true},{computerId:'b',name:'Office computer',eligible:true}]};
 const account={owner:'fixture-owner',enabled:true,channels:[channel]};
 await page.route('**/*',async route=>{const url=new URL(route.request().url());let value={};
 if(url.pathname==='/dashboard')return route.fulfill({contentType:'text/html',body:html});
 if(url.pathname==='/admin/status')value={clients:[],uptimeMs:1};
 if(url.pathname==='/admin/personas')value={stats:{},personas:[],sessions:[],recentMessages:[]};
 if(url.pathname==='/admin/messaging-computers'){if(route.request().method()==='POST'){const body=route.request().postDataJSON();posts.push(body);channel.order=body.order;channel.revision++;}value={accounts:[account]};}
 return route.fulfill({contentType:'application/json',body:JSON.stringify(value)});});
 await page.goto('http://127.0.0.1:7777/dashboard#personas');await page.locator('#messaging-computers span').filter({hasText:'Home computer'}).waitFor();
 const panel=page.locator('#messaging-computers');await panel.getByRole('button',{name:'下移'}).first().click();await page.waitForFunction(()=>document.querySelector('#messaging-computers span')?.textContent.startsWith('Office computer'));
 assert.deepEqual(posts[0].order,['b','a']);assert.equal(posts[0].revision,0);assert.equal(posts[0].owner,'fixture-owner');
 channel.degraded=true;channel.mode='offline-active';await page.getByText('断线继续响应，可能重复回复',{exact:false}).waitFor();
 for(const width of [1280,390]){await page.setViewportSize({width,height:900});assert.equal(await panel.isVisible(),true);assert.equal(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth&&el.getBoundingClientRect().right<=innerWidth),true);}
 account.enabled=false;channel.mode='local';channel.degraded=false;await panel.getByRole('button',{name:'启用多电脑协调'}).waitFor();assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
