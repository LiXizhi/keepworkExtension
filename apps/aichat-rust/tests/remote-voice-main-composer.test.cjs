const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const execute = promisify(execFile);

// Isolate authorization/receipt time from hidden WebKit scheduling. Editing,
// microtasks and the native pause bridge still run in the real browser. Advance
// this clock explicitly when testing expiry and the production cleanup timer.
function installFixtureClock() {
  const originalNow = Date.now;
  const originalSetTimeout = window.setTimeout;
  const originalClearTimeout = window.clearTimeout;
  let now = originalNow(), nextTimer = 0;
  const timers = new Map();
  Date.now = () => now;
  window.setTimeout = (callback, delay = 0, ...args) => {
    const id = ++nextTimer;
    timers.set(id, { at: now + Math.max(0, Number(delay) || 0), callback, args });
    return id;
  };
  window.clearTimeout = id => timers.delete(id);
  return {
    advance(milliseconds) {
      if (!Number.isFinite(milliseconds) || milliseconds < 0) throw Error('invalid fixture clock advance');
      now += milliseconds;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) { timers.delete(id); timer.callback(...timer.args); }
      }
    },
    restore() {
      Date.now = originalNow;
      window.setTimeout = originalSetTimeout;
      window.clearTimeout = originalClearTimeout;
      timers.clear();
    },
  };
}

// The text-only .value adapter mirrors AIChat's inline composer contract:
// BR serializes as newline, file chips stay out of ordinary text, and zero
// width caret sentinels are not part of the draft. No adjacent app is imported.
async function checkMainDelivery(insertSource, verifySource, clearSource) {
  const check = (condition, message) => { if (!condition) throw Error(message); };
  const insert = eval('(' + insertSource + ')');
  const verify = eval('(' + verifySource + ')');
  const pause = () => window.__keepworkFixturePause();
  const byId = id => document.getElementById(id);
  const style = document.createElement('style');
  style.textContent = '[contenteditable],textarea { white-space: pre-wrap; }';
  document.head.append(style);
  const read = input => typeof input.value === 'string' ? input.value : input.textContent;
  let foreground = false;
  Object.defineProperty(document, 'hasFocus', { value: () => foreground });
  let sequence = 0;
  const request = text => ({ id: 'fixture-' + ++sequence, text, page: location.href, expires: Date.now() + 1000 });
  let lastVerification;
  const finish = async req => {
    const start = performance.now();
    await pause();
    const record = window.__keepworkComposerDeliveryV1?.get(req.id);
    lastVerification = { pauseMs: Math.round(performance.now() - start), expiredByMs: Date.now() - req.expires,
      receiptPresent: !!record, active: document.activeElement?.id, focused: document.hasFocus() };
    return verify({ id: req.id, page: req.page, expires: req.expires });
  };
  const setup = (markup, from = 'toolbar') => {
    document.body.innerHTML = '<button id="toolbar">Tools</button><article id="history" tabindex="-1">Retain history</article>' + markup;
    const editor = byId('chatInput');
    if (editor?.isContentEditable) Object.defineProperty(editor, 'value', {
      configurable: true,
      get() {
        let value = '';
        for (const node of this.childNodes) {
          if (node.nodeType === Node.TEXT_NODE) value += node.textContent || '';
          else if (node.nodeName === 'BR') value += '\n';
          else if (!node.matches?.('[data-file-ref]')) value += node.textContent || '';
        }
        return value.replace(/\u200b/g, '');
      },
      set(value) { this.textContent = String(value ?? ''); },
    });
    if (editor?.isContentEditable) editor._fileMentionAdapter = true;
    const model = { value: editor ? read(editor) : null, events: [] };
    if (editor instanceof HTMLTextAreaElement) editor.setSelectionRange(editor.value.length, editor.value.length);
    editor?.addEventListener('input', event => {
      model.value = read(editor);
      model.events.push({ trusted: event.isTrusted, type: event.inputType });
    });
    byId(from)?.focus();
    return { editor, model };
  };
  const rich = '<div id="chatInput" class="composer-input" contenteditable="true" role="textbox">Seed </div>';
  const textarea = '<textarea id="chatInput">Seed </textarea>';

  let state = setup(rich);
  check(insert(request('private')) === -1 && document.activeElement === byId('toolbar') && read(state.editor) === 'Seed ',
    'background document received direct text');
  foreground = true;
  for (const [kind, markup] of [['rich', rich], ['textarea', textarea]]) {
    for (const text of ['普通话😀 café', '第一行\n\n  第二行\t尾', 'Windows\r\n换行',
      '<img src=x onerror="throw Error(1)"> & "quoted"', '清除提示词', '发送提示词']) {
      state = setup(markup);
      const req = request(text);
      const before = read(state.editor);
      const normalized = text.replace(/\r\n?/g, '\n');
      const inserted = insert(req);
      check(inserted === 1, kind + ' did not enter pending verification ' +
        JSON.stringify({ inserted, text, value: read(state.editor), html: state.editor.innerHTML, events: state.model.events }));
      check(insert(req) === -1, 'duplicate request edited the same text again');
      const accepted = await finish(req);
      const receipt = window.__keepworkComposerDeliveryV1?.get(req.id);
      check(accepted === 1, kind + ' did not acknowledge its actual edit ' + JSON.stringify({
        accepted, id: req.id, text, expiredByMs: Date.now() - req.expires, active: document.activeElement?.id,
        value: read(state.editor), model: state.model.value, html: state.editor.innerHTML, events: state.model.events,
        receipt: receipt ? { done: receipt.done, accepted: receipt.accepted, check: typeof receipt.check } : null,
        verification: lastVerification,
      }));
      check(read(state.editor) === before + normalized && state.model.value === before + normalized,
        kind + ' value adapter/model lost Unicode, multiline or literal markup ' +
          JSON.stringify({ value: read(state.editor), model: state.model.value, expected: before + normalized }));
      check(!state.editor.querySelector('img,script'), 'dictation interpreted literal markup as HTML');
      check(state.model.events.length >= 1 && state.model.events.every(event => event.trusted &&
        /^insert/.test(event.type) && event.type !== 'insertReplacementText'),
        'direct delivery did not produce ordinary trusted insertion events');
      check(document.activeElement === state.editor, 'direct delivery did not leave the composer focused');
      check(document.execCommand('undo') && read(state.editor) === before && state.model.value === before,
        kind + ' delivery was not undoable through normal editing');
      // Let native Undo selection restoration finish before replacing this
      // editor for the next independent case.
      await pause();
    }
  }

  state = setup('<div id="chatInput" contenteditable="true">左<span data-file-ref="sample.txt" contenteditable="false">@资料</span>尾端</div>', 'chatInput');
  const chip = state.editor.querySelector('[data-file-ref]');
  const range = document.createRange();
  range.setStart(state.editor.lastChild, 0); range.setEnd(state.editor.lastChild, 1);
  getSelection().removeAllRanges(); getSelection().addRange(range);
  let req = request('新😀');
  check(insert(req) === 1 && await finish(req) === 1, 'rich partial selection did not accept dictation');
  check(read(state.editor) === '左新😀端' && state.editor.textContent === '左@资料新😀端' &&
    state.editor.querySelector('[data-file-ref]') === chip, 'partial selection lost the chip or adapter contract');

  state = setup('<textarea id="chatInput">前选中后</textarea>', 'chatInput');
  state.editor.setSelectionRange(1, 3);
  req = request('替换');
  check(insert(req) === 1 && await finish(req) === 1 && state.model.value === '前替换后',
    'textarea selection was not replaced at the selected range');

  state = setup(rich);
  for (let round = 0; round < 3; round++) {
    req = request('Repeated ' + round + '😀');
    const beforeHTML = state.editor.innerHTML;
    const status = insert(req);
    const verified = status === 1 ? await finish(req) : -1;
    check(status === 1 && verified === 1, 'same composer delivery failed on round ' + round + ' ' +
      JSON.stringify({ status, verified, beforeHTML, html: state.editor.innerHTML, value: read(state.editor), events: state.model.events,
        verification: lastVerification }));
    check(eval(clearSource) === 1 && !read(state.editor).trim() && state.model.value === read(state.editor),
      'same composer could not clear immediately after direct delivery');
  }

  state = setup('<div id="chatInput" contenteditable="true"><br></div>', 'chatInput');
  req = request('First "literal"');
  check(insert(req) === 1 && await finish(req) === 1, 'empty placeholder did not accept its first literal text');
  req = request('\n第二段\n  缩进😀');
  check(insert(req) === 1 && await finish(req) === 1 && read(state.editor) === 'First "literal"\n第二段\n  缩进😀',
    'multiline append after an empty-placeholder insertion lost the adapter value');
  // Multiple edits inside this one callAsyncJavaScript can share a native Undo
  // group. The staged fixture/Tauri smoke checks distinct host-call history.

  for (const extra of [
    '<input id="other" value="Retain search">',
    '<input id="other" type="password" value="Retain password">',
    '<textarea id="other">Retain another draft</textarea>',
    '<div id="other" contenteditable="true">Retain another editor</div>',
    '<iframe id="other" title="Embedded tool"></iframe>',
  ]) {
    state = setup(rich + extra, 'other');
    const other = byId('other');
    const before = other.value ?? other.textContent;
    check(insert(request('must stay native')) === 0 && document.activeElement === other &&
      (other.value ?? other.textContent) === before && read(state.editor) === 'Seed ' && !state.model.events.length,
      'direct delivery stole another input or iframe target');
    if (other instanceof HTMLIFrameElement) {
      other.contentDocument.body.innerHTML = rich;
      check(other.contentWindow.eval('(' + insertSource + ')')({ ...request('subframe'), page: other.contentWindow.location.href }) === -1,
        'direct delivery entered a subframe');
    }
  }
  for (const unavailable of [
    '<div hidden>' + rich + '</div>',
    '<div inert>' + rich + '</div>',
    '<div aria-readonly="true">' + rich + '</div>',
    '<textarea id="chatInput" readonly>Retain readonly</textarea>',
    '<textarea id="chatInput" disabled>Retain disabled</textarea>',
    rich + '<section role="dialog" aria-modal="true"><button id="other">Confirm</button></section>',
  ]) {
    state = setup(unavailable);
    byId('other')?.focus();
    const before = read(state.editor);
    check(insert(request('blocked')) !== 1 && read(state.editor) === before && !state.model.events.length,
      'unavailable composer or modal received text');
  }

  state = setup(rich);
  state.editor.addEventListener('beforeinput', event => event.preventDefault());
  req = request('cancelled');
  const cancelled = insert(req);
  check(cancelled !== 1 || await finish(req) === -1, 'cancelled beforeinput was reported as a successful edit');
  check(read(state.editor) === 'Seed ' && !state.model.events.length, 'cancelled edit mutated the composer');

  state = setup('<div id="chatInput" contenteditable="true"><br></div>', 'chatInput');
  state.editor.addEventListener('beforeinput', event => event.preventDefault());
  check(insert(request('cancelled placeholder')) === -1 && state.editor.innerHTML === '<br>' &&
    state.model.value === '\n' && !state.model.events.length, 'page veto changed an empty placeholder or its model');

  state = setup(rich);
  const pageEdited = state.editor;
  pageEdited.addEventListener('beforeinput', () => { pageEdited.textContent = 'Page handled the edit'; }, { once: true });
  check(insert(request('must not be replayed')) === -1 && pageEdited.textContent === 'Page handled the edit' &&
    !state.model.events.length, 'preflight changed the page but native editing still ran');

  for (const interruption of ['focus', 'readonly', 'replace', 'new-content']) {
    state = setup('<div id="chatInput" contenteditable="true"><br></div>', 'chatInput');
    const interruptedEditor = state.editor;
    interruptedEditor.addEventListener('input', () => {
      if (interruptedEditor.textContent !== '\u200b') return;
      if (interruption === 'focus') byId('toolbar').focus();
      else if (interruption === 'readonly') interruptedEditor.setAttribute('aria-readonly', 'true');
      else if (interruption === 'replace') {
        const replacement = interruptedEditor.cloneNode(false);
        replacement.textContent = 'New owner draft';
        interruptedEditor.replaceWith(replacement);
      } else interruptedEditor.textContent = 'New page draft';
    }, { once: true });
    req = request('must never overwrite the new target');
    check(insert(req) === -1 && await finish(req) === -1, 'interrupted marker prep received a success acknowledgement');
    if (interruption === 'replace' || interruption === 'new-content') {
      check(byId('chatInput').textContent === (interruption === 'replace' ? 'New owner draft' : 'New page draft'),
        'marker prep selected or cleaned up newly owned content');
    } else {
      check(read(interruptedEditor) === '' && !interruptedEditor.textContent.replace(/\u200b/g, ''),
        'aborted marker prep leaked text through the AIChat adapter');
      interruptedEditor.removeAttribute('aria-readonly');
      interruptedEditor.focus();
      req = request('Fresh retry😀');
      check(insert(req) === 1 && await finish(req) === 1 && read(interruptedEditor) === 'Fresh retry😀' &&
        !interruptedEditor.textContent.includes('\u200b'), 'refocusing after marker interruption could not deliver clean text');
      const chip = document.createElement('span');
      chip.dataset.fileRef = 'retry.txt'; chip.contentEditable = 'false'; chip.textContent = '@资料';
      getSelection().getRangeAt(0).insertNode(chip);
      const serialized = Array.from(interruptedEditor.childNodes).map(node => node.nodeType === Node.TEXT_NODE
        ? node.textContent : node.matches?.('[data-file-ref]') ? '[#ref ' + node.dataset.fileRef + ']' : node.textContent).join('').replace(/\u200b/g, '');
      check(chip.parentNode === interruptedEditor && serialized === 'Fresh retry😀[#ref retry.txt]',
        'retry delivery lost flat file-reference serialization');
    }
  }

  for (const content of ['<br>', '\u200b']) {
    state = setup('<div id="chatInput" contenteditable="true">' + content + '</div>', 'chatInput');
    delete state.editor._fileMentionAdapter;
    const before = state.editor.innerHTML;
    check(insert(request('unsupported placeholder contract')) === 0 && state.editor.innerHTML === before && !state.model.events.length,
      'an unknown placeholder adapter was edited instead of staying on the native path');
  }
  state = setup('<div id="chatInput" contenteditable="true">\u200b</div>', 'chatInput');
  state.editor.addEventListener('beforeinput', event => event.preventDefault());
  check(insert(request('veto existing semantic caret')) === -1 && state.editor.textContent === '\u200b' &&
    read(state.editor) === '' && !state.model.events.length, 'page veto removed an existing component caret');

  state = setup(rich);
  state.editor.addEventListener('focus', () => state.editor.replaceWith(state.editor.cloneNode(true)), { once: true });
  check(insert(request('replaced')) === -1 && byId('chatInput').textContent === 'Seed ' && !state.model.events.length,
    'focus handler replaced the composer but direct delivery still edited it');

  state = setup(rich);
  const rolledEditor = state.editor;
  rolledEditor.addEventListener('input', () => queueMicrotask(() => { rolledEditor.textContent = 'Rolled back'; }), { once: true });
  req = request('must verify');
  const pending = insert(req);
  check(pending !== 1 || await finish(req) === -1, 'positive acknowledgement ignored a page rollback');

  state = setup(rich);
  const asyncEditor = state.editor;
  let cached = 'Seed ';
  Object.defineProperty(state.editor, 'value', { get: () => cached });
  state.editor.addEventListener('input', () => queueMicrotask(() => { cached = asyncEditor.textContent; }));
  req = request('delayed model');
  check(insert(req) === 1 && cached === 'Seed ', 'phase one required the asynchronous model before it settled');
  check(await finish(req) === 1 && cached === 'Seed delayed model', 'second phase did not verify the settled model');

  state = setup(rich);
  Object.defineProperty(state.editor, 'value', { get: () => 'Seed ' });
  req = request('unsynchronized');
  const staleModel = insert(req);
  check(staleModel !== 1 || await finish(req) === -1, 'stale model received a positive acknowledgement');

  state = setup(rich);
  const command = document.execCommand;
  document.execCommand = () => true;
  try {
    check(insert(request('no real edit')) === -1 && !state.model.events.length,
      'an editing-command boolean without a real trusted edit was acknowledged');
  } finally { document.execCommand = command; }

  state = setup(rich);
  req = request('focus changes after editing');
  check(insert(req) === 1, 'could not prepare a pending focus-change receipt');
  byId('toolbar').focus();
  check(await finish(req) === -1 && document.activeElement === byId('toolbar'),
    'verification repaired focus or accepted a changed target');

  state = setup(rich);
  req = { ...request('stale'), expires: Date.now() - 1 };
  check(insert(req) === -1 && !state.model.events.length && read(state.editor) === 'Seed ', 'expired request edited the draft');
  req = request('wrong page'); req.page += '#different-page';
  check(insert(req) === -1 && !state.model.events.length, 'page identity mismatch edited the draft');
  check(verify({ id: 'unknown', page: location.href, expires: Date.now() + 1000 }) === -1,
    'unknown verification receipt was accepted');
  return 'main composer direct delivery passed';
}

async function checkDeliveryDeadlines(insertSource, verifySource, clockSource) {
  const check = (condition, message) => { if (!condition) throw Error(message); };
  const insert = eval('(' + insertSource + ')');
  const verify = eval('(' + verifySource + ')');
  Object.defineProperty(document, 'hasFocus', { value: () => true });
  const setup = () => {
    document.body.innerHTML = '<button id="toolbar">Tools</button>' +
      '<div id="chatInput" contenteditable="true" style="white-space:pre-wrap">Seed </div>';
    const editor = document.getElementById('chatInput');
    Object.defineProperty(editor, 'value', { get: () => editor.textContent });
    const state = { editor, model: 'Seed ', events: 0 };
    editor.addEventListener('input', event => {
      check(event.isTrusted, 'deadline fixture did not use real WebKit editing');
      state.model = editor.value; state.events++;
    });
    document.getElementById('toolbar').focus();
    return state;
  };
  let sequence = 0;
  const request = () => ({ id: 'deadline-' + ++sequence, text: 'Windows\r\n换行',
    page: location.href, expires: Date.now() + 1000 });
  const delayedPause = async () => {
    const start = performance.now();
    await window.__keepworkFixturePause(1100);
    check(performance.now() - start >= 1000, 'native fixture did not reproduce a delay beyond the request lifetime');
  };

  // Reproduce the original failure with a controlled native delay rather than
  // depending on a busy CI runner. The unchanged verifier must fail closed.
  let state = setup(), req = request();
  check(insert(req) === 1 && state.model === 'Seed Windows\n换行', 'real-clock edit did not enter verification');
  await delayedPause();
  check(Date.now() > req.expires && verify(req) === -1, 'late wall-clock acknowledgement was accepted');
  check(state.editor.value === 'Seed Windows\n换行', 'late verification changed or replayed the edit');

  const clock = eval('(' + clockSource + ')')();
  try {
    state = setup(); req = request();
    const started = Date.now();
    check(insert(req) === 1, 'controlled-clock edit did not enter verification');
    await delayedPause();
    check(Date.now() === started && verify(req) === 1 && state.model === 'Seed Windows\n换行',
      'hidden WebKit scheduling consumed the controlled authorization lifetime');

    state = setup(); req = { ...request(), expires: Date.now() - 1 };
    check(insert(req) === -1 && state.editor.value === 'Seed ' && state.events === 0,
      'an already-expired request edited the draft');

    req = request();
    check(insert(req) === 1, 'could not prepare the late-verification receipt');
    const events = state.events;
    clock.advance(1001);
    const receipts = window.__keepworkComposerDeliveryV1;
    check(receipts.has(req.id) && verify(req) === -1, 'expired pending receipt was accepted');
    const renewed = { ...req, expires: Date.now() + 1000 };
    check(verify(renewed) === -1 && insert(renewed) === -1 && state.events === events &&
      state.editor.value === 'Seed Windows\n换行', 'failed acknowledgement was renewed or replayed');
    clock.advance(200);
    check(!receipts.has(req.id) && verify(req) === -1, 'production receipt cleanup did not run at its deadline');
  } finally { clock.restore(); }
  return 'main composer deterministic deadlines passed';
}

function mainHistoryStages(insert, verify, clear) {
  const stages = [`(${installFixtureClock})();` + String.raw`
    Object.defineProperty(document,'hasFocus',{value:()=>true});
    document.body.innerHTML='<button id="toolbar">Tools</button><div id="chatInput" contenteditable="true" style="white-space:pre-wrap">上一段原草稿😀</div>';
    window.edit=document.getElementById('chatInput');edit._fileMentionAdapter=true;window.model='';window.events=[];
    Object.defineProperty(edit,'value',{get(){return Array.from(this.childNodes).map(node=>
      node.nodeType===Node.TEXT_NODE?node.textContent:node.nodeName==='BR'?'\n':
      node.matches?.('[data-file-ref]')?'':node.textContent).join('').replace(/\u200b/g,'')}});
    edit.oninput=e=>{model=edit.value;events.push([e.isTrusted,e.inputType])};
    window.check=(ok,phase)=>{if(!ok)throw Error(JSON.stringify({phase,value:edit.value,model,html:edit.innerHTML,events}))};
    window.requestNumber=0;window.request=text=>({id:'staged-'+ ++requestNumber,text,page:location.href,expires:Date.now()+1000});
    window.A='上一段原草稿😀';window.B='第二段\n\n  缩进 "literal"';window.model=A;
  ` + `window.insert=(${insert});window.verify=(${verify});window.clear=()=>eval(${JSON.stringify(clear)});` +
    "edit.focus();check(edit.value===A&&model===A,'preloaded draft');true",
  "check(clear()===1&&!edit.value.trim(),'clearA');true",
  "window.b=request(B);check(insert(b)===1,'pendingB');true",
  "check(verify(b)===1&&edit.value===B&&model===B&&edit.textContent===B,'verifyFlatB');window.sawUndoA=false;window.sawEmpty=false;true"];
  const undo = "if(!sawUndoA){check(document.execCommand('undo'),'undo command');sawUndoA ||= edit.value===A;sawEmpty ||= !edit.value.trim();check(edit.value===A||!edit.value.trim(),'undo corrupted text')}true";
  stages.push(undo, undo, undo, "check(sawUndoA,'original draft missing from Undo history');true");
  const redo = "if(edit.value!==B){check(document.execCommand('redo'),'redo command');check(edit.value===A||edit.value===B||!edit.value.trim(),'redo corrupted text')}true";
  stages.push(redo, redo, redo);
  stages.push("check(edit.value===B&&model===B&&edit.textContent===B,'redo lost exact flat text');" +
    "const range=getSelection().getRangeAt(0),chip=document.createElement('span');chip.dataset.fileRef='sample.txt';chip.contentEditable='false';chip.textContent='@资料';range.insertNode(chip);" +
    "const serialized=Array.from(edit.childNodes).map(n=>n.nodeType===Node.TEXT_NODE?n.textContent:n.nodeName==='BR'?String.fromCharCode(10):n.matches?.('[data-file-ref]')?'[#ref '+n.dataset.fileRef+']':n.textContent).join('').split(String.fromCharCode(0x200b)).join('');" +
    "check(chip.parentNode===edit&&edit.value===B&&serialized===B+'[#ref sample.txt]','future file chip lost serialization');true");
  stages.push("document.body.innerHTML='<div id=chatInput contenteditable=true>Independent draft</div>';window.edit=document.getElementById('chatInput');window.model=edit.textContent;edit.oninput=()=>model=edit.textContent;edit.focus();check(clear()===1&&model==='','independent clear');true");
  stages.push("check(document.execCommand('undo')&&edit.textContent==='Independent draft'&&model==='Independent draft','clear Undo did not restore draft');'main composer staged history passed'");
  return stages;
}

async function runFixture(buildScript, expected, staged = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'keepwork-main-composer-'));
  try {
    const [insert, verify, clear] = await Promise.all([
      fs.readFile(path.join(__dirname, '../src-tauri/src/app/remote_voice_insert_composer.js'), 'utf8'),
      fs.readFile(path.join(__dirname, '../src-tauri/src/app/remote_voice_verify_composer.js'), 'utf8'),
      fs.readFile(path.join(__dirname, '../src-tauri/src/app/remote_voice_clear_composer.js'), 'utf8'),
    ]);
    const script = path.join(directory, 'test.js');
    const source = buildScript(insert, verify, clear);
    await fs.writeFile(script, staged ? JSON.stringify(source) : source);
    const executable = path.join(directory, 'webview');
    await execute('clang', ['-fobjc-arc', '-Wall', '-Werror', '-framework', 'AppKit', '-framework', 'WebKit',
      path.join(__dirname, 'fixtures/remote_voice_main_composer_macos.m'), '-o', executable], { timeout: 15000 });
    const { stdout } = await execute(executable, [script, expected, ...(staged ? ['staged'] : [])], { timeout: 35000 });
    assert.ok(stdout.includes(expected));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('main composer direct delivery verifies real WebKit editing, adapter/selection and blocked outcomes', {
  skip: process.platform !== 'darwin', timeout: 50000,
}, () => runFixture((...sources) => `(${installFixtureClock})();return await (${checkMainDelivery})(${sources.map(JSON.stringify).join(',')});`,
  'main composer direct delivery passed'));

test('main composer controls hidden WebKit scheduling while rejecting expired and replayed delivery', {
  skip: process.platform !== 'darwin', timeout: 50000,
}, () => runFixture((insert, verify) => `return await (${checkDeliveryDeadlines})(${[insert, verify, String(installFixtureClock)].map(JSON.stringify).join(',')});`,
  'main composer deterministic deadlines passed'));

test('main composer keeps native Undo/Redo text exact and later file chips at the editor root', {
  skip: process.platform !== 'darwin', timeout: 50000,
}, () => runFixture(mainHistoryStages, 'main composer staged history passed', true));
