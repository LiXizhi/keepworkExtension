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
    assert.equal(resources.resources.length, 1);
    const read = await client.readResource({ uri: 'keepwork://skills/paracraft-create/SKILL.md' });
    assert.equal(read.contents[0].text, root.content);
    assert.ok(!client.getServerCapabilities().prompts, 'Unneeded prompt advertised');
    const guide = JSON.parse((await call('skill', {path:'references/animation.md'})).content[0].text);
    assert.equal(guide.content, loadCreationGuide().get('references/animation.md'));
    const help = JSON.parse((await call('help', {action:'run_code'})).content[0].text);
    assert.ok(help.inputSchema.properties.code && help.inputSchema.properties.expectedIdentity);
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
