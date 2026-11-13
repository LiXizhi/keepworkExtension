const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);

function listen(server) {
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
}
function close(server) {
  server.closeAllConnections();
  return new Promise(resolve => server.close(resolve));
}

test('real macOS WK handler reaches only the owned MCP endpoint and preserves streaming/legacy contracts', {
  skip: process.platform !== 'darwin', timeout: 60000,
}, async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-native-mcp-'));
  const requests = [], forbidden = [], slowClosed = [];
  let allowedPort, forbiddenPort;
  const denied = http.createServer((req, res) => { forbidden.push(req.url); res.end('unexpected redirect'); });
  const allowed = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push({ path: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks) });
    const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://keepwork.com', 'Cache-Control': 'no-store', 'Access-Control-Expose-Headers': 'Mcp-Session-Id, MCP-Protocol-Version' };
    if (req.url === '/redirect') { res.writeHead(302, { ...headers, Location: `http://127.0.0.1:${forbiddenPort}/leaked` }); res.end(); return; }
    if (req.url === '/401') { res.writeHead(401, { ...headers, 'WWW-Authenticate': 'Bearer realm=fixture' }); res.end(JSON.stringify({ error: 'fixture authentication required' })); return; }
    if (req.url.startsWith('/challenge-')) { const scheme = req.url.slice('/challenge-'.length); const challenge = scheme === 'digest' ? 'Digest realm=fixture, nonce=fixture-nonce, qop=auth' : scheme === 'ntlm' ? 'NTLM' : 'Basic realm=fixture'; res.writeHead(401, { ...headers, 'WWW-Authenticate': challenge }); res.end(JSON.stringify({ error: 'fixture system authentication required' })); return; }
    if (req.url === '/no-cors') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); return; }
    if (req.url === '/stream') {
      res.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream' });
      res.write('event: changed\ndata: {"agents":[]}\n\n');
      const timer = setTimeout(() => res.end('{"cursor":1,"text":"你好"}\n'), 25);
      res.on('close', () => clearTimeout(timer)); return;
    }
    if (req.url === '/slow') {
      res.writeHead(200, { ...headers, 'Content-Type': 'application/x-ndjson' }); res.write('first\n');
      const timer = setInterval(() => res.write('later\n'), 1000);
      res.on('close', () => { clearInterval(timer); slowClosed.push(true); }); return;
    }
    if (req.url === '/health') { res.writeHead(200, headers); res.end(JSON.stringify({ ok: true, name: 'keepwork-mcp', version: '0.1.2', personasApi: 'personas-v1' })); return; }
    if (req.url === '/agents/personas') { res.writeHead(200, headers); res.end(JSON.stringify({ agents: [{ id: 'default-persona', name: '我的分身', messages: [] }] })); return; }
    if (req.url === '/legacy-mcp') { res.writeHead(200, { ...headers, 'Mcp-Session-Id': 'legacy-session', 'Set-Cookie': 'fixture-secret=hidden', 'X-Internal-Secret': 'hidden' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05', capabilities: {} } })); return; }
    res.writeHead(200, headers); res.end(JSON.stringify({ ok: true, body: Buffer.concat(chunks).toString('base64') }));
  });
  try {
    forbiddenPort = await listen(denied); allowedPort = await listen(allowed);
    const executable = path.join(temporary, 'native-mcp');
    const compiled = await execute('clang', ['-fobjc-arc', '-framework', 'AppKit', '-framework', 'WebKit',
      `-DKEEPWORK_LOCAL_MCP_TEST_PORT=${allowedPort}`, path.join(__dirname, 'fixtures/local_mcp_macos.m'), '-o', executable], { timeout: 20000 });
    assert.equal(compiled.stderr, '', 'real native fixture compiles without warnings');
    const prelude = `const base='http://localhost:${allowedPort}',other='http://127.0.0.1:${forbiddenPort}';
      const handler=window.webkit.messageHandlers.keepworkLocalMcp;
      const document=crypto.randomUUID();
      const post=(op,id,extra={})=>handler.postMessage({op,id,document,...extra});
      const start=(url,extra={})=>{const id=crypto.randomUUID();return post('start',id,{url,method:'GET',headers:[],body:null,...extra}).then(meta=>({id,meta}));};
      const readAll=async id=>{let output='';for(let n=0;n<300;n++){const r=await post('read',id);if(r.done)return output;output+=atob(r.data);}throw Error('unbounded fixture reads');};
      const rejects=async action=>{try{await action();return false;}catch{return true;}};`;
    const script = prelude + `
      const binary=btoa(String.fromCharCode(0,1,127,128,255));
      const echo=await start(base+'/echo',{method:'POST',headers:[['Authorization','Bearer fixture-only'],['X-Agent-Owner','a'.repeat(32)]],body:binary});
      const echoBody=JSON.parse(await readAll(echo.id));
      const legacy=await start(base+'/legacy-mcp',{method:'POST',headers:[['Content-Type','application/json'],['MCP-Protocol-Version','2024-11-05']],body:btoa(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{}}}))});
      const legacyBody=JSON.parse(await readAll(legacy.id));
      const stream=await start(base+'/stream');const streamed=await readAll(stream.id);
      const slow=await start(base+'/slow');await post('read',slow.id);const waiting=post('read',slow.id).then(()=>false,()=>true);await post('cancel',slow.id);const cancelled=await waiting;await post('cancel',slow.id);
      const blocked=[];
      for(const url of [other+'/wrong-port','https://localhost:${allowedPort}/wrong-scheme','http://user:secret@localhost:${allowedPort}/credential','http://example.invalid:${allowedPort}/outside'])blocked.push(await rejects(()=>start(url)));
      const headersBlocked=[];for(const name of ['Origin','Host','Cookie'])headersBlocked.push(await rejects(()=>start(base+'/forged-header',{headers:[[name,'forged']]})));
      const malformedHeaders=[];for(const headers of [[['bad:name','value']],[['X-Fixture',String.fromCharCode(0)]]])malformedHeaders.push(await rejects(()=>start(base+'/forged-header',{headers})));
      const unauthorized=await start(base+'/401',{method:'POST',headers:[['Content-Type','application/json']],body:btoa('{}')});const authBody=JSON.parse(await readAll(unauthorized.id));
      const unsupportedChallenges=[];for(const scheme of ['basic','digest','ntlm']){try{await start(base+'/challenge-'+scheme,{method:'POST',headers:[['Content-Type','application/json']],body:btoa('{}')});unsupportedChallenges.push(false);}catch(error){unsupportedChallenges.push(String(error).includes('MCP_HTTP_AUTH_CHALLENGE_UNSUPPORTED'));}}
      const redirectRejected=await rejects(()=>start(base+'/redirect'));
      const corsRejected=await rejects(()=>start(base+'/no-cors'));
      const badDocument=await rejects(()=>handler.postMessage({op:'read',id:crypto.randomUUID(),document:crypto.randomUUID()}));
      const iframeDenied=await new Promise(resolve=>{const frame=window.document.createElement('iframe');const listener=e=>{if(e.source===frame.contentWindow&&e.data?.fixtureDenied!==undefined){window.removeEventListener('message',listener);frame.remove();resolve(e.data.fixtureDenied);}};window.addEventListener('message',listener);frame.srcdoc='<script>window.webkit.messageHandlers.keepworkLocalMcp.postMessage('+JSON.stringify({op:'start',id:crypto.randomUUID(),document,url:base+'/iframe',method:'GET',headers:[],body:null})+').then(()=>parent.postMessage({fixtureDenied:false},"*"),()=>parent.postMessage({fixtureDenied:true},"*"));<\/script>';window.document.body.append(frame);});
      return {echo:echoBody,legacy:legacyBody,legacyHeaders:legacy.meta.headers,streamed,cancelled,blocked,headersBlocked,malformedHeaders,unauthorizedStatus:unauthorized.meta.status,authBody,unsupportedChallenges,redirectRejected,corsRejected,badDocument,iframeDenied};`;
    const scriptFile = path.join(temporary, 'scenario.js'); fs.writeFileSync(scriptFile, script);
    const result = await execute(executable, [scriptFile, 'https://keepwork.com/chat'], { timeout: 40000 });
    const output = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(output.echo.body, Buffer.from([0, 1, 127, 128, 255]).toString('base64'));
    assert.equal(output.legacy.result.protocolVersion, '2024-11-05');
    assert.equal(new Headers(output.legacyHeaders).get('mcp-session-id'), 'legacy-session');
    assert.equal(new Headers(output.legacyHeaders).get('set-cookie'), null);
    assert.equal(new Headers(output.legacyHeaders).get('x-internal-secret'), null);
    assert.equal(output.streamed, Buffer.from('event: changed\ndata: {"agents":[]}\n\n{"cursor":1,"text":"你好"}\n').toString('binary'));
    assert.equal(output.cancelled, true);
    assert.deepEqual(output.blocked, [true, true, true, true]);
    assert.deepEqual(output.headersBlocked, [true, true, true]);
    assert.deepEqual(output.malformedHeaders, [true, true]);
    assert.equal(output.unauthorizedStatus, 401, 'HTTP auth errors remain HTTP responses without system credentials');
    assert.equal(output.authBody.error, 'fixture authentication required');
    assert.equal(requests.filter(value => value.path === '/401').length, 1, 'Bearer authentication error never replays the request');
    assert.deepEqual(output.unsupportedChallenges, [true, true, true], 'system authentication challenges fail explicitly');
    for (const scheme of ['basic', 'digest', 'ntlm']) assert.equal(requests.filter(value => value.path === '/challenge-' + scheme).length, 1, scheme + ' challenge never replays the mutation');
    for (const key of ['redirectRejected', 'corsRejected', 'badDocument', 'iframeDenied']) assert.equal(output[key], true, key);
    const echo = requests.find(value => value.path === '/echo');
    assert.equal(echo.headers.origin, 'https://keepwork.com');
    assert.equal(echo.headers.authorization, 'Bearer fixture-only');
    assert.equal(echo.headers['x-agent-owner'], 'a'.repeat(32));
    assert.deepEqual(echo.body, Buffer.from([0, 1, 127, 128, 255]));
    assert.equal(forbidden.length, 0, 'wrong-port requests and redirects never reach the other mock');
    assert.equal(requests.filter(value => ['/iframe', '/forged-header'].includes(value.path)).length, 0);
    assert.equal(slowClosed.length, 1, 'native cancellation closes the owned stream');
    // Run the shipped shim and real native handler together. Only the test
    // copy's fixed endpoint port changes; the production source stays intact.
    const shim = fs.readFileSync(path.join(__dirname, '../src/localMcpFetch.js'), 'utf8')
      .replace('export function installLocalMcpFetch', 'function installLocalMcpFetch')
      .replace(/"8089"/g, JSON.stringify(String(allowedPort)));
    const integratedFile = path.join(temporary, 'integrated.js');
    fs.writeFileSync(integratedFile, shim + `
      installLocalMcpFetch({platform:'darwin',entryUrl:'https://keepwork.com/chat'});
      const base='http://localhost:${allowedPort}';
      const health=await(await window.fetch(base+'/health',{targetAddressSpace:'loopback'})).json();
      const personas=await(await window.fetch('http://127.0.0.1:${allowedPort}/agents/personas',{headers:{'X-Agent-Owner':'b'.repeat(32)}})).json();
      const mcp=await window.fetch(new Request(base+'/legacy-mcp',{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{}}})}));
      const session=mcp.headers.get('mcp-session-id');const initialized=await mcp.json();
      const stream=await window.fetch(base+'/stream');const text=await stream.text();
      const controller=new AbortController();const slow=await window.fetch(base+'/slow',{signal:controller.signal});const reader=slow.body.getReader();await reader.read();const pending=reader.read().then(()=>false,error=>error.name==='AbortError');controller.abort();const aborted=await pending;
      return {health,personas,session,initialized,text,aborted};`);
    const integrated = await execute(executable, [integratedFile, 'https://keepwork.com/chat'], { timeout: 15000 });
    const endToEnd = JSON.parse(integrated.stdout.trim().split('\n').at(-1));
    assert.equal(endToEnd.health.ok, true);
    assert.equal(endToEnd.health.runtimeVersion, undefined, 'an old health contract does not prevent transport');
    assert.equal(endToEnd.personas.agents[0].id, 'default-persona');
    assert.equal(endToEnd.session, 'legacy-session');
    assert.equal(endToEnd.initialized.result.protocolVersion, '2024-11-05');
    assert.equal(endToEnd.text, 'event: changed\ndata: {"agents":[]}\n\n{"cursor":1,"text":"你好"}\n');
    assert.equal(endToEnd.aborted, true);
    assert.equal(requests.filter(value => value.path === '/legacy-mcp').length, 2, 'each handwritten and integrated mutation runs exactly once');
    assert.equal(requests.find(value => value.path === '/agents/personas').headers['x-agent-owner'], 'b'.repeat(32));
    const untrustedFile = path.join(temporary, 'untrusted.js');
    fs.writeFileSync(untrustedFile, prelude + `return {denied:await rejects(()=>start(base+'/untrusted'))};`);
    for (const url of ['https://evil.example/chat', 'https://keepwork.com/chat%2F']) {
      const untrusted = await execute(executable, [untrustedFile, url], { timeout: 10000 });
      assert.equal(JSON.parse(untrusted.stdout.trim()).denied, true, url);
    }
    assert.equal(requests.some(value => value.path === '/untrusted'), false);
  } finally {
    await Promise.all([close(allowed), close(denied)]);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
