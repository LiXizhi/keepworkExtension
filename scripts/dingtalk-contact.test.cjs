const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

function load() {
    const file = path.resolve(__dirname, '../src/core/messagingDingtalk.ts');
    const m = new Module(file, module);
    m.filename = file;
    m.paths = module.paths;
    m.require = id => {
        if (id === './messagingPolicy') return { splitReply: text => [text], automatedSender: () => false, automatedText: () => false };
        if (id === './cliPaths') return { cliSearchDirs: () => [], globalModuleDirs: () => [], cliChildEnv: () => ({}) };
        return require(id);
    };
    m._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
    return m.exports;
}

const { parseDingTalkContacts, deliverDingTalkContact } = load();

test('contact search keeps only identifiable candidates and rejects a failed envelope', () => {
    const contacts = parseDingTalkContacts({ success: true, result: [
        { name: '欧阳', title: '运维', userId: 'u1', openDingTalkId: 'DFT6ar4g5iPU2ob7vdqlZuIB' },
        { name: '缺身份', openDingTalkId: 'short' },
        { nick: '只有昵称', openDingtalkId: 'nick-id-12345678' },
    ]});
    assert.deepEqual(contacts, [
        { id: 'DFT6ar4g5iPU2ob7vdqlZuIB', name: '欧阳', title: '运维', userId: 'u1' },
        { id: 'nick-id-12345678', name: '只有昵称', title: '', userId: '' },
    ]);
    assert.throws(() => parseDingTalkContacts({ success: false, result: [] }), /搜索失败/);
    assert.throws(() => parseDingTalkContacts({ success: true }), /无法识别/);
});

test('contact delivery verifies identity, waits for SUCCESS, and does not resend the same request', async () => {
    const calls = [];
    const call = async args => {
        calls.push(args);
        if (args[0] === 'event') return { identity: { corp_id: 'corp', user_id: 'user' } };
        if (args.includes('+messages-send')) return { result: { openTaskId: 'task-1' } };
        const polls = calls.filter(item => item.includes('query-send-status')).length;
        return { result: { sendStatus: polls > 1 ? 'SUCCESS' : 'PENDING' } };
    };
    const input = { root: 'E:\\brain', profile: 'corp:user', contactId: 'DFT6ar4g5iPU2ob7vdqlZuIB', text: '好的', requestId: 'dm-1' };
    const receipt = await deliverDingTalkContact(input, call, async () => {});
    assert.deepEqual(receipt, { state: 'sent', retried: false });
    const send = calls.find(args => args[1] === '+messages-send');
    assert.equal(send[send.indexOf('--open-dingtalk-id') + 1], input.contactId);
    assert.equal(send[send.indexOf('--text') + 1], '好的');
    assert.equal(send.at(-1), '--yes');
    const again = await deliverDingTalkContact(input, call, async () => {});
    assert.equal(again.state, 'sent');
    assert.equal(again.retried, true);
    assert.equal(again.error, undefined);
    assert.equal(calls.filter(args => args[1] === '+messages-send').length, 1);
    await assert.rejects(deliverDingTalkContact({ ...input, profile: 'other:user', requestId: 'dm-2' }, async () => ({ identity: { corp_id: 'corp', user_id: 'user' } })), /identity/);
});
