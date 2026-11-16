// One ordinary editor operation. Only a later read-only verification may acknowledge it.
((request) => {
  if (window !== window.top || !document.hasFocus() || location.href !== request.page ||
      Date.now() > request.expires || typeof request.id !== "string" ||
      typeof request.text !== "string" || !request.text || request.text.length > 64000 || request.text.includes("\0")) return -1;
  const key = "__keepworkComposerDeliveryV1";
  const operations = window[key] || (window[key] = new Map());
  if (!(operations instanceof Map) || operations.has(request.id)) return -1;
  const visible = el => el && !el.closest('[hidden], [inert], [aria-hidden="true"]') &&
    el.getClientRects().length > 0 && getComputedStyle(el).visibility === "visible";
  const editable = el => visible(el) && !el.matches(':disabled, [readonly], input[type=password]') &&
    !el.closest('[aria-disabled="true"], [aria-readonly="true"]') &&
    (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && el.type === "text") || el.isContentEditable);
  const known = '#chatInput, #imageInput, #videoInput, .persona-composer textarea[name="message"], .remote-composer .remote-text-input, .remote-composer .composer-input';
  const dialogs = () => Array.from(document.querySelectorAll('dialog[open], [aria-modal="true"], [role="dialog"], [role="alertdialog"], .ws-modal-overlay'));
  const resolve = () => {
    const remote = document.querySelector('.remote-inline[open]');
    const persona = document.getElementById('personaPage');
    if (visible(remote)) return remote.querySelector('.remote-composer .remote-text-input, .remote-composer .composer-input');
    if (visible(persona)) return persona.querySelector('.persona-composer textarea[name="message"]');
    return ['chatInput', 'imageInput', 'videoInput'].map(id => document.getElementById(id)).find(visible);
  };
  const active = document.activeElement;
  let editor = active?.matches(known) ? active : null;
  if (!editor && active && (active.isContentEditable || active.shadowRoot || active.tagName.includes('-') ||
      active.matches('input, textarea, select, iframe, object, embed, [role="textbox"], [role="searchbox"], [role="combobox"], [role="spinbutton"]'))) return 0;
  if (dialogs().some(dialog => visible(dialog) && !dialog.contains(editor))) return -1;
  if (!editor) editor = resolve();
  if (!editor) return 0; // An older page with no owned composer retains the native path.
  if (!editable(editor)) return -1;
  // A single-line native control cannot preserve this payload's line breaks.
  if (editor instanceof HTMLInputElement && /[\r\n]/.test(request.text)) return 0;
  const needsSentinel = editor.isContentEditable && editor.childNodes.length === 1 && editor.firstChild.nodeName === 'BR';
  const soleSentinel = editor.isContentEditable && editor.childNodes.length === 1 &&
    editor.firstChild.nodeType === Node.TEXT_NODE && editor.firstChild.data === '\u200b';
  // This adapter also excludes caret sentinels when serializing file refs.
  // Unknown editors must never retain a hidden marker after an uncertain edit.
  if ((needsSentinel || soleSentinel) && (editor._fileMentionAdapter !== true || typeof editor.value !== 'string' ||
      (soleSentinel && editor.value !== ''))) return 0;
  const existingSentinel = soleSentinel;
  const selectionBeforeFocus = editor.isContentEditable ? window.getSelection() : null;
  const hadCaret = selectionBeforeFocus?.rangeCount && editor.contains(selectionBeforeFocus.anchorNode) &&
    editor.contains(selectionBeforeFocus.focusNode);
  const retainedRange = hadCaret ? selectionBeforeFocus.getRangeAt(0).cloneRange() : null;
  if (active !== editor) {
    editor.focus({ preventScroll: true });
    if (document.activeElement !== editor || resolve() !== editor) return -1;
  }
  const current = () => window === window.top && document.hasFocus() && location.href === request.page &&
    Date.now() <= request.expires && document.activeElement === editor && editor.isConnected && editable(editor) &&
    !dialogs().some(dialog => visible(dialog) && !dialog.contains(editor));
  if (!current()) return -1;
  const control = editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement;
  const placeholder = !control && editor.childNodes.length === 1 && editor.firstChild.nodeName === 'BR';
  // Match AIChat's text-only value adapter, preserving inline file-reference chips.
  const plain = parent => Array.from(parent.childNodes).map(node =>
    node.nodeType === Node.TEXT_NODE ? node.textContent || '' : node.nodeName === 'BR' ? '\n' :
    node.matches?.('[data-file-ref]') ? '' : node.textContent || '').join('').replace(/\u200b/g, '');
  const nativeValue = control ? Object.getOwnPropertyDescriptor(
    editor instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').get : null;
  const readDom = () => control ? nativeValue.call(editor) :
    editor.childNodes.length === 1 && editor.firstChild.nodeName === 'BR' ? '' : plain(editor);
  const readModel = () => typeof editor.value === 'string' ? editor.value : readDom();
  let before = readDom(), prefix, suffix;
  if (control) {
    const start = editor.selectionStart, end = editor.selectionEnd;
    if (!Number.isInteger(start) || !Number.isInteger(end)) return -1;
    prefix = before.slice(0, start); suffix = before.slice(end);
  } else {
    const selection = window.getSelection();
    if (!selection) return -1;
    if (retainedRange) {
      if (!editor.contains(retainedRange.startContainer) || !editor.contains(retainedRange.endContainer)) return -1;
      selection.removeAllRanges(); selection.addRange(retainedRange);
    } else {
      selection.collapse(editor, editor.childNodes.length);
    }
    if (!selection.rangeCount) return -1;
    if (placeholder || existingSentinel) {
      // Select only the known logical-empty placeholder; nonempty drafts keep
      // their existing caret or selection.
      const empty = document.createRange();
      empty.selectNodeContents(editor);
      selection.removeAllRanges(); selection.addRange(empty);
    }
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return -1;
    const head = range.cloneRange(), tail = range.cloneRange();
    head.selectNodeContents(editor); head.setEnd(range.startContainer, range.startOffset);
    tail.selectNodeContents(editor); tail.setStart(range.endContainer, range.endOffset);
    prefix = placeholder ? '' : plain(head.cloneContents());
    suffix = placeholder ? '' : plain(tail.cloneContents());
  }
  const text = request.text.replace(/\r\n?/g, '\n');
  const expected = prefix + text + suffix;
  const modelBefore = readModel();
  const markupBefore = editor.innerHTML;
  const selectionBefore = control ? [editor.selectionStart, editor.selectionEnd] :
    [getSelection().anchorNode, getSelection().anchorOffset, getSelection().focusNode, getSelection().focusOffset];
  // Programmatic editing does not consistently issue beforeinput in WebKit.
  // Give page validation a veto; this synthetic preflight is never an input ack.
  const changes = new MutationObserver(() => {});
  changes.observe(editor, { subtree: true, childList: true, characterData: true, attributes: true });
  let allowed;
  try {
    allowed = editor.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true, cancelable: true, inputType: 'insertFromPaste', data: text,
    }));
  } finally {
    const mutated = changes.takeRecords().length > 0;
    changes.disconnect();
    if (mutated) allowed = false;
  }
  const selectionAfter = control ? [editor.selectionStart, editor.selectionEnd] :
    [getSelection().anchorNode, getSelection().anchorOffset, getSelection().focusNode, getSelection().focusOffset];
  if (!allowed || !current() || readDom() !== before || readModel() !== modelBefore || editor.innerHTML !== markupBefore ||
      selectionBefore.some((value, index) => value !== selectionAfter[index])) return -1;
  const trustedInputs = [];
  const ordinaryTypes = new Set(['insertText', 'insertParagraph', 'insertLineBreak', 'insertFromPaste', 'insertHTML']);
  const ordinaryInputs = () => trustedInputs.length > 0 && trustedInputs.every(type => ordinaryTypes.has(type));
  const observed = event => { if (event.target === editor && event.isTrusted) trustedInputs.push(event.inputType || ''); };
  editor.addEventListener('input', observed, true);
  const record = { check: () => current() && ordinaryInputs() && readDom() === expected && readModel() === expected, done: false };
  while (operations.size >= 16) operations.delete(operations.keys().next().value);
  operations.set(request.id, record);
  setTimeout(() => { if (operations.get(request.id) === record) operations.delete(request.id); }, 1200);
  let inserted = false;
  let sentinel = existingSentinel ? editor.firstChild : null;
  try {
    if (!current()) return -1;
    if (placeholder) {
      // Make WebKit's structural-BR replacement undo-aware. The page already
      // excludes this caret sentinel from its text adapter. Replace the entire
      // temporary sentinel with the real payload in the next native edit.
      const primed = document.execCommand('insertText', false, '\u200b');
      sentinel = editor.firstChild;
      if (!primed || !ordinaryInputs()) return -1;
    }
    if (sentinel) {
      const stillEmpty = () => current() && editor.childNodes.length === 1 && editor.firstChild === sentinel &&
        sentinel.nodeType === Node.TEXT_NODE && sentinel.data === '\u200b' && editor.value === '';
      if (!stillEmpty()) return -1;
      const range = document.createRange(); range.selectNodeContents(editor);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      if (!stillEmpty()) return -1;
      if (selection.rangeCount !== 1 || selection.isCollapsed) return -1;
      const selected = selection.getRangeAt(0);
      if (selected.compareBoundaryPoints(Range.START_TO_START, range) !== 0 ||
          selected.compareBoundaryPoints(Range.END_TO_END, range) !== 0) return -1;
    }
    // Parse only escaped text, retaining literal LF as AIChat's paste handler does.
    const escaped = text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
    // A paste edit also avoids macOS typing substitutions such as smart quotes.
    inserted = document.execCommand('insertHTML', false, escaped);
  } finally {
    editor.removeEventListener('input', observed, true);
    if (placeholder && sentinel && current() && editor.childNodes.length === 1 && editor.firstChild === sentinel &&
        sentinel.nodeType === Node.TEXT_NODE && sentinel.data === '\u200b' && editor.value === '') {
      // Clear only our exact, still-empty marker. Never select new content or
      // issue a cleanup mutation after focus, ownership or editability changes.
      const range = document.createRange(); range.selectNodeContents(editor);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      if (current() && editor.childNodes.length === 1 && editor.firstChild === sentinel && sentinel.data === '\u200b' &&
          selection.rangeCount === 1 && !selection.isCollapsed &&
          selection.getRangeAt(0).compareBoundaryPoints(Range.START_TO_START, range) === 0 &&
          selection.getRangeAt(0).compareBoundaryPoints(Range.END_TO_END, range) === 0) document.execCommand('delete');
    }
  }
  if (!inserted || !current() || !ordinaryInputs() || readDom() !== expected ||
      ((placeholder || existingSentinel) && editor.textContent.includes('\u200b'))) {
    record.done = true; record.accepted = false; delete record.check; return -1;
  }
  return 1;
})
