const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const run = promisify(execFile);

test('macOS hidden main WebView can use its mock microphone and take one mock camera photo from the pet', {
  skip: process.platform !== 'darwin',
  timeout: 90000,
}, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aichat-remote-phone-'));
  const requests = new Map();
  const server = http.createServer((request, response) => {
    const page = request.url;
    if (page !== '/main' && page !== '/pet') {
      response.writeHead(404).end();
      return;
    }
    requests.set(page, (requests.get(page) || 0) + 1);
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; media-src blob:" });
    response.end(page === '/pet'
      ? `<!doctype html><title>pet</title><button style="position:fixed;inset:0" onclick="window.petClicks++">Pet</button>
         <script>window.petClicks = 0</script>`
      : `<!doctype html><title>main</title><script>
        window.sessionMarker = crypto.randomUUID();
        window.phoneStarts = 0;
        window.photoStarts = 0;
        window.takePhoto = async () => {
          window.photoStarts++;
          window.captureState = 'waiting';
          const video = document.createElement('video');
          video.muted = true;
          video.playsInline = true;
          let stream;
          try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { width: {ideal: 1280}, height: {ideal: 720} } });
            window.track = stream.getVideoTracks()[0];
            video.srcObject = stream;
            await video.play();
            const canvas = document.createElement('canvas');
            canvas.width = window.photoWidth = video.videoWidth;
            canvas.height = video.videoHeight;
            canvas.getContext('2d').drawImage(video, 0, 0);
            const jpeg = canvas.toDataURL('image/jpeg', .7);
            window.jpegLength = jpeg.startsWith('data:image/jpeg;base64,') ? jpeg.length : 0;
            canvas.width = 32;
            canvas.height = 18;
            const context = canvas.getContext('2d');
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
            window.mockPattern = pixels.some((value, i) => i % 4 === 0 && Math.abs(value - pixels[0]) > 20);
            window.captureState = 'captured';
          } catch (e) { window.captureState = e.name; }
          finally { stream?.getTracks().forEach(t => t.stop()); video.srcObject = null; }
        };
        window.reacquireMic = async () => {
          window.track.stop();
          const fresh = await navigator.mediaDevices.getUserMedia({audio:{sampleRate:16000,channelCount:1}});
          window.track = fresh.getAudioTracks()[0];
          window.ctx = new AudioContext({sampleRate:16000});
          window.source = ctx.createMediaStreamSource(fresh);
          window.processor = ctx.createScriptProcessor(4096,1,1);
          window.samples = 0;
          processor.onaudioprocess = event => {
            if (event.inputBuffer.getChannelData(0).some(sample => Math.abs(sample) > .001)) window.samples++;
          };
          source.connect(processor); processor.connect(ctx.destination);
          // The live S2S3 capture graph uses the 16 kHz context directly.
        };
        window.startPhone = async () => {
          window.phoneStarts++;
          window.captureState = 'waiting';
          try {
            window.stream = await navigator.mediaDevices.getUserMedia({audio:true});
            window.track = stream.getAudioTracks()[0];
            window.captureState = 'listening';
          } catch (e) { window.captureState = e.name; }
        };
      </script>`);
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const exe = path.join(dir, 'test-phone');
    await run('clang', ['-fobjc-arc', '-Wall', '-Werror', '-framework', 'Cocoa', '-framework', 'WebKit', '-framework', 'CoreGraphics',
      path.resolve(__dirname, '../src-tauri/src/app/remote_phone_macos.m'),
      path.join(__dirname, 'fixtures/remote_phone_macos.m'), '-o', exe], { timeout: 20000 });
    try {
      const result = await run(exe, [`http://127.0.0.1:${server.address().port}`], { timeout: 50000 });
      if (result.stdout.includes('locked/asleep')) t.diagnostic('The fixture simulated unobscured windows on a locked/asleep display.');
      for (const device of ['phone', 'camera']) for (const decision of ['grant', 'deny']) {
        assert.ok(result.stdout.includes(`passed: ${device} ${decision}`));
      }
    } catch (error) {
      if (error.code === 77 && /no WebKit mock capture/i.test(error.stdout)) {
        t.skip('This WebKit version has no mock capture device support');
        return;
      }
      throw error;
    }
    assert.equal(requests.get('/main'), 4, 'each scenario retains the original main document');
    assert.equal(requests.get('/pet'), 4, 'each scenario retains the original pet');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
