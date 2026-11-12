import { invoke } from "@tauri-apps/api/core";

interface Config { device: string; autoStart: boolean }
interface ButtonStatus { supported: boolean; ready: boolean; device: string; error: string }
interface Snapshot { supported: boolean; running: boolean; state: string; error: string; device: string; config: Config; buttons?: ButtonStatus; autoPaused?: boolean }
const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;
function text(id: string, value: string) {
  const element = document.getElementById(id)!;
  if (element.textContent !== value) element.textContent = value;
}
const labels: Record<string, string> = {
  stopped: "已停止", stopping: "正在停止并释放蓝牙连接",
  "waiting-paired": "自动开启已启用 · 等待配对或唤醒遥控器",
  "auto-error": "自动开启已暂停 · 可手动启动重试",
  scanning: "正在查找遥控器", connecting: "正在连接蓝牙", ready: "已就绪 · 按住语音键说话",
  recording: "正在录音 · 松手后识别", transcribing: "正在通过 Keepwork 识别 · 完成后再按 OK",
  pasted: "文字已输入 · 可按 OK 发送", submitted: "已发送回车指令", cleared: "已发送清空指令 · 当前录音/识别已取消",
  "cloud-error": "Keepwork 语音识别未完成 · 请重新录制",
  busy: "正在识别上一段 · 本次录音未接收", "input-blocked": "当前输入操作未执行",
  reconnecting: "蓝牙已断开，正在重连", error: "语音输入遇到错误",
};
let dirty = false;
let pending = false;
let actionError = "";
let snapshot: Snapshot | undefined;
let actionRevision = 0;
function config(): Config { return { device: input("device").value.trim(), autoStart: input("auto-start").checked }; }
function render(next: Snapshot, replaceConfig = false) {
  snapshot = next;
  const status = document.getElementById("status")!;
  text("status", next.state === "stopped" && next.autoPaused ? "本次已停止 · 点击启动可恢复" : labels[next.state] || next.state);
  status.dataset.state = next.state;
  text("error", actionError || next.error || (!next.supported ? "目前支持 Windows 和 macOS。" : ""));
  if (!dirty || replaceConfig) { input("device").value = next.config.device; dirty = false; }
  (document.getElementById("configuration") as HTMLFieldSetElement).disabled = next.running || pending;
  input("auto-start").checked = next.config.autoStart !== false;
  input("auto-start").disabled = !next.supported || pending;
  button("start").disabled = !next.supported || next.running || pending;
  button("start").hidden = next.running;
  button("begin").hidden = !next.running;
  button("begin").disabled = pending || ["stopping", "scanning", "connecting", "reconnecting"].includes(next.state);
  button("stop").disabled = pending || !next.supported || (!next.running && (next.config.autoStart === false || next.autoPaused === true));
  document.getElementById("connected-device")!.textContent = next.device ? "当前蓝牙设备：" + next.device : "";
  const keys = next.buttons;
  document.getElementById("clear-key")!.textContent = keys?.supported ? "返回键" : "语音口令";
  document.getElementById("clear-help")!.textContent = keys?.ready
    ? "短按返回键；会取消尚未完成的录音和识别。"
    : "单独说“清除提示词”；识别后清空。";
  text("key-status", keys?.error || (keys?.ready
    ? "返回键已连接 · " + keys.device
    : next.running ? "返回键未连接，可使用语音清除口令。" : "启动后会检测返回键；OK 使用系统原生回车。"));
}
async function action(command: "remote_voice_start" | "remote_voice_stop" | "remote_voice_begin_input" | "remote_voice_set_auto_start") {
  const enabled = input("auto-start").checked;
  actionRevision++;
  actionError = "";
  pending = true;
  if (snapshot) render(snapshot);
  try {
    if (command === "remote_voice_begin_input") {
      await invoke(command);
    } else {
      const next = await invoke<Snapshot>(command, command === "remote_voice_start" ? { config: config() } : command === "remote_voice_set_auto_start" ? { enabled } : {});
      if (command !== "remote_voice_set_auto_start") dirty = false;
      render(next, command !== "remote_voice_set_auto_start");
    }
  } catch (error) { actionError = String(error); }
  finally { pending = false; if (snapshot) render(snapshot); }
}
input("device").addEventListener("input", () => { dirty = true; });
input("auto-start").onchange = () => void action("remote_voice_set_auto_start");
button("start").onclick = () => void action("remote_voice_start");
button("stop").onclick = () => void action("remote_voice_stop");
button("begin").onclick = () => void action("remote_voice_begin_input");
async function refresh() {
  if (!pending) {
    const revision = actionRevision;
    try {
      const next = await invoke<Snapshot>("remote_voice_status");
      if (!pending && revision === actionRevision) render(next);
    }
    catch (error) { document.getElementById("error")!.textContent = String(error); }
  }
  window.setTimeout(() => void refresh(), 300);
}
void refresh();
