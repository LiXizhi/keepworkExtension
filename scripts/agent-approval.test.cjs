const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript');
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,f);
const {approvalDecision,execpolicyDecisions}=require('../src/core/agentApproval.ts');
const decision={acceptWithExecpolicyAmendment:{execpolicy_amendment:['fixture','arg with spaces','中文']}};
const request={method:'item/commandExecution/requestApproval',params:{availableDecisions:['accept',decision,'cancel']}};
test('native decision forwarding never grants persistent permission to other protocols or missing proposals',()=>{
    assert.deepEqual(approvalDecision('codex',request,decision),decision);
    for(const backend of ['claude','copilot','workbuddy','cursor','trae','qwen','gemini','kimi','codebuddy','opencode']){
        assert.deepEqual(execpolicyDecisions(backend,request),[]);
        assert.throws(()=>approvalDecision(backend,request,decision));
    }
    assert.throws(()=>approvalDecision('codex',{...request,params:{proposedExecpolicyAmendment:['fixture']}},decision));
    assert.throws(()=>approvalDecision('codex',request,'acceptForSession'));
    assert.equal(approvalDecision('codex',request,'accept'),'accept');
    assert.equal(approvalDecision('codex',{params:{}},'acceptForSession'),'acceptForSession');
    for(const tokens of [[],[''],[1],['x\0y'],Array(257).fill('x')]){
        const invalid={acceptWithExecpolicyAmendment:{execpolicy_amendment:tokens}};
        assert.deepEqual(execpolicyDecisions('codex',{...request,params:{availableDecisions:[invalid]}}),[]);
    }
});
