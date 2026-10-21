const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), ts = require('typescript');
require.extensions['.ts'] = (m,f) => m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,f);
const {agentAccountCatalog,accountShellCommand} = require('../src/core/agentAccountActions.ts');
const {AGENT_BACKENDS} = require('../src/core/agentCliBackends.ts');
test('account catalog keeps every provider and separates CLI input from shell commands', () => {
 const catalog=agentAccountCatalog((id,args)=>({executable:'/fixture/'+id,args,path:'/fixture/'+id,source:'test'}),'darwin');
 assert.deepEqual(Object.keys(catalog),[...AGENT_BACKENDS]);
 assert.equal(catalog.gemini.actions.logout.command,"'/fixture/gemini'");
 assert.equal(catalog.gemini.actions.logout.input,'/logout');
 assert.equal(catalog.qwen.actions.logout,undefined);
 assert.equal(catalog.qwen.actions.login.input,'/auth');
 assert.equal(catalog.codex.actions.logout.command,"'/fixture/codex' 'logout'");
 assert.equal(catalog.claude.actions.login.command,"'/fixture/claude' 'auth' 'login'");
 assert.ok(Object.values(catalog).every(item=>item.available));
 const absent=agentAccountCatalog(()=>{throw Error('Not installed');});
 assert.equal(Object.keys(absent).length,AGENT_BACKENDS.length);
 assert.ok(Object.values(absent).every(item=>!item.available&&Object.keys(item.actions).length===0));
});
test('resolved native paths and arguments are quoted for each platform without executing shell text', () => {
 const launch={executable:"/tmp/a'b $(touch bad)",args:['login'],path:'unused',source:'test'};
 assert.equal(accountShellCommand(launch,'darwin'),"'/tmp/a'\\''b $(touch bad)' 'login'");
 assert.equal(accountShellCommand(launch,'win32'),"& '/tmp/a''b $(touch bad)' 'login'");
});
