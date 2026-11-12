import { invoke } from "@tauri-apps/api/core";

interface Config { device: string }
interface Snapshot { supported: boolean; running: boolean; state: string; error: string; device: string; config: Config }
const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;
const labels: Record<string, string> = {
  stopped: "已停止", stopping: "正在停止并释放蓝牙连接",
  scanning: "正在查找遥控器", connecting: "正在连接蓝牙", ready: "已就绪 · 按住语音键说话",
  recording: "正在录音 · 松手后识别", transcribing: "正在通过 Keepwork 识别", pasted: "已粘贴到光标位置",
  "cloud-error": "Keepwork 语音识别未完成 · 请重新录制",
  copied: "已复制文字 · 请在目标输入框手动粘贴", reconnecting: "蓝牙已断开，正在重连", error: "语音输入遇到错误",
};
let dirty = false;
let pending = false;
let actionError = "";
let snapshot: Snapshot | undefined;
function config(): Config { return { device: input("device").value.trim() }; }
function render(next: Snapshot, replaceConfig = false) {
  snapshot = next;
  document.getElementById("status")!.textContent = (labels[next.state] || next.state) + (next.device ? ` · ${next.device}` : "");
  document.getElementById("error")!.textContent = actionError || next.error || (!next.supported ? "目前支持 Windows 和 macOS。" : "");
  if (!dirty || replaceConfig) { input("device").value = next.config.device; dirty = false; }
  (document.getElementById("configuration") as HTMLFieldSetElement).disabled = next.running || pending;
  button("start").disabled = !next.supported || next.running || pending;
  button("stop").disabled = !next.running || pending;
}
async function action(command: string) {
  actionError = "";
  pending = true;
  if (snapshot) render(snapshot);
  try {
    const next = await invoke<Snapshot>(command, command === "remote_voice_stop" ? {} : { config: config() });
    dirty = false;
    render(next, true);
  } catch (error) { actionError = String(error); }
  finally { pending = false; if (snapshot) render(snapshot); }
}
input("device").addEventListener("input", () => { dirty = true; });
button("start").onclick = () => void action("remote_voice_start");
button("stop").onclick = () => void action("remote_voice_stop");
async function refresh() {
  if (!pending) {
    try { render(await invoke<Snapshot>("remote_voice_status")); }
    catch (error) { document.getElementById("error")!.textContent = String(error); }
  }
  window.setTimeout(() => void refresh(), 700);
}
void refresh();
