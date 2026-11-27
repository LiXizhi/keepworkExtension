import { createLocalBumiVoiceInput, type VoicePhase } from "./bumi-voice-input";

interface VoiceControlOptions {
  note(message: string): void;
  refreshTarget(): void;
}

export function createBumiVoiceControl(options: VoiceControlOptions) {
  const command = document.getElementById("voice-command") as HTMLInputElement;
  const control = document.getElementById("voice-input") as HTMLButtonElement;
  let phase: VoicePhase = "idle";

  function render() {
    const active = phase !== "idle";
    control.dataset.state = phase;
    control.setAttribute("aria-pressed", String(active));
    control.textContent = phase === "recording" ? "结束并识别" : phase === "starting" ? "取消语音输入" : phase === "transcribing" ? "取消识别" : "语音输入";
    command.readOnly = active;
    (document.getElementById("voice-run") as HTMLButtonElement).disabled = active;
    options.refreshTarget();
    if (active) (document.getElementById("vision-inspect-classroom") as HTMLButtonElement).disabled = true;
  }

  const input = createLocalBumiVoiceInput({
    onPhase(next, message) {
      phase = next;
      if (message) options.note(message);
      render();
    },
    onPreview(preview) { options.note(`正在听写：${preview.slice(-160)}`); },
    onResult(transcript) {
      const words = Array.from(transcript);
      command.value = words.slice(0, 128).join("");
      command.dispatchEvent(new Event("input", { bubbles: true }));
      options.note(`语音已填入，请核对后点击“只识别，不移动”或“执行指令”。${words.length > 128 ? "超过 128 字的末尾未填入。" : ""}`);
      command.focus();
    },
  });

  control.addEventListener("click", () => input.toggle());
  window.addEventListener("blur", () => {
    if (phase !== "starting") input.cancel("Bumi 窗口已失去焦点，语音输入已停止。");
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) input.cancel("Bumi 窗口已隐藏，语音输入已停止。");
  });
  window.addEventListener("pagehide", () => input.cancel());

  return { active: input.active, render };
}
