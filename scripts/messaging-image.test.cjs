const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const Module = require('node:module');
const ts = require('typescript');

function load(relative, mocks = {}, cache = new Map()) {
    const file = path.resolve(__dirname, '../src', relative + '.ts');
    if (cache.has(file)) return cache.get(file).exports;
    const m = new Module(file, module); m.filename = file; m.paths = module.paths; cache.set(file, m);
    m.require = id => {
        if (Object.hasOwn(mocks, id)) return mocks[id];
        if (id.startsWith('.')) {
            const target = path.resolve(path.dirname(file), id);
            if (fs.existsSync(target + '.ts')) return load(path.relative(path.resolve(__dirname, '../src'), target), mocks, cache);
            if (id.endsWith('.cjs')) return require(target);
        }
        return require(id);
    };
    m._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file);
    return m.exports;
}
const images = load('core/messagingImage');
const { DwsError } = load('core/messagingDingtalk');
const { defaultMessageConfig, DEFAULT_PROMPT } = load('core/messagingPolicy');
const png = Buffer.alloc(24); Buffer.from('89504e470d0a1a0a', 'hex').copy(png); png.write('IHDR', 12);
const image = (bytes = png, name = '截图.png', mimeType = 'image/png') => ({ name, mimeType, base64: bytes.toString('base64') });
const incoming = (conversation = 'group', kind = 'group', sender = 'peer') => ({ id: 'in-' + conversation, conversation, kind, sender, text: 'hello', time: Date.now() - 1, direction: 'in' });
function fixture(t, channel = 'dingtalk', fileSystem = fs) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-image-test-'))), root = path.join(dir, 'brain'), home = path.join(dir, 'state');
    fs.mkdirSync(root);
    const calls = [], taskCalls = []; let hook = () => ({ result: { openTaskId: 'task-receipt' } }), taskHook = () => ({});
    const actual = load('core/messagingDingtalk');
    const { MessagingService } = load('core/messaging', {
        'node:fs': fileSystem,
        './messagingDingtalk': { ...actual, DwsError, dws: async (args, cwd) => { if(args[2]==='query-send-status'){taskCalls.push({args,cwd});return taskHook(args,cwd);}calls.push({ args, cwd }); return hook(args, cwd); } },
        './messagingExecutor': { messagingExecutorChoice: () => ({ backend: 'copilot', model: '' }), MessagingWorkers: class { close() {} } },
        './aichatPresence': { latestAichatClient: () => null, latestAichatBrainRoot: () => root },
    });
    const create = () => {
        const service = new MessagingService(home, 8089);
        t.after(() => service.close());
        return service;
    };
    const service = create();
    const binding = service.configure({ channel, root, profile: 'real-corp:real-user', config: defaultMessageConfig(), prompt: DEFAULT_PROMPT });
    const runtime = service.get(binding.id); runtime.binding.agentOwner = 'owner'; runtime.binding.agentId = 'default-persona';
    service.box(binding.id).messages.push(incoming(), incoming('dm', 'direct', 'open-peer'), incoming('other'));
    const reply = (id = 'send-image', conversation = 'group', input = image(), owner = 'owner', agent = 'default-persona') => service.manualImageReply(owner, agent, binding.id, conversation, id, input);
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return { dir, root, home, service, binding, runtime, calls, taskCalls, create, reply, set hook(value) { hook = value; }, set taskHook(value) { taskHook = value; } };
}

test('image receipt correlation keeps task IDs separate and never merges different messages or senders', () => {
    assert.deepEqual(images.imageReceiptIds({result:{openTaskId:'task'}},'group'),{remoteTaskId:'task'});
    assert.deepEqual(images.imageReceiptIds({data:{result:{openMessageId:'remote',openConversationId:'group'}}},'group',true),{remoteMessageId:'remote'});
    for(const value of [{openTaskId:'task'},{openMessageId:'remote'},{openMessageId:'remote',openConversationId:'other'},{arbitrary:{openMessageId:'remote',openConversationId:'group'}}])assert.equal(images.imageReceiptIds(value,'group',true).remoteMessageId,undefined);
    for(const value of [{success:false,openMessageId:'remote'}, {error:{code:'rejected'},result:{openMessageId:'remote'}}, {result:{status:'pending',openMessageId:'remote'}}, {result:{state:'sending',openMessageId:'remote'}}, {status:'failed',result:{openMessageId:'remote'}}]) {
        assert.equal(images.imageSendReceipt(value),false);
        assert.deepEqual(images.imageReceiptIds(value,'group'),{});
    }
    const rows=[{id:'request',conversation:'group',direction:'out',image:{name:'image.png'},remoteMessageId:'remote'},
        {id:'remote',conversation:'group',direction:'out',text:'[文件] image.png fileId: file',state:'synced'},
        {id:'remote',conversation:'group',direction:'in',text:'other sender'},
        {id:'remote',conversation:'other',direction:'out',text:'other conversation'},
        {id:'second',conversation:'group',direction:'out',text:'[文件] image.png fileId: different-file'},
        {id:'remote',conversation:'group',direction:'out',text:'independent local request ID',state:'sent'}];
    assert.deepEqual(images.coalesceImageEchoes(rows),[rows[0],rows[2],rows[3],rows[4],rows[5]]);
    assert.deepEqual(images.imageReceiptIds({openMessageId:'top',result:{openMessageId:'nested',openConversationId:'other-cid'}},'peer',false,0,true),{remoteMessageId:'top'});
});

test('legacy direct sender-key uses the exact send task to retain its actual remote conversation alias', async t => {
    const f=fixture(t),box=f.service.box(f.binding.id);
    box.messages.push(incoming('open-peer','direct','open-peer'));
    f.taskHook=()=>({result:{openMessageId:'direct-image',openConversationId:'actual-direct-cid'}});
    const sent=await f.reply('legacy-direct','open-peer');
    assert.equal(sent.remoteMessageId,'direct-image');assert.equal(sent.remoteConversationId,'actual-direct-cid');
    box.messages.push({id:'direct-image',conversation:'actual-direct-cid',direction:'out',sender:'self',kind:'direct',time:Date.now(),text:'[文件] image.png fileId: exact-file',remoteEvent:true});
    await f.service.resolveImageTasks(f.runtime);
    assert.equal(box.messages.some(row=>row.id==='direct-image'),false);
    assert.equal(box.messages.find(row=>row.id==='legacy-direct').image.name,'截图.png');
});

test('send task resolves the exact remote message and refresh/self events preserve one image bubble across restart', async t => {
    const f=fixture(t);
    f.taskHook=()=>({result:{openMessageId:'remote-image',openConversationId:'group'}});
    const sent=await f.reply();
    assert.equal(sent.remoteTaskId,'task-receipt');assert.equal(sent.remoteMessageId,'remote-image');
    assert.equal(f.taskCalls.length,1);assert.deepEqual(f.taskCalls[0].args.slice(0,5),['chat','message','query-send-status','--open-task-id','task-receipt']);
    assert.equal(f.taskCalls[0].args[f.taskCalls[0].args.indexOf('--profile')+1],f.binding.profile);
    const time=Date.now()-5;
    f.hook=args=>args[0]==='event'?{identity:{corp_id:'real-corp',user_id:'real-user',open_dingtalk_id:'self'}}:
        {success:true,result:{hasMore:false,conversationMessagesList:[{singleChat:false,openConversationId:'group',messages:[{openMessageId:'remote-image',senderOpenDingTalkId:'self',content:'[文件] image.png fileId: same-file',createTime:time}]}]}};
    assert.equal((await f.service.refreshInbox('owner','default-persona',f.binding.id)).imported,0);
    f.runtime.binding.enabled=true;f.runtime.self='self';
    await f.service.receiveOne(f.runtime,{type:'user_im_message_receive_group_all',message_id:'remote-image',conversation_id:'group',sender_open_dingtalk_id:'self',content:'[文件] image.png fileId: same-file',create_time:time});
    const restored=f.create(),rows=restored.inboxView('owner','default-persona',f.binding.id,'group').messages;
    assert.equal(rows.filter(row=>row.image||row.id==='remote-image').length,1);
    assert.equal(rows.find(row=>row.image).id,'send-image');
    assert.equal((await restored.manualImageReply('owner','default-persona',f.binding.id,'group','send-image',image())).remoteMessageId,'remote-image');
    assert.equal(f.calls.filter(call=>call.args[1]==='+messages-send').length,1);
});

test('late task metadata collapses an already synced echo while missing or mismatched metadata preserves sent state', async t => {
    const f=fixture(t);f.taskHook=()=>({result:{openMessageId:'remote-image',openConversationId:'wrong-group'}});
    const sent=await f.reply();assert.equal(sent.state,'sent');assert.equal(sent.remoteMessageId,undefined);
    f.service.box(f.binding.id).messages.push({id:'remote-image',conversation:'group',direction:'out',sender:'self',kind:'group',time:Date.now(),text:'[文件] image.png fileId: same-file',state:'synced'});
    f.taskHook=()=>({result:{openMessageId:'remote-image',openConversationId:'group'}});
    await f.service.resolveImageTasks(f.runtime);
    assert.equal(f.service.box(f.binding.id).messages.filter(row=>row.image||row.id==='remote-image').length,1);
    assert.equal(f.service.box(f.binding.id).messages.find(row=>row.image).state,'sent');
    const restored=f.create();assert.equal(restored.inboxView('owner','default-persona',f.binding.id,'group').messages.some(row=>row.id==='remote-image'),false);
    assert.equal(f.calls.length,1,'only the original send is a mutation');
});

test('image bytes require strict base64, bounded size, safe display name and matching MIME signature', () => {
    const samples = [image(), image(Buffer.from('ffd8ffe0', 'hex'), 'photo.jpg', 'image/jpeg'), image(Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(7)]), 'a.gif', 'image/gif'), image(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]), 'a.webp', 'image/webp')];
    for (const input of samples) assert.equal(images.parseReplyImage(input).metadata.mimeType, input.mimeType);
    for (const input of [null, {}, { ...image(), path: '/tmp/client-file' }, image(png, '../a.png'), image(png, 'C:\\a.png'), image(png, 'a\n.png'), image(png, 'a.png', 'text/plain'), image(png, 'a.jpg', 'image/jpeg'), { ...image(), base64: ' ' + image().base64 }, { ...image(), base64: 'AB==' }, { ...image(), base64: '!!!!' }, image(Buffer.alloc(0)), image(Buffer.alloc(5 * 1024 * 1024 + 1))]) assert.throws(() => images.parseReplyImage(input));
    const maximum = Buffer.alloc(5 * 1024 * 1024); png.copy(maximum);
    assert.equal(images.parseReplyImage(image(maximum)).metadata.size, maximum.length);
});

test('only real message/task receipts acknowledge a successful send', () => {
    for (const receipt of [{ openTaskId: 'task' }, { result: { openMessageId: 'message' } }, { data: { result: { messageId: 'message' } } }]) assert.equal(images.imageSendReceipt(receipt), true);
    for (const receipt of [{}, { success: true }, { data: { dentryId: 'file', spaceId: 'space' } }, { messageId: ' ' }, { openTaskId: 123 }, { arbitrary: { messageId: 'not-send-receipt' } }]) assert.equal(images.imageSendReceipt(receipt), false);
});

test('DingTalk inbox adds attachment capability only to the selected conversation; legacy text response is unchanged', async t => {
    const f = fixture(t), view = f.service.inboxView('owner', 'default-persona', f.binding.id, 'group');
    assert.deepEqual(view.replyImage, images.replyImageCapability);
    assert.equal('replyImage' in f.service.inboxView('owner', 'default-persona', f.binding.id), false);
    f.service.delivery = () => ({ send: async () => {} });
    const text = await f.service.manualReply('owner', 'default-persona', f.binding.id, 'group', 'text', 'unchanged');
    assert.equal(text.text, 'unchanged'); assert.equal(text.state, 'sent'); assert.equal('image' in text, false);
    const feishu = fixture(t, 'feishu');
    assert.equal('replyImage' in feishu.service.inboxView('owner', 'default-persona', feishu.binding.id, 'group'), false);
    await assert.rejects(feishu.reply(), { code: 'UNSUPPORTED_FEATURE' }); assert.equal(feishu.calls.length, 0);
    feishu.runtime.binding.channel = 'future-channel';
    assert.equal('replyImage' in feishu.service.inboxView('owner', 'default-persona', feishu.binding.id, 'group'), false);
    await assert.rejects(feishu.reply(), { code: 'UNSUPPORTED_FEATURE' }); assert.equal(feishu.calls.length, 0);
});

test('attachment uses real binding profile, safe relative temporary file, durable unknown receipt and finally cleanup', async t => {
    const f = fixture(t);
    f.hook = (args, cwd) => {
        assert.equal(cwd, f.root);
        const file = args[args.indexOf('--file') + 1];
        assert.match(file, /^\.keepwork-reply-[A-Za-z0-9]+\/image\.png$/);
        assert.equal(path.isAbsolute(file), false); assert.deepEqual(fs.readFileSync(path.join(cwd, file)), png);
        if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(cwd, file)).mode & 0o777, 0o600);
        assert.deepEqual(args.slice(0, 8), ['chat', '+messages-send', '--as', 'user', '--group', 'group', '--msg-type', 'file']);
        assert.equal(args[args.indexOf('--profile') + 1], 'real-corp:real-user');
        assert.equal(args[args.indexOf('--idempotency-key') + 1], 'send-image-image');
        const disk = JSON.parse(fs.readFileSync(path.join(f.home, 'inbox.json')))[f.binding.id];
        assert.equal(disk.sends['send-image'], 'unknown'); assert.equal(disk.messages.at(-1).state, 'sending');
        assert.doesNotMatch(JSON.stringify(disk), /base64|keepwork-reply-|image\.png/);
        return { result: { openTaskId: 'accepted' } };
    };
    const result = await f.reply('send-image', 'group', image(png, 'CON.png'));
    assert.equal(result.state, 'sent'); assert.equal(result.image.name, 'CON.png'); assert.equal(result.image.transport, 'file');
    assert.equal(result.image.size, png.length); assert.match(result.image.sha256, /^[a-f0-9]{64}$/);
    assert.equal(f.service.box(f.binding.id).paused.includes('group'), true);
    assert.equal(fs.readdirSync(f.root).some(name => name.startsWith('.keepwork-reply-')), false);
    const restored = f.create();
    assert.equal(restored.inboxView('owner', 'default-persona', f.binding.id, 'group').messages.at(-1).image.name, 'CON.png');
    assert.equal((await restored.manualImageReply('owner', 'default-persona', f.binding.id, 'group', 'send-image', image(png, 'CON.png'))).state, 'sent');
    assert.equal(f.calls.length, 1);
});

test('direct attachment targets the inbound open DingTalk sender and never the conversation ID', async t => {
    const f = fixture(t); const result = await f.reply('direct', 'dm');
    assert.equal(result.state, 'sent'); assert.deepEqual(f.calls[0].args.slice(4, 6), ['--open-dingtalk-id', 'open-peer']);
    assert.equal(f.calls[0].args.includes('--group'), false);
});

test('preflight rejects ownership, routing, stopped service and invalid images without reserving request IDs', async t => {
    const f = fixture(t);
    await assert.rejects(f.reply('bad', 'group', image(png, '../escape.png')));
    await assert.rejects(f.reply('bad', 'group', image(), 'stranger'));
    await assert.rejects(f.reply('bad', 'missing'));
    assert.equal(f.service.box(f.binding.id).sends?.bad, undefined);
    assert.equal((await f.reply('bad')).state, 'sent');
    f.service.close(); await assert.rejects(f.reply('closed'), /停止/);
    assert.equal(f.service.box(f.binding.id).sends.closed, undefined); assert.equal(f.calls.length, 1);
});

test('assigned empty group attachments use existing manual reply routing, removed group cannot send', async t => {
    const f = fixture(t), agent = { owner: 'owner', id: 'lily', name: 'Lily', root: f.root, prompt: 'Assistant', messaging: { version: 1, enabled: false, groups: [{ channel: 'dingtalk', account: f.binding.profile, id: 'empty', name: 'Empty' }] } };
    f.runtime.binding.peers = [{ owner: 'owner', agentId: 'lily' }]; f.service.setMessageAgents(() => [agent]);
    const result = await f.reply('assigned', 'empty', image(), 'owner', 'lily'); assert.equal(result.state, 'sent');
    assert.deepEqual(f.calls[0].args.slice(4, 6), ['--group', 'empty']);
    await assert.rejects(f.reply('foreign-group', 'group', image(), 'owner', 'lily'), /未分配/);
    agent.messaging.groups = []; await assert.rejects(f.reply('removed', 'empty', image(), 'owner', 'lily'), /未分配/);
    assert.equal(f.calls.length, 1);
});

test('concurrent replay and changed payload/conversation cannot dispatch twice; unknown survives restart and clear', async t => {
    const f = fixture(t); let finish; f.hook = () => new Promise(resolve => { finish = resolve; });
    const sending = f.reply();
    assert.equal((await f.reply()).state, 'unknown');
    await assert.rejects(f.reply('send-image', 'other'), /其他内容/);
    await assert.rejects(f.reply('send-image', 'group', image(png, 'renamed.png')), /其他内容/);
    const changed = Buffer.from(png); changed[23] = 1;
    await assert.rejects(f.reply('send-image', 'group', image(changed)), /其他内容/);
    finish({ data: { dentryId: 'only-an-upload' } }); assert.equal((await sending).state, 'unknown');
    const restored = f.create(); assert.equal((await restored.manualImageReply('owner', 'default-persona', f.binding.id, 'group', 'send-image', image())).state, 'unknown');
    restored.inboxAction('owner', 'default-persona', f.binding.id, 'group', 'clear');
    await assert.rejects(restored.manualImageReply('owner', 'default-persona', f.binding.id, 'group', 'send-image', image()), /已使用/);
    assert.equal(f.calls.length, 1);
});

test('positive rejection is failed, uncertain or missing receipts are unknown, errors never echo CLI detail', async t => {
    const f = fixture(t);
    for (const [id, response, expected] of [['reject', new DwsError(false, { token: 'SECRET' }), 'failed'], ['uncertain', new DwsError(true, { token: 'SECRET' }), 'unknown'], ['empty', {}, 'unknown'], ['upload', { data: { dentryId: 'file', spaceId: 'space' } }, 'unknown']]) {
        f.hook = () => { if (response instanceof Error) throw response; return response; };
        const result = await f.reply(id); assert.equal(result.state, expected); assert.ok(result.error);
        assert.doesNotMatch(JSON.stringify(result), /SECRET|token|base64/);
        await f.reply(id); assert.equal(f.calls.length, ['reject', 'uncertain', 'empty', 'upload'].indexOf(id) + 1);
        assert.equal(fs.readdirSync(f.root).some(name => name.startsWith('.keepwork-reply-')), false);
    }
});

test('ledger write failure cannot invoke CLI, consumes no ID and removes temporary image', async t => {
    const f = fixture(t), disk = path.join(f.home, 'inbox.json');
    fs.mkdirSync(disk); await assert.rejects(f.reply(), /无法保存发送状态/);
    assert.equal(f.calls.length, 0); assert.equal(f.service.box(f.binding.id).sends?.['send-image'], undefined);
    assert.equal(f.service.box(f.binding.id).paused.includes('group'), false);
    assert.equal(fs.readdirSync(f.root).some(name => name.startsWith('.keepwork-reply-')), false);
    fs.rmdirSync(disk); assert.equal((await f.reply()).state, 'sent');
});

test('failed fsync prevents dispatch, and failed final receipt save preserves restart-safe unknown state', async t => {
    let rejectSync = false, rejectFinalRename = false;
    const fileSystem = { ...fs,
        fsyncSync(fd) { if (rejectSync) throw Error('fixture sync failure'); return fs.fsyncSync(fd); },
        renameSync(from, to) { if (rejectFinalRename && path.basename(from).startsWith('inbox-image-')) throw Error('fixture final save failure'); return fs.renameSync(from, to); },
    };
    const f = fixture(t, 'dingtalk', fileSystem);
    rejectSync = true; await assert.rejects(f.reply(), /无法保存发送状态/);
    assert.equal(f.calls.length, 0); assert.equal(f.service.box(f.binding.id).sends?.['send-image'], undefined);
    rejectSync = false; f.hook = () => { rejectFinalRename = true; return { messageId: 'known-sent' }; };
    assert.equal((await f.reply()).state, 'sent');
    const restored = f.create();
    assert.equal((await restored.manualImageReply('owner', 'default-persona', f.binding.id, 'group', 'send-image', image())).state, 'unknown');
    assert.equal(f.calls.length, 1);
});

test('four pending attachments bound CLI concurrency; rejected fifth ID can be used after one completes', async t => {
    const f = fixture(t), finish = []; f.hook = () => new Promise(resolve => finish.push(resolve));
    const sends = Array.from({ length: 4 }, (_, index) => f.reply('parallel-' + index));
    assert.equal(f.calls.length, 4);
    await assert.rejects(f.reply('fifth'), /繁忙/); assert.equal(f.service.box(f.binding.id).sends.fifth, undefined);
    finish[0]({ openTaskId: 'first' }); await sends[0];
    const fifth = f.reply('fifth'); assert.equal(f.calls.length, 5);
    for (const resolve of finish.slice(1)) resolve({ openMessageId: 'accepted' });
    await Promise.all([...sends.slice(1), fifth]);
    assert.equal(fs.readdirSync(f.root).some(name => name.startsWith('.keepwork-reply-')), false);
});

for (const change of ['close', 'gateway', 'profile', 'owner', 'scope']) test('permission change during gateway renewal blocks attachment before ledger: ' + change, async t => {
    const f = fixture(t); let release, active = true;
    f.service.coordinationEnabled.owner = true;
    f.service.ownerCoordinators.set('owner', { canRun: () => active, snapshot: () => ({ online: true }), request: () => new Promise(resolve => { release = resolve; }) });
    const sending = f.reply();
    if (change === 'close') f.service.close();
    if (change === 'gateway') active = false;
    if (change === 'profile') f.runtime.binding.profile = 'real-corp:other';
    if (change === 'owner') f.runtime.binding.agentOwner = 'stranger';
    if (change === 'scope') { f.runtime.binding.agentId = 'agent'; }
    release({}); await assert.rejects(sending);
    assert.equal(f.calls.length, 0); assert.equal(f.service.box(f.binding.id).sends?.['send-image'], undefined);
    assert.equal(fs.readdirSync(f.root).some(name => name.startsWith('.keepwork-reply-')), false);
});

test('dedicated HTTP image route alone accepts large JSON; legacy route, ownership and unsupported route behavior remain bounded', async t => {
    const { handlePersonaHttp } = load('mcp/personaHttp'), calls = [];
    const personas = { read: (_owner, id) => { if (id === 'foreign') throw Error('Agent owner mismatch'); return { id }; } };
    const messaging = { manualImageReply: async (...args) => { calls.push(args); return { id: args[4], state: 'sent', image: { name: args[5].name } }; }, manualReply: async () => ({ id: 'legacy', text: 'hello', state: 'sent' }) };
    const send = async (route, body) => {
        const req = Readable.from([Buffer.from(JSON.stringify(body))]);
        req.method = 'POST'; req.headers = { origin: 'https://keepwork.com', 'x-agent-owner': 'a'.repeat(48), 'content-type': 'application/json' };
        let status, result;
        const res = { setHeader() {}, writeHead(value) { status = value; }, end(value) { result = JSON.parse(value); } };
        await handlePersonaHttp(req, res, new URL('/agents/personas' + route, 'http://127.0.0.1'), personas, messaging);
        return { status, json: async () => result };
    };
    const maximum = Buffer.alloc(5 * 1024 * 1024); png.copy(maximum);
    const body = { binding: 'real', conversation: 'group', requestId: 'image-request', image: image(maximum) };
    let response = await send('/agent/reply-image', body); assert.equal(response.status, 200); assert.equal((await response.json()).state, 'sent'); assert.equal(calls.length, 1); assert.deepEqual(calls[0].slice(1), ['agent', 'real', 'group', 'image-request', body.image]);
    response = await send('/agent/reply', { ...body, text: 'too big for legacy' }); assert.equal(response.status, 400); assert.match((await response.json()).error, /too large/); assert.equal(calls.length, 1);
    response = await send('/agent/reply-image', { ...body, image: { ...body.image, base64: 'a'.repeat(7 * 1024 * 1024 + 65536) } }); assert.equal(response.status, 400); assert.match((await response.json()).error, /too large/); assert.equal(calls.length, 1);
    response = await send('/foreign/reply-image', { ...body, image: image() }); assert.equal(response.status, 400); await response.json(); assert.equal(calls.length, 1);
    response = await send('/agent/reply-image-extra', { image: image() }); assert.equal(response.status, 404); assert.equal((await response.json()).code, 'UNSUPPORTED_FEATURE');
    response = await send('/agent/reply', { text: 'hello' }); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { id: 'legacy', text: 'hello', state: 'sent' });
});
