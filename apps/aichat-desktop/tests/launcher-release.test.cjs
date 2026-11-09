const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { plan } = require('../launcher/publish.cjs');
const { installAppPage } = require('../src/launcher-client.cjs');

test('code promotion uploads one app object and reuses all three native descriptors', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-promotion-'));
  t.after(() => fs.rmSync(dir, {recursive:true,force:true}));
  const bytes = Buffer.from('menu update'), sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const app = {version:'1.2.3', size:bytes.length, contract:'a'.repeat(64), sha256};
  fs.writeFileSync(path.join(dir, 'app.json'), JSON.stringify(app));
  fs.writeFileSync(path.join(dir, sha256 + '.zip'), bytes);
  const previous = {sequence:10, platforms:{}};
  for (const target of ['windows-x64','macos-x64','macos-arm64']) previous.platforms[target] = {size:90, sha256:'b'.repeat(64), contract:app.contract};
  const {manifest,uploads} = plan(dir, previous, false, 11);
  assert.deepEqual(manifest.platforms, previous.platforms);
  assert.deepEqual(uploads.map(e=>e.name), [sha256 + '.zip']);
  assert.throws(() => plan(dir, previous, false, 10), /sequence/);
  previous.platforms['windows-x64'].contract = 'c'.repeat(64);
  assert.throws(() => plan(dir, previous, false, 12), /native dependencies/);
});

test('packaged page retains the chat origin, serves only its asset tree and forwards API requests', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-page-'));
  const root = path.join(dir, 'web'); fs.mkdirSync(root);
  fs.mkdirSync(path.join(dir, 'web-libs'));
  fs.writeFileSync(path.join(dir, 'web-libs/assets.json'), '{}');
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'AIChat.html'), '<head></head>');
  fs.writeFileSync(path.join(root,'app.js'), 'hello');
  let handler, forwarded = 0;
  const session = {protocol:{handle:(_,fn)=>handler=fn},fetch:async (_,options)=>{
    assert.equal(options.bypassCustomProtocolHandlers,true);forwarded++;return new Response('network');
  }};
  const online = installAppPage(session, {fetch:url=>new Response(fs.readFileSync(new URL(url)))},root);
  const get = suffix => handler(new Request('https://keepwork.com/'+suffix));
  assert.match(await (await get('chat')).text(), /<base/);
  assert.equal(await (await get('__keepwork_desktop__/app.js')).text(),'hello');
  assert.equal((await get('__keepwork_desktop__/%2E%2E%2Fprivate')).status,404);
  assert.equal(await (await get('api/me')).text(),'network');
  online();assert.equal(await (await get('chat')).text(),'network');assert.equal(forwarded,2);
});
