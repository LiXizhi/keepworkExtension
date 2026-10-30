const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { EventEmitter } = require('node:events');
function load(name, mocks = {}) {
    const file = path.resolve(__dirname, '../src/core', name + '.ts');
    const m = new Module(file, module); m.filename = file; m.paths = module.paths;
    m.require = id => {
        if (Object.hasOwn(mocks, id)) return mocks[id];
        if (id.startsWith('./')) {
            if (id.endsWith('.cjs')) return require(path.resolve(path.dirname(file),id));
            const base = path.basename(id).replace(/\.ts$/, '');
            if (fs.existsSync(path.resolve(__dirname, '../src/core', base + '.ts'))) return load(base, mocks);
        }
        return require(id);
    };
    m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file); return m.exports;
}
const {DingTalkHistorySync,historyPage,dingtalkHistorySelf}=load('messagingDingtalkSync');
const now=Date.parse('2026-10-29T08:00:00Z');
const row=(id='m')=>({openMessageId:id,openConversationId:'dm',senderOpenDingTalkId:'other',sender:'other-user',content:'恢复的消息',createTime:'2026-10-29 15:52:07',sendType:'user'});
const page=(rows=[row()],next='')=>({success:true,result:{conversationMessagesList:[{singleChat:true,openConversationId:'dm',messages:rows}],hasMore:!!next,nextCursor:next}});
function file(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dingtalk-history-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return path.join(dir,'cursor.json');}
test('China wall timestamps, self direction, and nontext history are preserved',()=>{
 const rows=historyPage(page([row(),{...row('self'),sender:'user',content:null}]),'', 'user').messages;
 assert.equal(rows[0].time,Date.parse('2026-10-29T07:52:07Z'));
 assert.equal(rows[1].direction,'out');assert.equal(rows[1].text,'[非文本消息]');
 assert.throws(()=>historyPage({success:false},'', 'user'));
 assert.throws(()=>historyPage(page([{...row(),createTime:'invalid'}]),'', 'user'));
});
test('restart resumes exact page; failed read/store cannot advance coverage; overlap is incremental',async t=>{
 const f=file(t), inbox=[],args=[];let fail=true;
 let sync=new DingTalkHistorySync(f,now-3600000,'corp:user','/brain','self',async rows=>inbox.push(...rows),async a=>{args.push(a);return page([row()],'next-page');});
 assert.equal(await sync.step(now,()=>true),true);
 assert.equal(sync.state.since,now-3600000);assert.equal(sync.state.pending.cursor,'next-page');
 sync=new DingTalkHistorySync(f,now,'corp:user','/brain','self',async rows=>{if(fail)throw Error('disk full');inbox.push(...rows);},async a=>{args.push(a);return page([row('m2')]);});
 await assert.rejects(sync.step(now,()=>true),/disk full/);
 assert.equal(JSON.parse(fs.readFileSync(f)).pending.cursor,'next-page');
 fail=false;assert.equal(await sync.step(now,()=>true),false);assert.equal(sync.state.since,now);
 assert.equal(args[1][args[1].indexOf('--cursor')+1],'next-page');
 await sync.step(now+60000,()=>true);
 assert.equal(args.at(-1)[args.at(-1).indexOf('--start')+1],'2026-10-29 15:50:00');
 assert.equal(inbox.length,3);
});
test('cancelled request and malformed or repeated continuation retain checkpoint',async t=>{
 const f=file(t);let active=true,stores=0;
 const sync=new DingTalkHistorySync(f,now-3600000,'corp:user','/brain','',async()=>stores++,async()=>{active=false;return page();});
 await sync.step(now,()=>active);assert.equal(stores,0);assert.equal(sync.state.since,now-3600000);
 const repeated=new DingTalkHistorySync(f,now,'corp:user','/brain','',async()=>stores++,async()=>page([], '0'));
 await assert.rejects(repeated.step(now,()=>true));assert.equal(stores,0);
 fs.writeFileSync(f,'broken');assert.throws(()=>new DingTalkHistorySync(f,now,'corp:user','/brain','',async()=>{}),/无法读取/);
});

test('self identity requires exact authenticated user and profile, not a matching display name',async()=>{
 const result={resolvedFilters:{senders:[{status:'resolved',profile:'corp:user',selected:{userId:'user',openDingTalkId:'self-open',name:'Owner'}}]}};
 assert.equal(await dingtalkHistorySelf('/brain','corp:user',async()=>result),'self-open');
 result.resolvedFilters.senders[0].selected.userId='someone-else';
 await assert.rejects(dingtalkHistorySelf('/brain','corp:user',async()=>result));
});
