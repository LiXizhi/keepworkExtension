const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const ts = require('typescript');
const oldLoader = require.extensions['.ts'];
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, file);
const { handleModelStudioUpload, allowedModelStudioTarget } = require('../src/core/modelStudioUpload.ts');

test('upload target allowlist excludes inference, private addresses, credentials and redirects', () => {
    assert.equal(allowedModelStudioTarget(new URL('https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model=qwen3.8-omni-flash'), 'GET'), true);
    assert.equal(allowedModelStudioTarget(new URL('https://dashscope-intl.aliyuncs.com/api/v1/uploads?action=getPolicy&model=qwen3-vl-plus'), 'GET'), true);
    assert.equal(allowedModelStudioTarget(new URL('https://bucket.oss-cn-beijing.aliyuncs.com/'), 'POST'), true);
    for (const url of ['http://127.0.0.1/', 'https://bucket.oss-cn-beijing-internal.aliyuncs.com/', 'https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&action=delete&model=x', 'https://169.254.169.254/', 'https://dashscope.aliyuncs.com.attacker.test/api/v1/uploads?action=getPolicy&model=x', 'https://u:p@bucket.oss-cn-beijing.aliyuncs.com/', 'https://bucket.oss-cn-beijing.aliyuncs.com/private', 'https://bucket.oss-cn-beijing.aliyuncs.com/?url=http://localhost', 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions']) {
        for (const method of ['GET','POST']) assert.equal(allowedModelStudioTarget(new URL(url),method),false,url);
    }
});
test('policy and multipart streams separate MCP pairing auth from Alibaba credentials', async () => {
    const calls=[];
    const server=http.createServer((req,res)=>handleModelStudioUpload(req,res,new URL(req.url,'http://localhost'),async(url,init)=>{
        const chunks=[];if(init.body)for await(const chunk of init.body)chunks.push(Buffer.from(chunk));
        calls.push({url:String(url),init,body:Buffer.concat(chunks)});
        return new Response('upstream',{status:429,headers:{'Content-Type':'text/plain','Retry-After':'3','Set-Cookie':'must-not-forward=1'}});
    }));
    await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}/model-studio/temporary-files/request?url=`;
    try{
        const policy=await fetch(base+encodeURIComponent('https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model=qwen3.8-omni-flash'),{headers:{Authorization:'Bearer mcp-only','X-DashScope-Api-Key':'ali-only'}});
        assert.equal(policy.status,429);assert.equal(policy.headers.get('retry-after'),'3');assert.equal(policy.headers.get('set-cookie'),null);assert.equal(await policy.text(),'upstream');
        assert.equal(calls[0].init.headers.Authorization,'Bearer ali-only');assert.equal(calls[0].init.redirect,'error');assert.ok(!JSON.stringify(calls[0].init.headers).includes('mcp-only'));
        const form=new FormData();form.set('file',new Blob(['video-bytes']),'part.mp4');form.set('policy','signed-policy');
        const upload=await fetch(base+encodeURIComponent('https://bucket.oss-cn-beijing.aliyuncs.com/'),{method:'POST',headers:{Authorization:'Bearer mcp-only','X-DashScope-Api-Key':'ali-only'},body:form});
        await upload.text();assert.equal(calls[1].init.headers.Authorization,undefined);assert.equal(calls[1].init.headers['X-DashScope-Api-Key'],undefined);assert.ok(calls[1].body.includes(Buffer.from('video-bytes')));
        assert.equal((await fetch(base+encodeURIComponent('https://bucket.oss-cn-beijing.aliyuncs.com/'),{method:'POST',body:'wrong'})).status,400);
        assert.equal((await fetch(base+encodeURIComponent('http://localhost/'))).status,403);
        const oversized=await new Promise((resolve,reject)=>{
            const request=http.request(base+encodeURIComponent('https://bucket.oss-cn-beijing.aliyuncs.com/'),{method:'POST',headers:{'Content-Type':'multipart/form-data; boundary=test','Content-Length':'960000001'}},response=>{response.resume();response.on('end',()=>{resolve(response.statusCode);request.destroy();});});
            request.on('error',reject);request.flushHeaders();
        });
        assert.equal(oversized,413);assert.equal(calls.length,2);
    }finally{await new Promise(r=>server.close(r));}
});
test('shared HTTP route advertises capability and retains Origin, PNA and optional pairing auth', async () => {
    const home=fs.mkdtempSync(path.join(os.tmpdir(),'keepwork-upload-http-'));const oldHome=os.homedir;let server;const oldFetch=global.fetch;const calls=[];
    try{
        os.homedir=()=>home;
        const {startHttpServer}=require('../src/mcp/http.ts');
        const reservation=http.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
        server=await startHttpServer({port,root:home,requireAuth:true});
        const base=`http://127.0.0.1:${port}`,target='https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model=qwen3.8-omni-flash';
        const route=base+'/model-studio/temporary-files/request?url='+encodeURIComponent(target);
        global.fetch=async(url,init)=>{if(String(url).startsWith('https://dashscope.')){calls.push(init);return Response.json({data:{upload_host:'https://bucket.oss-cn-beijing.aliyuncs.com/'}});}return oldFetch(url,init);};
        assert.equal((await(await fetch(base+'/health')).json()).modelStudioUploadApi,'temporary-upload-v1');
        const headers={Origin:'http://127.0.0.1:3004',Authorization:`Bearer ${server.token}`,'X-DashScope-Api-Key':'synthetic-ali-key'};
        assert.equal((await fetch(route,{headers:{Origin:headers.Origin}})).status,401);
        assert.equal((await fetch(route,{headers:{...headers,Origin:'https://attacker.test'}})).status,403);
        assert.equal((await fetch(route,{headers:{Authorization:headers.Authorization}})).status,403);
        assert.equal((await fetch(route,{method:'OPTIONS',headers:{Origin:'https://attacker.test'}})).status,403);
        const preflight=await fetch(route,{method:'OPTIONS',headers:{Origin:headers.Origin,'Access-Control-Request-Headers':'authorization,x-dashscope-api-key','Access-Control-Request-Private-Network':'true'}});
        assert.equal(preflight.status,204);assert.match(preflight.headers.get('access-control-allow-headers'),/X-DashScope-Api-Key/);assert.equal(preflight.headers.get('access-control-allow-private-network'),'true');
        const response=await fetch(route,{headers});assert.equal(response.status,200);assert.equal(response.headers.get('access-control-allow-origin'),headers.Origin);assert.ok((await response.json()).data);assert.equal(calls.length,1);
        assert.equal(calls[0].headers.Authorization,'Bearer synthetic-ali-key');assert.ok(!JSON.stringify(calls).includes(server.token));
    }finally{global.fetch=oldFetch;if(server)await server.close();os.homedir=oldHome;fs.rmSync(home,{recursive:true,force:true});if(oldLoader)require.extensions['.ts']=oldLoader;else delete require.extensions['.ts'];}
});
