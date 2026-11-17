import { invoke } from "@tauri-apps/api/core";

interface Config { device: string; autoStart: boolean }
interface ButtonStatus { supported: boolean; ready: boolean; homeReady?: boolean; clearKey?: string; device: string; error: string }
interface Device { id: string; name: string; connected: boolean }
interface Snapshot { supported: boolean; running: boolean; state: string; error: string; device: string; config: Config; devices?: Device[]; buttons?: ButtonStatus; autoPaused?: boolean }
const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;
function text(id: string, value: string) {
  const element = document.getElementById(id)!;
  if (element.textContent !== value) element.textContent = value;
}
const labels: Record<string, string> = {
  sleeping: "电脑休眠中，唤醒后将重新连接",
  stopped: "已停止", stopping: "正在停止并释放蓝牙连接",
  "waiting-paired": "自动开启已启用 · 等待配对或唤醒遥控器",
  "waiting-selection": "请选择要使用的遥控器",
  "needs-permission": "已检测到遥控器 · 请授权后按住语音键说话",
  "auto-error": "自动开启已暂停 · 可手动启动重试",
  scanning: "正在查找遥控器", connecting: "正在连接蓝牙", "preparing-microphone": "正在准备麦克风…", ready: "已就绪 · 按住语音键说话",
  "no-audio": "未收到遥控器音频 · 请再次按住语音键说话",
  "audio-too-short": "录音太短 · 请按住语音键，说完再松手",
  "silent-audio": "录音音量过低 · 请靠近遥控器麦克风再试",
  recording: "正在听写 · 松手后输入", transcribing: "正在等待最终文字 · 完成后再按 OK",
  pasted: "文字已输入 · 可按 OK 发送", submitted: "已发送回车指令", cleared: "已发送清空指令 · 当前录音/识别已取消",
  "cloud-error": "Keepwork 语音识别中断 · 请查看原因后重新按键",
  busy: "正在识别上一段 · 本次录音未接收", "input-blocked": "当前输入操作未执行",
  reconnecting: "蓝牙已断开，正在重连", error: "语音输入遇到错误",
};
let dirty = false;
let pending = false;
let actionError = "";
let snapshot: Snapshot | undefined;
let actionRevision = 0;
let selectedDevice = "";
let deviceList = "";
let choiceMissing = false;
const picker = document.getElementById("device-picker") as HTMLSelectElement;
function config(): Config { return { device: input("device").value.trim(), autoStart: input("auto-start").checked }; }
function renderDevices(next: Snapshot, replaceConfig: boolean) {
  const devices = next.devices || [];
  if (!dirty || replaceConfig) selectedDevice = devices.find(device => device.id === input("device").value)?.id || "";
  if (selectedDevice && !devices.some(device => device.id === selectedDevice)) {
    selectedDevice = "";
    input("device").value = "";
    dirty = true;
    choiceMissing = true;
  }
  const list = JSON.stringify(devices);
  if (list !== deviceList) {
    deviceList = list;
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = devices.length ? "请选择遥控器…" : "暂无设备列表，请停止输入后刷新";
    picker.replaceChildren(placeholder);
    for (const device of devices) {
      const option = document.createElement("option");
      option.value = device.id;
      const shortId = device.id.length > 20 ? `${device.id.slice(0, 4)}…${device.id.slice(-8)} · ` : "";
      option.textContent = `${shortId}${device.name || "小米遥控器"} · ${device.id}${device.connected ? " · 已连接" : ""}`;
      picker.appendChild(option);
    }
  }
  picker.value = selectedDevice;
  text("selected-device", selectedDevice ? `所选设备 ID：${selectedDevice}` : "");
  picker.disabled = !next.supported || next.running || pending || !devices.length;
  button("connect-device").disabled = !next.supported || next.running || pending || !selectedDevice;
  button("refresh-devices").disabled = !next.supported || next.running || pending;
  document.getElementById("device-selection")!.hidden = !next.supported;
  text("device-help", choiceMissing ? "所选遥控器已不在设备列表中，请唤醒后刷新，或重新选择。"
    : next.state === "waiting-selection" && !devices.length ? "请按键唤醒要使用的遥控器，再点“刷新设备”。"
    : "发现多只遥控器时，请选择后连接。选择会被记住；切换设备前请先停止输入。");
}
function render(next: Snapshot, replaceConfig = false) {
  snapshot = next;
  const status = document.getElementById("status")!;
  text("status", next.state === "stopped" && next.autoPaused ? "本次已停止 · 点击启动可恢复" : labels[next.state] || next.state);
  status.dataset.state = next.state;
  text("error", actionError || next.error || (!next.supported ? "目前支持 Windows 和 macOS。" : ""));
  if (!dirty || replaceConfig) { input("device").value = next.config.device; dirty = false; }
  if (replaceConfig) choiceMissing = false;
  renderDevices(next, replaceConfig);
  (document.getElementById("configuration") as HTMLFieldSetElement).disabled = next.running || pending;
  input("auto-start").checked = next.config.autoStart !== false;
  input("auto-start").disabled = !next.supported || pending;
  button("start").disabled = !next.supported || next.running || pending || choiceMissing || (next.state === "waiting-selection" && !config().device);
  button("start").hidden = next.running;
  button("begin").hidden = !next.running;
  button("begin").disabled = pending || ["sleeping", "stopping", "scanning", "connecting", "preparing-microphone", "reconnecting"].includes(next.state);
  button("stop").disabled = pending || !next.supported || (!next.running && !["sleeping", "reconnecting"].includes(next.state) && (next.config.autoStart === false || next.autoPaused === true));
  document.getElementById("connected-device")!.textContent = next.device ? "当前蓝牙设备：" + next.device : "";
  const keys = next.buttons;
  text("home-help", keys?.homeReady
    ? "短按一次进入桌宠，再按一次回到原会话。关闭桌宠时切换最小化和还原。"
    : "连接一只 RC003 并启动遥控器输入后可用。");
  const clearKeyLabel = keys?.supported ? (keys.clearKey || "返回键") : "语音口令";
  document.getElementById("clear-key")!.textContent = clearKeyLabel;
  document.getElementById("clear-help")!.textContent = keys?.ready
    ? "短按清空当前输入框并取消在途识别；在桌宠中逐次短按清空文字、收起输入框、临时隐藏桌宠。"
    : "单独说“清除提示词”；识别后清空。";
  text("key-status", keys?.error || (keys?.ready
    ? `${clearKeyLabel}已连接 · ${keys.device}`
    : next.running ? `${clearKeyLabel}未连接，可使用语音清除口令。` : "启动后会检测遥控器按键来源。"));
}
async function action(command: "remote_voice_start" | "remote_voice_stop" | "remote_voice_begin_input" | "remote_voice_set_auto_start" | "remote_voice_refresh_devices") {
  if (pending || (command === "remote_voice_start" && (choiceMissing || (snapshot?.state === "waiting-selection" && !config().device)))) return;
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
      const replaceConfig = command === "remote_voice_stop" || (command === "remote_voice_start" && next.state !== "needs-permission");
      if (replaceConfig) dirty = false;
      render(next, replaceConfig);
    }
  } catch (error) { actionError = String(error); }
  finally { pending = false; if (snapshot) render(snapshot); }
}
input("device").addEventListener("input", () => {
  dirty = true;
  choiceMissing = false;
  selectedDevice = "";
  if (snapshot) render(snapshot);
});
picker.onchange = () => {
  selectedDevice = picker.value;
  input("device").value = selectedDevice;
  dirty = true;
  choiceMissing = false;
  actionError = "";
  if (snapshot) render(snapshot);
};
button("connect-device").onclick = () => { if (selectedDevice) void action("remote_voice_start"); };
button("refresh-devices").onclick = () => void action("remote_voice_refresh_devices");
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
