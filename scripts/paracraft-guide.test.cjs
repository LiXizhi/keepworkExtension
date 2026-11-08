const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);
const { registerCreationGuide, loadCreationGuide, readCreationGuide } = require('../src/mcp/paracraftGuide.ts');
const { createMcpServer } = require('../src/mcp/server.ts');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

test('all local skill links resolve and files fit transport limits', () => {
  const files = loadCreationGuide();
  assert.ok(files.has('SKILL.md') && files.has('examples/idle-wave.lua'));
  for (const [file, content] of files) {
    for (const match of content.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
      if (/^https?:/.test(match[1])) continue;
      assert.ok(files.has(path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]))), `${file}: broken link ${match[1]}`);
    }
  }
});

test('one CLI and one root skill, with schemas and references loaded on demand', async () => {
  const server = createMcpServer({port:8089,root:process.cwd(),requireAuth:false,startedAt:new Date().toISOString()});
  const client = new Client({ name: 'guide-client', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);await client.connect(b);
  try {
    const listed = (await client.listTools()).tools.filter(t => t.name.startsWith('paracraft_'));
    assert.deepEqual(listed.map(t => t.name), ['paracraft_cli']);
    assert.ok(JSON.stringify(listed[0].inputSchema).length < 1200, 'Gateway eagerly advertises action schemas');
    const call = (action, params) => client.callTool({ name: 'paracraft_cli', arguments: { action, params } });
    const root = JSON.parse((await call('skill')).content[0].text);
    assert.equal(root.files, undefined, 'Skill read dumps the whole file index');
    const resources = await client.listResources();
    assert.equal(resources.resources.filter(r => r.uri.startsWith('keepwork://skills/paracraft-create/')).length, 1);
    assert.ok(!resources.resources.some(r => r.uri.startsWith('keepwork://skills/agent-cli-verify/')));
    const read = await client.readResource({ uri: 'keepwork://skills/paracraft-create/SKILL.md' });
    assert.equal(read.contents[0].text, root.content);
    assert.ok(!client.getServerCapabilities().prompts, 'Unneeded prompt advertised');
    const guide = JSON.parse((await call('skill', {path:'references/animation.md'})).content[0].text);
    assert.equal(guide.content, loadCreationGuide().get('references/animation.md'));
    const help = JSON.parse((await call('help', {action:'run_code'})).content[0].text);
    assert.ok(help.inputSchema.properties.code && help.inputSchema.properties.expectedIdentity);
    const creation = JSON.parse((await call('help', {action:'place_block_shapes'})).content[0].text);
    assert.ok(creation.inputSchema.required.includes('worldPath'));
    const { executeAuthoring } = require('../src/core/paracraftAuthoring.ts');
    const unexpected = () => assert.fail('Invalid request reached the engine');
    await assert.rejects(executeAuthoring('open_blank_world', {name:''}, unexpected), /Invalid authoring arguments/);
    await assert.rejects(executeAuthoring('place_block_shapes', {}, unexpected), /Invalid authoring arguments/);
    const launchHelp = JSON.parse((await call('help', {action:'launch'})).content[0].text);
    assert.ok(launchHelp.inputSchema.properties.projectId);
    assert.ok(!launchHelp.inputSchema.required?.includes('waitSeconds'));
    assert.ok(!launchHelp.inputSchema.required?.includes('projectId'));
    assert.equal((await call('launch',{projectId:'530 & calc'})).isError,true);
    assert.equal((await call('skill', {path:'../../package.json'})).isError, true);
    assert.equal((await call('not_an_action')).isError, true);
    assert.equal((await call('run_code', {code:'return 1'})).isError, true);
  } finally { await client.close();await server.close(); }
});


test('one guide read performs one file read and no catalog scan', () => {
  const originalRead=fs.readFileSync, originalList=fs.readdirSync;
  const reads=[];
  fs.readFileSync=(file,...args)=>{reads.push(String(file));return originalRead(file,...args);};
  fs.readdirSync=()=>{throw new Error('Runtime guide request enumerated the catalog');};
  try {
    const guide=readCreationGuide('references/vegetation.md');
    assert.match(guide.content,/Trees, flowers and grass/);
    assert.equal(reads.length,1);
    assert.ok(reads[0].replace(/\\/g,'/').endsWith('/references/vegetation.md'));
    for (const invalid of ['../SKILL.md','references/../SKILL.md','/SKILL.md',
      'C:/SKILL.md','references\\vegetation.md','references/missing.md','package.json']) {
      assert.throws(()=>readCreationGuide(invalid),/unknown_guide/);
    }
    assert.equal(reads.length,1,'Rejected guide read touched content');
  } finally {fs.readFileSync=originalRead;fs.readdirSync=originalList;}
});

test('Web authoring pins the HTTP tunnel to the selected engine before executing Lua', async () => {
  const { registerClient, unregisterClient, dispatchAction, pollJobs, completeJob } = require('../src/core/paracraftClients.ts');
  const id = 'wasm-authoring-test', worldPath = '/worlds/Example/';
  await registerClient({ clientId: id, platform: 'wasm' });
  async function reply(action, result, clientId = id) {
    const [job] = await pollJobs(id, 500);
    assert.equal(job.request.action, 'http_request');
    const params = job.request.params;
    assert.equal(params.path, '/ajax/paracraft_cli');
    const request = JSON.parse(Buffer.from(params.bodyBase64, 'base64').toString('utf8'));
    assert.equal(request.action, action);
    const body = JSON.stringify({ clientId, ok: true, result });
    completeJob(id, job.jobId, { result: { status: 200, bodyBase64: Buffer.from(body).toString('base64') } });
    return request.params;
  }
  try {
    const args = { worldPath, name: 'Bird' };
    const success = dispatchAction(id, 'sample_actor', args);
    await reply('world_files', { identity: { worldPath, sessionId: 8 } });
    const execution = await reply('run_npl_code', { result: { found: true } });
    assert.match(execution.code, /sample_actor/);
    assert.equal((await success).body.result.found, true);
    const mismatch = dispatchAction(id, 'sample_actor', args);
    await reply('world_files', { identity: { worldPath, sessionId: 8 } }, 'unrelated-client');
    assert.match((await mismatch).body.error, /client changed/);
  } finally { unregisterClient(id); }
});

test('a browser relays single-use engine steps while the server owns the model operation', async () => {
  const { advanceWebAuthoring } = require('../src/core/paracraftAuthoring.ts');
  const clientId = 'iframe', worldPath = '/worlds/test/';
  const args = { worldPath, name:'Gull' };
  const first = await advanceWebAuthoring({clientId, name:'sample_actor', args});
  assert.equal(first.action, 'world_files');
  assert.throws(() => advanceWebAuthoring({clientId:'other', ticket:first.ticket}), /mismatched/);
  const second = await advanceWebAuthoring({clientId, ticket:first.ticket, reply:{ok:true,result:{identity:{sessionId:1,worldPath}}}});
  assert.equal(second.action, 'run_npl_code');
  assert.throws(() => advanceWebAuthoring({clientId, ticket:first.ticket}), /Expired/);
  const last = await advanceWebAuthoring({clientId, ticket:second.ticket, reply:{ok:true,result:{result:{found:false}}}});
  assert.deepEqual(last,{done:true,result:{found:false}});
});
