const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript');
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,f);
const {dashboardHtml}=require('../src/mcp/dashboard.ts');
const {agentAccountCatalog}=require('../src/core/agentAccountActions.ts');
const {chromium}=require('playwright-core');

test('CLI dashboard filters identities, executes owned terminal steps once, refreshes and reports failure', {timeout:60000},async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.DASHBOARD_BROWSER?{executablePath:process.env.DASHBOARD_BROWSER}:{})});
 try{
 const page=await browser.newPage(), errors=[], writes=[], deleted=[];let creates=0,signedIn=true,failWrite=false;
 page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 const catalog=agentAccountCatalog((id,args)=>{if(id==='trae')throw Error('not installed');return {executable:'/fixture/'+id,args,path:'/fixture/'+id,source:'test'};},'darwin');
 // Simulate only the renderer; HTTP requests and generated dashboard are real browser code.
 await page.addInitScript(()=>{window.Terminal=class{open(host){host.textContent='Native terminal fixture';}loadAddon(){}onData(fn){window.terminalInput=fn;}focus(){}write(){}reset(){}dispose(){}get cols(){return 80;}get rows(){return 24;}};window.FitAddon={FitAddon:class{fit(){}}};});
 await page.route('**/*',async r=>{
 const u=new URL(r.request().url()),p=u.pathname,method=r.request().method();
 if(p==='/dashboard')return r.fulfill({contentType:'text/html',body:dashboardHtml()});
 if(p==='/admin/status')return r.fulfill({json:{clients:[],uptimeMs:0}});
 if(p==='/agents/accounts')return r.fulfill({json:catalog});
 if(p==='/agents/backends'){const id=u.searchParams.get('backend');return r.fulfill({json:{[id]:{available:true,authenticated:signedIn,account:{username:'<img src=x onerror=alert(1)>'}}}});}
 if(p==='/terminal/sessions'&&method==='POST')return r.fulfill({json:{id:'fixture-'+(++creates)}});
 if(p.endsWith('/input')){writes.push(r.request().postDataJSON().data);return r.fulfill({status:failWrite?500:200,json:{ok:!failWrite}});}
 if(p.endsWith('/output'))return r.fulfill({json:{output:'native output',cursor:1,closed:false}});
 if(method==='DELETE'){deleted.push(p);return r.fulfill({json:{ok:true}});}
 return r.fulfill({json:{ok:true}});
 });
 await page.goto('http://127.0.0.1:8080/dashboard#cli-accounts');
 await page.locator('[data-cli="gemini"]').waitFor();assert.equal(await page.locator('[data-cli]').count(),11);
 const gemini=page.locator('[data-cli="gemini"]');
 await gemini.getByRole('button',{name:'检测账号',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[data-cli="gemini"] .cli-identity').textContent.includes('<img'));
 assert.equal(await gemini.locator('img').count(),0);
 assert.equal(await gemini.getAttribute('data-status'),'online');
 assert.equal(await page.locator('[data-cli]').first().getAttribute('data-cli'),'gemini');
 assert.match(await page.locator('#cli-summary').innerText(),/1 在线/);
 await page.locator('#cli-filter').selectOption('signed-in');assert.equal(await page.locator('[data-cli]').count(),1);
 await page.locator('#cli-filter').selectOption('all');
 await gemini.getByRole('button',{name:'登出',exact:true}).click();
 await page.locator('#cli-next').waitFor();assert.deepEqual(writes,["'/fixture/gemini'\r"]);
 assert.doesNotMatch(await gemini.locator('.cli-identity').innerText(),/<img/);
 await page.locator('#cli-next').click();await page.waitForFunction(()=>document.querySelector('#cli-next').hidden);
 await page.evaluate(()=>window.terminalInput('\x1b[B'));
 await page.waitForTimeout(50);assert.deepEqual(writes,["'/fixture/gemini'\r",'/logout\r','\x1b[B']);
 signedIn=false;await page.locator('#cli-complete').click();
 await page.waitForFunction(()=>document.querySelector('[data-cli="gemini"] .cli-identity').textContent==='未登录');
 assert.equal(deleted.length,1);assert.equal(creates,1);
 failWrite=true;await gemini.getByRole('button',{name:'登录',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#cli-notice').textContent.includes('终端输入失败'));
 const count=writes.length;await page.evaluate(()=>window.terminalInput('must-not-retry'));await page.waitForTimeout(80);assert.equal(writes.length,count);
 for(const width of [1280,390]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
 await page.locator('#cli-close').click();assert.equal(deleted.length,2);
 await page.evaluate(()=>{
   cliMessage('');
   cliStates.clear();
   cliStates.set('codex',{available:true,authenticated:true,account:{username:'alex'}});
   cliStates.set('gemini',{available:true,authenticated:true,account:{email:'alex@example.test'}});
   cliStates.set('copilot',{available:true,authenticated:true,modelsError:'Model access denied'});
   cliStates.set('qwen',{available:true,authenticated:false});
   renderCliAccounts();
 });
 assert.equal(await page.locator('[data-cli="copilot"]').getAttribute('data-status'),'error');
 assert.equal(await page.locator('[data-status="online"]').count(),2);
 await page.locator('#cli-filter').selectOption('signed-in');assert.equal(await page.locator('[data-cli]').count(),2);
 await page.locator('#cli-filter').selectOption('all');
 fs.mkdirSync('out/cli-dashboard',{recursive:true});
 for(const width of [1280,390]){
   await page.setViewportSize({width,height:844});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   await page.screenshot({path:'out/cli-dashboard/compact-'+width+'.png',fullPage:true});
 }
 assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
