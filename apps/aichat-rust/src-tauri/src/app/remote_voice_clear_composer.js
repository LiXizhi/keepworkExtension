// WebKit's DOM editor can own keyboard paste while macOS AX still reports the web area.
(() => {
  if (window !== window.top || !document.hasFocus()) return 0;
  const editor = document.activeElement;
  if (!editor?.matches('#chatInput, #imageInput, #videoInput, .persona-composer textarea[name="message"], .remote-composer .remote-text-input, .remote-composer .composer-input')) return 0;
  if (editor.matches(':disabled, [readonly], input[type=password]') ||
      editor.closest('[hidden], [inert], [aria-hidden="true"], [aria-disabled="true"], [aria-readonly="true"]') ||
      !editor.getClientRects().length || getComputedStyle(editor).visibility !== "visible") return -1;

  const dialogs = document.querySelectorAll('dialog[open], [aria-modal="true"], [role="dialog"], [role="alertdialog"], .ws-modal-overlay');
  if (Array.from(dialogs).some(dialog => !dialog.contains(editor) && dialog.getClientRects().length &&
      !dialog.closest('[hidden], [inert], [aria-hidden="true"]') && getComputedStyle(dialog).visibility !== "hidden")) return -1;

  const textControl = editor instanceof HTMLTextAreaElement || (editor instanceof HTMLInputElement && editor.type === "text");
  if (textControl) {
    if (!editor.value.length) return 1;
    editor.select();
    if (editor.selectionStart !== 0 || editor.selectionEnd !== editor.value.length) return -1;
  } else if (editor.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(editor);
    if (range.collapsed || (editor.childNodes.length === 1 && editor.firstChild.nodeName === "BR")) return 1;
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    if (selection.rangeCount !== 1 || selection.isCollapsed) return -1;
    const selected = selection.getRangeAt(0);
    if (selected.compareBoundaryPoints(Range.START_TO_START, range) !== 0 ||
        selected.compareBoundaryPoints(Range.END_TO_END, range) !== 0) return -1;
  } else {
    return -1;
  }
  if (document.activeElement !== editor || !document.hasFocus()) return -1;
  // Route through WebKit editing so the composer receives its ordinary input event and Undo.
  if (!document.execCommand("delete")) return -1;
  const empty = textControl ? editor.value.length === 0 :
    editor.textContent.length === 0 && !editor.querySelector('[contenteditable="false"], img, video, audio');
  return empty ? 1 : -1;
})()
