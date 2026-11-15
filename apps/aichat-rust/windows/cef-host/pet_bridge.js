// Installed only in the trusted main /chat document before application scripts.
(() => {
  const native = window.__keepworkPetTransport;
  const createArtwork = window.__keepworkCreatePetArtwork;
  delete window.__keepworkPetTransport;
  delete window.__keepworkCreatePetArtwork;
  if (typeof native !== 'function' || window.aichatDesktop) return;
  const listeners = new Set();
  const audioListeners = new Set();
  let capture = null, audioIntent = null;
  let connected = false, latest = null, latestState = null, pendingInput = null, confirmedInput = null, disposed = false;
  let folderRequest = null, folderSequence = 0;
  let latestArtwork = null, sentArtwork = null;
  const flushArtwork = () => {
    if (connected && listeners.size && latest && !disposed && latestArtwork !== null && latestArtwork !== sentArtwork) {
      if (native('artwork', latestArtwork) === true) sentArtwork = latestArtwork;
    }
  };
  const artwork = typeof createArtwork === 'function' ? createArtwork(value => {
    latestArtwork = JSON.stringify(value);
    flushArtwork();
  }) : null;
  function pickFolder() {
    if (disposed || !connected) return Promise.reject(Error('文件夹选择器尚未连接，请稍后重试。'));
    if (folderRequest) return folderRequest.promise;
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const requestId = String(++folderSequence);
    folderRequest = { promise, resolve, reject, requestId };
    if (native('pick-folder', requestId) !== true) {
      folderRequest = null; reject(Error('无法打开系统文件夹选择器，请重试。'));
    }
    return promise;
  }
  const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
  const emitAudio = event => {
    for (const listener of audioListeners) { try { listener(Object.freeze(event)); } catch { /* Independent subscribers. */ } }
  };
  const stopAudio = (message = '') => {
    const owned = capture, intent = audioIntent;
    capture = audioIntent = null;
    if (owned) {
      clearTimeout(owned.timer);
      clearTimeout(owned.resumeTimer);
      owned.cancelResume?.();
      if (owned.processor) owned.processor.onaudioprocess = null;
      for (const node of [owned.source, owned.processor, owned.silent]) { try { node?.disconnect(); } catch { /* Released. */ } }
      for (const track of owned.stream?.getTracks() || []) track.stop();
      try { void owned.context?.close().catch(() => {}); } catch { /* Closed. */ }
    }
    if (intent) emitAudio({ id: intent.id, type: message ? 'error' : 'stopped', message: text(message, 300) });
  };
  const validAudio = owned => !disposed && capture === owned && audioIntent === owned.intent
    && latestState?.context === owned.intent.context;
  async function petAudio(op, id, seq) {
    if (disposed || !connected || !audioIntent || id !== audioIntent.id || latestState?.context !== audioIntent.context)
      throw Error('语音请求已失效，请重新点击语音输入或通话');
    if (op === 'stop') { stopAudio(); return true; }
    if (op === 'ack') {
      if (!capture || !Number.isInteger(seq) || seq !== capture.ack + 1 || seq > capture.seq) throw Error('语音确认顺序无效');
      capture.ack = seq; return true;
    }
    if (op === 'activate') {
      if (!capture?.ready) throw Error('麦克风尚未就绪');
      capture.active = true; return { sampleRate: 16000, channels: 1, format: 'pcm16' };
    }
    if (op !== 'start' || capture || Date.now() > audioIntent.expires) throw Error('语音请求无效或已经使用');
    const owned = { intent: audioIntent, seq: 0, ack: 0, sum: 0, weight: 0, active: false, ready: false };
    capture = owned;
    const cancelled = () => ({ cancelled: true });
    try {
      owned.timer = setTimeout(() => { if (validAudio(owned)) stopAudio('麦克风启动超时，请重试'); }, 15000);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (!validAudio(owned)) { for (const track of stream.getTracks()) track.stop(); return cancelled(); }
      owned.stream = stream;
      for (const track of stream.getTracks()) track.addEventListener('ended', () => {
        if (validAudio(owned)) stopAudio('麦克风已断开');
      }, { once: true });
      const context = owned.context = new AudioContext({ latencyHint: 'interactive' });
      await Promise.race([context.resume(), new Promise(resolve => { owned.cancelResume = resolve; }), new Promise((_, reject) => {
        owned.resumeTimer = setTimeout(() => reject(Error('音频未能启动，请打开主窗口后重试')), 5000);
      })]).finally(() => clearTimeout(owned.resumeTimer));
      if (!validAudio(owned)) return cancelled();
      if (context.state !== 'running' || !Number.isFinite(context.sampleRate) || context.sampleRate < 8000) throw Error('麦克风音频格式不可用');
      owned.source = context.createMediaStreamSource(stream);
      owned.processor = context.createScriptProcessor(4096, 1, 1);
      owned.silent = context.createGain(); owned.silent.gain.value = 0;
      owned.processor.onaudioprocess = event => {
        if (!validAudio(owned) || !owned.active) return;
        owned.lastAudio = Date.now();
        if (owned.seq - owned.ack >= 16) { stopAudio('语音传输阻塞，录音已停止，请重试'); return; }
        const ratio = context.sampleRate / 16000, samples = [];
        const input = event.inputBuffer.getChannelData(0);
        if (input.length > 16384) { stopAudio('麦克风数据无效'); return; }
        const send = () => {
          if (!samples.length || !validAudio(owned)) return;
          if (owned.seq - owned.ack >= 16) { stopAudio('语音传输阻塞，录音已停止，请重试'); return; }
          emitAudio({ id, type: 'audio', seq: ++owned.seq, samples: samples.splice(0), sampleRate: 16000 });
        };
        for (const value of input) {
          if (!Number.isFinite(value)) { stopAudio('麦克风数据无效'); return; }
          let remaining = 1;
          while (remaining > 1e-10) {
            const weight = Math.min(remaining, ratio - owned.weight);
            owned.sum += value * weight; owned.weight += weight; remaining -= weight;
            if (owned.weight >= ratio - 1e-10) {
              const sample = Math.max(-1, Math.min(1, owned.sum / ratio));
              samples.push(Math.trunc(sample * (sample < 0 ? 32768 : 32767)));
              owned.sum = owned.weight = 0;
              if (samples.length === 4096) send();
            }
          }
        }
        send();
      };
      owned.source.connect(owned.processor); owned.processor.connect(owned.silent); owned.silent.connect(context.destination);
      clearTimeout(owned.timer);
      // A provider which never activates/acknowledges must not retain a live mic.
      owned.timer = setInterval(() => {
        if (validAudio(owned) && owned.active && Date.now() - owned.lastAudio >= 15000) {
          stopAudio('麦克风音频已暂停，请重新开始语音输入'); return;
        }
        if (validAudio(owned) && (!owned.active || owned.seq > owned.ack)) {
          if (++owned.stalled >= 3) stopAudio('语音处理未响应，录音已停止');
        } else owned.stalled = 0;
      }, 5000);
      owned.stalled = 0; owned.lastAudio = Date.now(); owned.ready = true;
      return { sampleRate: 16000, channels: 1, format: 'pcm16' };
    } catch (error) {
      if (!validAudio(owned)) return cancelled();
      stopAudio(String(error?.message || error)); throw error;
    }
  }
  const flush = () => {
    if (connected && listeners.size && latest && !disposed) {
      native('state', latest);
      flushArtwork();
    }
  };
  native('register', (kind, payload) => {
    if (disposed) return;
    if (kind === 'connect') {
      connected = native('connect', payload) === true;
      sentArtwork = null;
      flush(); return;
    }
    if (kind === 'folder-picked' && connected && folderRequest) {
      let result;
      try { result = JSON.parse(payload); } catch { return; }
      if (result?.requestId !== folderRequest.requestId || typeof result.path !== 'string' || result.path.length > 32768
          || typeof result.error !== 'string') return;
      const request = folderRequest; folderRequest = null;
      if (result.error) request.reject(Error(text(result.error, 300)));
      else request.resolve(result.path ? Object.freeze({ path: result.path }) : null);
      return;
    }
    if (kind !== 'command' || !connected) return;
    let command;
    try { command = JSON.parse(payload); } catch { return; }
    if (command.action === 'capture-stop') { stopAudio(); return; }
    if (command.version !== 1 || !['input', 'send', 'stop', 'toggle-target', 'dictation', 'call', 'mute'].includes(command.action)
        || !text(command.context, 160) || !text(command.requestId, 160)) return;
    if (command.petAudio?.version === 1 && ['dictation', 'call'].includes(command.action)
        && latestState?.context === command.context && text(command.petAudio.id, 160)) {
      stopAudio();
      audioIntent = { id: command.petAudio.id, context: command.context, expires: Date.now() + 15000 };
    }
    if (command.action === 'input') {
      confirmedInput = null;
      pendingInput = { id: command.requestId, context: command.context, text: command.text };
    } else if (command.action === 'send') {
      const input = confirmedInput; confirmedInput = null;
      if (!input || input.context !== command.context || latestState?.context !== command.context || latestState.draft !== input.text) {
        native('result', JSON.stringify({ requestId: command.requestId, ok: false,
          error: '网页草稿已改变，尚未发送，请打开 AIChat 核查。' }));
        return;
      }
    }
    for (const listener of listeners) {
      try { Promise.resolve(listener(Object.freeze(command))).catch(() => {}); } catch { /* Independent listeners. */ }
    }
  });
  const bridge = Object.freeze({
    version: 1,
    capabilities: Object.freeze({ floatingPet: true, petTextChatVersion: 1, petMediaChatVersion: 1,
      petDictationAudioVersion: 1, petVoiceAudioVersion: 1, nativeFolderPickerVersion: 1 }),
    pickFolder,
    petAudio,
    onPetAudio(listener) {
      if (typeof listener !== 'function') throw TypeError('需要回调函数');
      audioListeners.add(listener); return () => audioListeners.delete(listener);
    },
    publishPetState(value) {
      if (disposed || value?.version !== 1 || !text(value.context, 160)) return Promise.reject(Error('无效宠物状态'));
      // Keep artwork separate so its PNG cannot crowd out chat/media status.
      const state = {
        version: 1, context: text(value.context, 160),
        target: value.target === 'chat' ? 'chat' : 'persona',
        title: text(value.title, 160), draft: text(value.draft, 32000),
        ready: value.ready === true, busy: value.busy === true,
        richDraft: value.richDraft === true, dictating: value.dictating === true,
        canSwitchTarget: value.canSwitchTarget === true,
        canDictate: value.canDictate !== false, canCall: value.canCall === true,
        petDictationAudioVersion: value.petDictationAudioVersion === 1 ? 1 : 0,
        petVoiceAudioVersion: value.petVoiceAudioVersion === 1 ? 1 : 0,
        voice: { active: value.voice?.active === true, muted: value.voice?.muted === true,
          state: text(value.voice?.state, 40) },
        attention: text(value.attention, 2000), error: text(value.error, 2000),
        reply: text(value.reply?.text, 8000),
        messages: (Array.isArray(value.messages) ? value.messages : []).slice(-8)
          .filter(m => ['user', 'assistant'].includes(m?.role) && typeof m.content === 'string')
          .map(m => ({ role: m.role, content: text(m.content, 4000) })),
      };
      if (latestState && latestState.context !== state.context) { pendingInput = null; confirmedInput = null; stopAudio(); }
      if (latestState?.context !== state.context) latestArtwork = sentArtwork = null;
      latestState = state; latest = JSON.stringify(state); flush();
      artwork?.update(value.pet, state.context);
      return Promise.resolve();
    },
    onPetCommand(listener) {
      if (typeof listener !== 'function') throw TypeError('需要回调函数');
      listeners.add(listener); flush();
      return () => listeners.delete(listener);
    },
    petResult(result) {
      if (!disposed && connected && text(result?.requestId, 160)) {
        if (pendingInput?.id === result.requestId) {
          confirmedInput = result.ok === true ? pendingInput : null;
          pendingInput = null;
        }
        native('result', JSON.stringify({ requestId: text(result.requestId, 160),
          ok: result.ok === true, error: text(result.error, 2000) }));
      }
      return Promise.resolve();
    },
  });
  Object.defineProperty(window, 'aichatDesktop', { value: bridge, enumerable: false, configurable: false, writable: false });
  window.addEventListener('pagehide', () => {
    disposed = true; latest = latestState = pendingInput = confirmedInput = null; listeners.clear();
    folderRequest?.resolve(null); folderRequest = null;
    artwork?.dispose(); latestArtwork = null;
    stopAudio(); audioListeners.clear();
  }, { once: true });
})();
