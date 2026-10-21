const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const file=path.resolve(__dirname,'../src/core/channelStatus.ts'), mod=new Module(file,module);
mod.require=id=>id.startsWith('./messaging')?{}:require(id);
mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,file);
const {ChannelStatus,expiry}=mod.exports;
test('channel status caches read-only checks, strips credentials and retains live binding state',async()=>{
 let calls=0;const commands=[];
 const status=new ChannelStatus('.',{
  resolveDws:()=>'/dws',resolveLark:()=>'/lark',
  dws:async (args,root)=>{assert.equal(root,__dirname);calls++;commands.push(args);return {token:'SECRET',profiles:[{profile:'corp:user',status:'active',expiresAt:1900000000,refreshExpAt:'2031-01-01T00:00:00Z',accessToken:'SECRET'}]};},
  lark:async (args,root)=>{assert.equal(root,__dirname);calls++;commands.push(args);return {appId:'app',identities:{user:{openId:'user',status:'ready',token:'SECRET'}}};}
 });
 const roots={dingtalk:__dirname,feishu:__dirname};
 const binding={root:__dirname,channel:'feishu',profile:'app:user',enabled:true,status:'listening'};
 const [a,b]=await Promise.all([status.snapshot([binding],roots),status.snapshot([binding],roots)]);
 assert.equal(calls,2);assert.equal(a[0].accounts[0].expiresAt,new Date(1900000000000).toISOString());
 assert.equal(a[1].accounts[0].expiresAt,null);assert.doesNotMatch(JSON.stringify(a),/SECRET|accessToken/);
 assert.deepEqual(a,b);assert.equal(commands.some(args=>args.includes('--verify')||args.includes('login')),false);
 const fresh=await status.snapshot([{...binding,enabled:false,status:'stopped'}],roots);
 assert.equal(calls,2);assert.equal(fresh[1].bindings[0].enabled,false);
});
test('missing CLI and failed auth checks are distinct without leaking raw errors',async()=>{
 const result=await new ChannelStatus('.',{
  resolveDws:()=>{throw Error('SECRET');},resolveLark:()=>'/lark',
  dws:async()=>{throw Error('must not run');},lark:async()=>{throw Error('SECRET token');}
 }).snapshot([],{feishu:__dirname});
 assert.equal(result[0].installed,false);assert.equal(result[1].installed,true);
 assert.match(result[1].error,/无法读取/);assert.doesNotMatch(JSON.stringify(result),/SECRET/);
 for(const invalid of [null,undefined,'',-1,'not-a-date',1e30])assert.equal(expiry(invalid),null);
});


test('dashboard displays pinned roots and never starts CLI probes without valid roots',async()=>{
 let calls=0;
 const status=new ChannelStatus(__dirname,{resolveDws:()=>'/dws',resolveLark:()=>'/lark',dws:async()=>{calls++;return {profiles:[]};},lark:async()=>{calls++;return {};}});
 const empty=await status.snapshot([]);
 assert.equal(calls,0);assert.equal(empty[0].root,'');
 await status.snapshot([],{dingtalk:path.join(__dirname,'missing-brain')});assert.equal(calls,0);
 const valid=await status.snapshot([],{dingtalk:__dirname});assert.equal(calls,1);assert.equal(valid[0].root,__dirname);
});
