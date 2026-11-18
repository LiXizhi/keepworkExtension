// Older chat pages send the display Markdown without a separate spoken transcript.
export function petSpokenText(markdown: string): string {
  const prose = markdown
    .replace(/^`{3,}[^\n]*[\s\S]*?(?:^`{3,}[^\n]*$|(?![\s\S]))/gm, " ")
    .replace(/^~{3,}[^\n]*[\s\S]*?(?:^~{3,}[^\n]*$|(?![\s\S]))/gm, " ")
    .replace(/`+[^\n`]*`+/g, " ")
    .replace(/<(?:audio|video|svg|script|style|picture|iframe|object|pre|code|think|tool_calls?)\b[^>]*\/>/gi, " ")
    .replace(/<(audio|video|svg|script|style|picture|iframe|object|pre|code|think|tool_calls?)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, " ")
    .replace(/<!--[\s\S]*?(?:-->|$)|<\/?[a-z][\w:-]*(?:\s[^>]*)?\/?>/gi, " ")
    .replace(/!\[[^\]\n]*\](?:\((?:[^()\n]|\([^()\n]*\))*\)|\[[^\]\n]*\])?/g, " ")
    .replace(/^\s*\[[^\]\n]+\]:[^\n]*/gm, " ")
    .replace(/\[([^\]\n]+)\](?:\((?:[^()\n]|\([^()\n]*\))*\)|\[[^\]\n]*\])/g, "$1")
    .replace(/(?:https?:\/\/|data:[\w/+.-]+[;,])[^\s<>]+/gi, " ")
    .replace(/^(?:[ \t]*[-*_]){3,}[ \t]*$/gm, " ")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/(^|\s)([*_])([^\n]+?)\2(?=[\s.,!?。，！？]|$)/g, "$1$3")
    .trim();
  // Older pages may append a standalone JSON tool payload after the answer.
  const structured = /(?:^|\n)\s*[\[{]/g;
  for (const start of prose.matchAll(structured)) {
    try {
      if (typeof JSON.parse(prose.slice(start.index)) === "object") {
        return prose.slice(0, start.index).replace(/[ \t]+/g, " ").trim();
      }
    } catch { /* Keep ordinary prose with brackets. */ }
  }
  return prose.replace(/[ \t]+/g, " ").trim();
}

interface Narration {
  pause(): void;
  resume(): void;
  cancel(): void;
}

export function startPetNarration(text: string, onEnd: (completed: boolean) => void): Narration | null {
  const synth = window.speechSynthesis;
  const Utterance = window.SpeechSynthesisUtterance;
  if (!text.trim() || !synth || !Utterance) return null;

  // Keep each utterance short enough for system voices with length limits.
  // Prefer the last word or sentence boundary that fits; long unbroken text
  // still advances by whole Unicode code points.
  const chunks = text.trim().match(/[\s\S]{1,179}(?:[\s。！？.!?]|$)|[\s\S]{1,180}/gu) || [];
  if (!chunks.length) return null;
  let language: string | undefined;
  if (/[\u3040-\u30ff]/.test(text)) language = "ja";
  else if (/\p{Script=Hangul}/u.test(text)) language = "ko";
  else if (/\p{Script=Han}/u.test(text)) language = "zh";
  // WebKit and WebView2 can also use the system default while the installed
  // voice list is still loading.
  const voice = synth.getVoices().find(v => v.localService &&
    (language ? v.lang.startsWith(language) : v.default));
  let index = 0;
  let paused = false;
  let closed = false;
  let utterance: SpeechSynthesisUtterance | undefined;
  let timer: number | undefined;

  function finish(completed: boolean, notify = true) {
    if (closed) return;
    closed = true;
    window.clearTimeout(timer);
    // Late events from cancelled speech must not dismiss a subsequent reply.
    if (utterance) utterance.onstart = utterance.onend = utterance.onerror = null;
    if (!completed) {
      synth.cancel();
      if (paused) synth.resume(); // Reset this pet WebView's speech queue for the next turn.
    }
    if (notify) onEnd(completed);
  }
  function watch(ms: number) {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => finish(false), ms);
  }
  function next() {
    const current = new Utterance(chunks[index++]);
    utterance = current;
    if (voice) current.voice = voice;
    if (language) current.lang = voice?.lang || language;
    current.onstart = () => { if (!closed && !paused && utterance === current) watch(90000); };
    current.onerror = () => { if (utterance === current) finish(false); };
    current.onend = () => {
      if (closed || current !== utterance) return;
      window.clearTimeout(timer);
      if (index === chunks.length) finish(true);
      else if (!paused) speakNext();
      else utterance = undefined;
    };
    watch(5000);
    synth.speak(current);
  }
  function speakNext() {
    try { next(); } catch { finish(false); }
  }
  try { next(); } catch { finish(false, false); return null; }
  return {
    pause() {
      if (closed || paused) return;
      paused = true;
      window.clearTimeout(timer);
      synth.pause();
    },
    resume() {
      if (closed || !paused) return;
      paused = false;
      watch(90000);
      synth.resume();
      if (!utterance) speakNext();
    },
    cancel() { finish(false, false); },
  };
}
