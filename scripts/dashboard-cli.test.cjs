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
 await page.locator('[data-cli="gemini"]').waitFor();assert.equal(await page.locator('[data-cli]').count(),Object.keys(catalog).length);
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

test('Claude dashboard creates, edits and switches write-only provider profiles without replaying failed changes',{timeout:60000},async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.DASHBOARD_BROWSER?{executablePath:process.env.DASHBOARD_BROWSER}:{})});
 try{
  const page=await browser.newPage(),errors=[],mutations=[];let state={version:1,activeProfileId:null,profiles:[]},failActivate=false,holdAccount=false,releaseAccount,accountPending;
  const accountStarted=new Promise(resolve=>accountPending=resolve);
  page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
  const catalog=agentAccountCatalog((id,args)=>({executable:'/fixture/'+id,args,path:'/fixture/'+id,source:'test'}),'darwin');
  await page.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url()),method=request.method(),pathname=url.pathname;
   if(pathname==='/dashboard')return route.fulfill({contentType:'text/html',body:dashboardHtml()});
   if(pathname==='/admin/status')return route.fulfill({json:{clients:[],uptimeMs:0}});
   if(pathname==='/agents/accounts')return route.fulfill({json:catalog});
   if(pathname==='/agents/backends'){
    if(holdAccount){const wait=new Promise(resolve=>releaseAccount=resolve);accountPending();await wait;}
    return route.fulfill({json:{claude:{available:true,authenticated:true,account:{email:'stale-before-switch@example.test'}}}});
   }
   if(pathname==='/agents/claude/config'&&method==='GET')return route.fulfill({json:state});
   if(pathname.startsWith('/agents/claude/config/')){
    const body=method==='DELETE'?undefined:request.postDataJSON();mutations.push({method,path:pathname,body});
    if(pathname.endsWith('/activate')){
     if(failActivate)return route.abort('failed');
     state={...state,activeProfileId:body.profileId};
    }else if(method==='POST'){
     const {secret,...profile}=body;state={...state,profiles:[...state.profiles,{id:'provider-1',...profile,hasSecret:!!secret}]};
    }else if(method==='PATCH'){
     const {secret,...profile}=body;state={...state,profiles:state.profiles.map(saved=>({...saved,...profile,...(secret?{hasSecret:true}:{})}))};
    }else if(method==='DELETE')state={...state,profiles:[]};
    return route.fulfill({json:state});
   }
   return route.fulfill({json:{ok:true}});
  });
  await page.goto('http://127.0.0.1:8080/dashboard#cli-accounts');
  await page.locator('#claude-config-open').click();await page.locator('#claude-config-panel').waitFor();
  await page.locator('#claude-profile-new').click();
  await page.locator('#claude-profile-name').fill('<img src=x onerror=alert(1)>');
  await page.locator('#claude-profile-base-url').fill('https://gateway.example.test/anthropic');
  await page.locator('#claude-profile-auth-type').selectOption('authToken');
  await page.locator('#claude-profile-secret').fill('fixture-dashboard-secret');
  await page.locator('#claude-profile-model').fill('provider-model');
  await page.locator('#claude-profile-form summary').click();
  await page.locator('#claude-profile-sonnet-model').fill('provider-sonnet');
  await page.locator('#claude-profile-opus-model').fill('provider-opus');
  await page.locator('#claude-profile-haiku-model').fill('provider-haiku');
  await page.locator('#claude-profile-save').click();
  const row=page.locator('[data-profile-id="provider-1"]');await row.waitFor();
  assert.equal(await row.locator('img').count(),0);assert.ok(!(await page.locator('#claude-config-panel').innerText()).includes('fixture-dashboard-secret'));
  const created=mutations.find(change=>change.method==='POST'&&change.path.endsWith('/profiles'));
  assert.equal(created.body.secret,'fixture-dashboard-secret');assert.equal(created.body.opusModel,'provider-opus');
  assert.equal(await page.locator('#claude-profile-secret').inputValue(),'');
  holdAccount=true;await page.locator('[data-cli="claude"]').getByRole('button',{name:'检测账号',exact:true}).click();await accountStarted;
  await row.getByRole('button',{name:'启用',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[data-profile-id="provider-1"] button').disabled);
  holdAccount=false;releaseAccount();await page.waitForFunction(()=>!cliChecks.has('claude'));
  assert.equal(await page.locator('[data-cli="claude"]').getAttribute('data-status'),'unknown','the previous provider account result is discarded after switching');
  assert.equal(await row.getByRole('button',{name:'删除',exact:true}).isDisabled(),true);
  await row.getByRole('button',{name:'编辑',exact:true}).click();
  assert.equal(await page.locator('#claude-profile-secret').inputValue(),'');
  await page.locator('#claude-profile-name').fill('Renamed gateway');await page.locator('#claude-profile-model').fill('updated-model');
  await page.locator('#claude-profile-save').click();await page.waitForFunction(()=>document.querySelector('#claude-profile-list').textContent.includes('Renamed gateway'));
  const edited=mutations.find(change=>change.method==='PATCH');assert.equal('secret' in edited.body,false);assert.equal(edited.body.model,'updated-model');
  await page.locator('#claude-profile-native').click();
  await page.waitForFunction(()=>document.querySelector('[data-profile-id="provider-1"] button').disabled===false);
  failActivate=true;const before=mutations.length;await row.getByRole('button',{name:'启用',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#claude-config-notice').textContent.includes('刷新'));
  await page.waitForTimeout(120);assert.equal(mutations.length,before+1,'uncertain activation is not replayed');
  assert.equal(await page.locator('#claude-profile-new').isDisabled(),true);assert.equal(await row.getByRole('button',{name:'启用',exact:true}).isDisabled(),true);
  failActivate=false;await page.locator('#claude-config-refresh').click();
  await row.getByRole('button',{name:'删除',exact:true}).click();await row.waitFor({state:'detached'});
  assert.ok(mutations.some(change=>change.method==='DELETE'));
  assert.ok(!(await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}))).includes('fixture-dashboard-secret'));
  for(const width of [1280,390]){
   await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  }
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

test('Missing Claude configuration capability leaves account checks available',{timeout:60000},async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.DASHBOARD_BROWSER?{executablePath:process.env.DASHBOARD_BROWSER}:{})});
 try{
  const page=await browser.newPage(),errors=[];let unsupported='missing';
  page.on('pageerror',error=>errors.push(error.message));
  const catalog=agentAccountCatalog((id,args)=>({executable:'/fixture/'+id,args,path:'/fixture/'+id,source:'test'}),'darwin');
  await page.route('**/*',route=>{
   const pathname=new URL(route.request().url()).pathname;
   if(pathname==='/dashboard')return route.fulfill({contentType:'text/html',body:dashboardHtml()});
   if(pathname==='/admin/status')return route.fulfill({json:{clients:[],uptimeMs:0}});
   if(pathname==='/agents/accounts')return route.fulfill({json:catalog});
   if(pathname==='/agents/claude/config')return unsupported==='missing'?route.fulfill({status:404,json:{error:'Unknown agent endpoint'}}):route.fulfill({json:{...(unsupported==='unknown'?{version:99}:{}),activeProfileId:null,profiles:[]}});
   if(pathname==='/agents/backends')return route.fulfill({json:{claude:{available:true,authenticated:true,account:{email:'legacy@example.test'}}}});
   return route.fulfill({json:{ok:true}});
  });
  await page.goto('http://127.0.0.1:8080/dashboard#cli-accounts');
  await page.locator('#claude-config-open').click();
  await page.waitForFunction(()=>document.querySelector('#claude-config-notice').textContent.length>0);
  assert.equal(await page.locator('#claude-profile-new').isDisabled(),true);
  for(const mode of ['unknown','absent']){
   unsupported=mode;const response=page.waitForResponse(response=>new URL(response.url()).pathname==='/agents/claude/config');
   await page.locator('#claude-config-refresh').click();await response;
   await page.waitForFunction(()=>document.querySelector('#claude-config-notice').textContent.includes('此版本'));
   assert.equal(await page.locator('#claude-profile-new').isDisabled(),true);
  }
  await page.locator('[data-cli="claude"]').getByRole('button',{name:'检测账号',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[data-cli="claude"] .cli-identity').textContent==='legacy@example.test');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
