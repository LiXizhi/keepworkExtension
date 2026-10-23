(() => {
  const api = window.desktopPet, $ = id => document.getElementById(id);
  let state = {}, expanded = false, edits = 0, unsynced = false, localError = '', queue = Promise.resolve(), pointer = null, renderedMessages = '';
  let choosing = false, interactive = null, jelly;
  const artStyle = {};
  function setArtStyle(key, value) {
    if (artStyle[key] !== value) { artStyle[key] = value; $('art').style[key] = value; }
  }
  function positionLayers() {
    if (typeof state.petLeft !== 'number') return;
    $('pet').style.left = `${state.petLeft}px`;
    $('pet').style.top = `${state.petTop}px`;
    const stack = $('stack'), width = Math.min(348, window.innerWidth - 12);
    const above = Math.max(0, state.petTop - 12);
    const below = Math.max(0, window.innerHeight - state.petTop - (state.petPixels || 112) - 28);
    const onTop = above >= Math.min(stack.scrollHeight, 360) || above >= below;
    stack.style.width = `${width}px`;
    stack.style.left = `${Math.max(6, Math.min(state.petLeft + (state.petPixels || 112) - width, window.innerWidth - width - 6))}px`;
    stack.style.right = 'auto';
    stack.style.maxHeight = `${onTop ? above : below}px`;
    stack.style.bottom = onTop ? `${window.innerHeight - state.petTop + 8}px` : 'auto';
    stack.style.top = onTop ? 'auto' : `${state.petTop + (state.petPixels || 112) + 24}px`;
  }
  function render(next) {
    if (!next || next.version !== 1) return;
    const openingExit = !!next.exitPrompt && !state.exitPrompt;
    const closingExit = !next.exitPrompt && !!state.exitPrompt;
    if (next.context !== state.context) { edits = 0; unsynced = false; localError = ''; $('draft').value = next.draft || ''; }
    state = next;
    interactive = null;
    if (typeof next.expanded === 'boolean') { expanded = next.expanded; $('panel').hidden = !expanded; }
    const pet = state.preferences?.appearance === 'dragon' ? {} : state.pet || {};
    // Empty/reset snapshots use the default dragon defined in pet.css.
    if ($('art').textContent !== '') $('art').textContent = '';
    const image = pet.imageData || pet.sheetUrl;
    setArtStyle('backgroundImage', image ? `url(${JSON.stringify(image)})` : '');
    setArtStyle('backgroundSize', image ? pet.bgSize || '400% 400%' : '');
    setArtStyle('backgroundPosition', image ? pet.bgPos || '0% 0%' : '');
    document.body.style.setProperty('--pet-pixels', `${state.petPixels || 112}px`);
    $('pet').title = `${pet.name || '宠物'} · 点击聊天 · 右键设置 · 拖动移动`;
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
    $('status').textContent = state.attention || (state.richDraft ? '含附件或文件引用，请在 AIChat 中编辑。' : state.voice?.active ? `语音：${state.voice.muted ? '已静音' : ({ starting: '连接中', listening: '聆听中', thinking: '思考中', speaking: '说话中', stopping: '结束中', discussing: '讨论中' }[state.voice.state] || '通话中')}` : state.busy ? '正在回复…' : '');
    $('error').textContent = localError || state.error || '';
    const reply = state.reply;
    $('bubble').hidden = !reply || (!reply.text && !reply.options?.length);
    $('bubble').classList.toggle('thinking', !!reply?.thinking);
    const signature = JSON.stringify([state.context, reply]);
    if (signature !== renderedMessages) {
      renderedMessages = signature;
      const log = $('reply'), atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
      const wasThinking = log.dataset.thinking === 'true';
      log.textContent = reply?.text || '';
      log.dataset.thinking = String(!!reply?.thinking);
      if (wasThinking && !reply?.thinking) log.scrollTop = 0;
      else if (atBottom && state.busy) log.scrollTop = log.scrollHeight;
      const context = state.context;
      $('options').replaceChildren(...(reply?.options || []).map(option => {
        const button = document.createElement('button');
        button.textContent = [option.icon, option.text].filter(Boolean).join(' ');
        button.onclick = async () => {
          if (choosing || context !== state.context || state.busy || state.richDraft || state.dictating || state.draft || edits || unsynced) return;
          choosing = true; render(state);
          try {
            if (await action('input', { text: option.text }) && context === state.context) {
              if (reply.immediate !== false) await action('send');
              else await expand(true);
            }
          } finally { choosing = false; render(state); }
        };
        return button;
      }));
    }
    for (const button of $('options').children) button.disabled = choosing || !state.ready || state.busy || state.richDraft || state.dictating || !!state.draft || !!edits || unsynced;
    const exit = state.exitPrompt;
    $('exit-bubble').hidden = !exit;
    if (exit) {
      $('bubble').hidden = true; $('panel').hidden = true;
      $('exit-summary').textContent = exit.sharedRuntime
        ? '将完全关闭 AIChat。由其他程序提供的本机服务会继续运行，但依赖 AIChat 的分身回复会中断。'
        : '将完全关闭 AIChat 和它启动的本机服务。以下分身将暂停运行，已启用渠道将无法自动回复，直到重新启动：';
      $('exit-personas').replaceChildren(...exit.personas.map(persona => {
        const item = document.createElement('li');
        item.textContent = `${persona.name}（${persona.channels.join('、') || '本地分身任务'}）`;
        return item;
      }));
      $('exit-status').textContent = exit.loading ? '正在检查分身和渠道…' : exit.unavailable
        ? '暂时无法获取分身列表。飞书、钉钉等已连接渠道的自动回复可能中断。仍要退出吗？'
        : exit.personas.length ? '隐藏宠物可保持后台运行；完全退出会停止本应用。' : '未发现当前账号的已配置分身。仍要完全退出吗？';
      $('exit-confirm').disabled = exit.loading;
      if (openingExit) $('exit-cancel').focus();
    }
    if (closingExit) $('pet').focus();
    positionLayers();
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
    if (state.exitPrompt) return;
    const opening = value && !expanded;
    expanded = value;
    if (opening && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      jelly?.cancel();
      const amount = Math.min(.12, 14 / (state.petPixels || 112));
      jelly = $('art').animate?.([
        { transform: 'scale(1, 1)' }, { transform: `scale(${1 + amount}, .88)`, offset: .22 },
        { transform: 'scale(.93, 1.07)', offset: .46 }, { transform: `scale(${1 + amount / 3}, .96)`, offset: .7 },
        { transform: 'scale(1, 1)' },
      ], { duration: 460, easing: 'ease-out' });
    }
    await api.action('expand', { expanded }); $('panel').hidden = !expanded;
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
  $('reply').onclick = () => { if (!window.getSelection()?.toString()) void api.action('open'); };
  $('reply').onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void api.action('open'); } };
  $('collapse').onclick = () => { void expand(false); };
  $('exit-cancel').onclick = () => { void api.action('exit-cancel'); };
  $('exit-confirm').onclick = () => {
    if (!state.exitPrompt || state.exitPrompt.loading) return;
    void api.action('exit-confirm', { id: state.exitPrompt.id }).catch(error => { $('exit-status').textContent = error.message; });
  };
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { if (state.exitPrompt) void api.action('exit-cancel'); else void expand(false); }
    if (event.key === 'Tab' && state.exitPrompt) {
      event.preventDefault();
      (document.activeElement === $('exit-cancel') && !$('exit-confirm').disabled ? $('exit-confirm') : $('exit-cancel')).focus();
    }
  });
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
  $('pet').addEventListener('contextmenu', event => { event.preventDefault(); void api.action('menu'); });
  document.addEventListener('mousemove', event => {
    const next = !!pointer || !!event.target.closest('#pet, #panel, #bubble, #exit-bubble');
    if (next !== interactive) { interactive = next; void api.action('hit-test', { interactive }); }
  });
  api.subscribe(render); void api.action('state').then(render);
})();
