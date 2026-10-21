const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript');
const {chromium}=require('playwright-core');
test('dashboard shows occupied brain and asks before switching',async()=>{
 const old=require.extensions['.ts'];require.extensions['.ts']=(m,file)=>m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,file);
 let html;try{html=require('../src/mcp/dashboard.ts').dashboardHtml();}finally{require.extensions['.ts']=old;}
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const page=await browser.newPage(),requests=[],errors=[];let root='C:/brain-one';
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://127.0.0.1:39999/**',async route=>{
   const url=new URL(route.request().url());
   if(url.pathname==='/dashboard')return route.fulfill({contentType:'text/html',body:html});
   if(url.pathname==='/admin/channels/connection'){
    const body=route.request().postDataJSON();requests.push(body);
    if(body.switchFromRoot===root){root='C:/brain-two';return route.fulfill({json:{ok:true}});}
    return route.fulfill({status:409,json:{error:'DingTalk CLI is already occupied by C:/brain-one. Switch to C:/brain-two?',code:'CHANNEL_OCCUPIED',occupiedRoot:root,requestedRoot:'C:/brain-two',confirmationRequired:true}});
   }
   if(url.pathname==='/admin/channels')return route.fulfill({json:{channels:[{channel:'dingtalk',root,installed:true,accounts:[],bindings:[{id:'next',root:'C:/brain-two',profile:'corp:user',enabled:false,status:'stopped'}]}]}});
   if(url.pathname==='/admin/status')return route.fulfill({json:{clients:[],history:[]}});
   return route.fulfill({json:{}});
  });
  await page.goto('http://127.0.0.1:39999/dashboard');
  await page.getByText('第二大脑：C:/brain-one',{exact:true}).waitFor();
  page.once('dialog',dialog=>dialog.dismiss());
  await page.getByRole('button',{name:'连接',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('#channel-status button').disabled);
  assert.equal(requests.length,1);
  page.once('dialog',dialog=>dialog.accept());
  await page.getByRole('button',{name:'连接',exact:true}).click();
  await page.getByText('第二大脑：C:/brain-two',{exact:true}).waitFor();
  assert.equal(requests.length,3);assert.equal(requests[2].switchFromRoot,'C:/brain-one');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
