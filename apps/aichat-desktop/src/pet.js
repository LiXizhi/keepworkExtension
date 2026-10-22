(() => {
  const api = window.desktopPet, $ = id => document.getElementById(id);
  let state = {}, expanded = false, edits = 0, unsynced = false, localError = '', queue = Promise.resolve(), pointer = null, renderedMessages = '';
  function render(next) {
    if (!next || next.version !== 1) return;
    if (next.context !== state.context) { edits = 0; unsynced = false; localError = ''; $('draft').value = next.draft || ''; }
    state = next;
    if (typeof next.expanded === 'boolean') { expanded = next.expanded; $('panel').hidden = !expanded; }
    $('title').textContent = state.title || 'AIChat';
    const pet = state.pet || {};
    $('art').textContent = pet.sheetUrl ? '' : '🥚';
    $('art').style.backgroundImage = pet.sheetUrl ? `url(${JSON.stringify(pet.sheetUrl)})` : '';
    $('art').style.backgroundSize = pet.bgSize || '400% 400%';
    $('art').style.backgroundPosition = pet.bgPos || '0% 0%';
    $('pet').title = `${pet.name || '宠物'} · 点击聊天 · 拖动移动`;
    $('badge').hidden = !(state.busy || state.voice?.active || state.attention || state.error);
    if (!edits && !unsynced) $('draft').value = state.draft || '';
    $('draft').disabled = !state.ready || state.richDraft || state.dictating;
    $('send').textContent = state.busy ? '停止' : '发送';
    $('send').disabled = !state.ready || (!state.busy && (state.richDraft || state.dictating));
    $('dictation').textContent = state.dictating ? '停止输入' : '语音输入';
    $('dictation').disabled = !state.ready || state.richDraft || !!state.voice?.active;
    $('call').textContent = state.voice?.active ? '结束通话' : '通话';
    $('call').title = state.canCall || state.voice?.active ? '实时语音对话' : '请在 AIChat 中选择实时语音模型';
    $('call').disabled = !state.ready || (!state.canCall && !state.voice?.active) || state.dictating;
    $('mute').hidden = !state.voice?.active;
    $('mute').textContent = state.voice?.muted ? '取消静音' : '静音';
    $('status').textContent = state.attention || (state.richDraft ? '含附件或文件引用，请在 AIChat 中编辑。' : state.voice?.active ? `语音：${state.voice.muted ? '已静音' : ({ starting: '连接中', listening: '聆听中', thinking: '思考中', speaking: '说话中', stopping: '结束中', discussing: '讨论中' }[state.voice.state] || '通话中')}` : state.busy ? '正在回复…' : state.ready ? '' : '打开 AIChat 开始聊天');
    $('error').textContent = localError || state.error || '';
    const signature = JSON.stringify(state.messages || []);
    if (signature !== renderedMessages) {
      renderedMessages = signature;
      const log = $('messages'), atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
      log.replaceChildren(...(state.messages || []).map(message => {
        const item = document.createElement('div'); item.className = `message ${message.role}`; item.textContent = message.content; return item;
      }));
      if (atBottom) log.scrollTop = log.scrollHeight;
    }
  }
  function action(name, args = {}) {
    const context = state.context;
    const task = queue.then(async () => {
      if (context !== state.context) throw new Error('会话已改变，请重试');
      const next = await api.action(name, { ...args, context });
      localError = '';
      if (next) render(next);
      return true;
    });
    queue = task.catch(error => { localError = error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''); $('error').textContent = localError; return false; });
    return queue;
  }
  async function expand(value) {
    expanded = value; await api.action('expand', { expanded }); $('panel').hidden = !expanded;
    if (expanded && !$('draft').disabled) $('draft').focus();
  }
  $('draft').addEventListener('input', () => {
    const context = state.context; edits++; unsynced = true;
    void action('input', { text: $('draft').value }).then(ok => {
      if (context === state.context) { edits = Math.max(0, edits - 1); if (!edits) { unsynced = !ok; render(state); } }
    });
  });
  $('draft').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$('send').disabled) $('send').click(); } });
  $('send').onclick = async () => {
    const name = state.busy ? 'stop' : 'send', context = state.context;
    await queue;
    if (context !== state.context) return;
    if (name === 'send' && unsynced) {
      if (!await action('input', { text: $('draft').value })) return;
      unsynced = false;
    }
    void action(name);
  };
  for (const name of ['dictation', 'call', 'mute']) $(name).onclick = () => { void action(name); };
  $('open').onclick = () => { void api.action('open'); };
  $('collapse').onclick = () => { void expand(false); };
  document.addEventListener('keydown', event => { if (event.key === 'Escape') void expand(false); });
  $('pet').addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    pointer = { x: event.screenX, y: event.screenY, moved: false, ready: api.action('drag-start') };
    $('pet').setPointerCapture(event.pointerId);
  });
  $('pet').addEventListener('pointermove', event => {
    if (!pointer) return;
    if (Math.hypot(event.screenX - pointer.x, event.screenY - pointer.y) > 4) pointer.moved = true;
    if (pointer.moved) void pointer.ready.then(() => api.action('drag'));
  });
  const release = async event => {
    const current = pointer; pointer = null; if (!current) return;
    await current.ready; await api.action('drag-end');
    if (!current.moved && event.type === 'pointerup') await expand(!expanded);
  };
  $('pet').addEventListener('pointerup', release); $('pet').addEventListener('pointercancel', release);
  $('pet').addEventListener('click', event => { if (event.detail === 0) void expand(!expanded); });
  let interactive = true;
  document.addEventListener('mousemove', event => {
    const next = !!pointer || !!event.target.closest('#pet, #panel');
    if (next !== interactive) { interactive = next; void api.action('hit-test', { interactive }); }
  });
  api.subscribe(render); void api.action('state').then(render);
})();
