// Evaluated only in the foreground AIChat main document, without the transcript.
(() => {
  if (window !== window.top || !document.hasFocus()) return false;

  const visible = el => el && !el.closest('[hidden], [inert], [aria-hidden="true"]')
    && el.getClientRects().length > 0 && getComputedStyle(el).visibility === "visible";
  const editable = el => el && !el.matches(":disabled") && !el.disabled && !el.readOnly
    && !el.closest('[aria-disabled="true"], [aria-readonly="true"]')
    && (el.isContentEditable || el.tagName === "TEXTAREA"
      || (el.tagName === "INPUT" && /^(text|search|url|tel|email|password|number)$/.test(el.type)));

  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  if (visible(active) && (editable(active) || active.tagName === "IFRAME")) return true;

  const blocked = Array.from(document.querySelectorAll(
    'dialog[open], [aria-modal="true"], [role="dialog"], [role="alertdialog"], .ws-modal-overlay'
  )).some(visible);
  if (blocked) return false;

  const persona = document.getElementById("personaPage");
  const remote = document.querySelector(".remote-inline[open]");
  let composer;
  if (visible(remote)) {
    composer = remote.querySelector(".remote-composer .remote-text-input, .remote-composer .composer-input");
  } else if (visible(persona)) {
    composer = persona.querySelector('.persona-composer textarea[name="message"]');
  } else {
    composer = ["chatInput", "imageInput", "videoInput"].map(id => document.getElementById(id)).find(visible);
  }
  if (!visible(composer) || !editable(composer)) return false;

  const selection = composer.isContentEditable ? window.getSelection() : null;
  const hadCaret = selection && composer.contains(selection.anchorNode) && composer.contains(selection.focusNode);
  composer.focus({ preventScroll: true });
  if (document.activeElement !== composer) return false;
  if (selection && !hadCaret) selection.collapse(composer, composer.childNodes.length);
  return true;
})()
