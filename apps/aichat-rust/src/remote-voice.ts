import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface Config { device: string; autoStart: boolean }
interface ButtonStatus { supported: boolean; ready: boolean; homeReady?: boolean; clearKey?: string; device: string; error: string }
interface Device { id: string; name: string; connected: boolean }
interface Snapshot { supported: boolean; running: boolean; state: string; error: string; device: string; config: Config; devices?: Device[]; buttons?: ButtonStatus; autoPaused?: boolean; diagnostic?: string; keyRevision?: number; pressedKeys?: string[] }
interface KeyActivity { revision: number; pressedKeys: string[] }
interface DemoKeyEdge { key: string; pressed: boolean }
const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;
let guideHotspots: HTMLButtonElement[] = [];
let keyRevision = -1;
let nativePressedKeys = new Set<string>();
const demoPressedKeys = new Set<string>();
const pointerPressedKeys = new Map<number, string>();
const keyboardPressedKeys = new Map<string, string>();
let demoMode = false;
function syncPressedHotspots() {
  const pressedKeys = new Set([...nativePressedKeys, ...demoPressedKeys, ...pointerPressedKeys.values(), ...keyboardPressedKeys.values()]);
  // Older local hosts report only that the pad is held.
  document.getElementById("remote-dpad")?.classList.toggle("legacy-pressed",
    pressedKeys.has("dpad") && !["up", "down", "left", "right", "ok"].some(key => pressedKeys.has(key)));
  for (const spot of guideHotspots) {
    const pressed = pressedKeys.has(spot.dataset.key || "");
    spot.classList.toggle("is-pressed", pressed);
    spot.setAttribute("aria-pressed", String(pressed));
  }
}
function applyKeyActivity(activity: KeyActivity) {
  if (!Number.isSafeInteger(activity.revision) || activity.revision <= keyRevision) return;
  keyRevision = activity.revision;
  nativePressedKeys = new Set(activity.pressedKeys);
  syncPressedHotspots();
}
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
    placeholder.textContent = devices.length ? "请选择遥控器…" : "暂无遥控器";
    picker.replaceChildren(placeholder);
    for (const device of devices) {
      const option = document.createElement("option");
      option.value = device.id;
      const suffix = devices.length > 1 && device.id.length > 20 ? device.id.slice(-8) + " · " : "";
      option.textContent = `${suffix}${device.name || "小米遥控器"} · ${device.id}${device.connected ? " · 已连接" : ""}`;
      picker.appendChild(option);
    }
  }
  picker.value = selectedDevice;
  text("selected-device", selectedDevice ? `所选设备 ID：${selectedDevice}` : "");
  picker.disabled = !next.supported || next.running || pending || !devices.length;
  button("connect-device").disabled = !next.supported || next.running || pending || !selectedDevice;
  button("refresh-devices").disabled = !next.supported || next.running || pending;
  document.getElementById("device-selection")!.hidden = !next.supported;
  text("device-help", choiceMissing ? "所选设备已离线，请唤醒后刷新或重新选择。"
    : next.state === "waiting-selection" && !devices.length ? "按键唤醒遥控器，再点“刷新”。"
    : "");
}
function render(next: Snapshot, replaceConfig = false) {
  snapshot = next;
  const status = document.getElementById("status")!;
  text("status", next.state === "stopped" && next.autoPaused ? "本次已停止 · 点击启动可恢复" : labels[next.state] || next.state);
  status.dataset.state = next.state;
  text("error", actionError || next.error || (!next.supported ? "目前支持 Windows 和 macOS。" : ""));
  input("diagnostic").value = next.diagnostic || "";
  document.getElementById("voice-diagnostic")!.hidden = !next.diagnostic;
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
    ? "切换桌宠和聊天窗口"
    : "连接一只 RC003 后可用");
  const clearKeyLabel = keys?.ready ? (keys.clearKey || "返回键") : "语音口令";
  document.getElementById("clear-key")!.textContent = clearKeyLabel;
  document.getElementById("clear-help")!.textContent = keys?.ready
    ? "清空输入并取消听写"
    : "说“清除提示词”清空输入";
  text("key-status", keys?.error || "");
  applyKeyActivity({ revision: next.keyRevision ?? 0, pressedKeys: next.pressedKeys ?? [] });
}
async function action(command: "remote_voice_start" | "remote_voice_stop" | "remote_voice_begin_input" | "remote_voice_set_auto_start" | "remote_voice_refresh_devices") {
  if (demoMode || pending || (command === "remote_voice_start" && (choiceMissing || (snapshot?.state === "waiting-selection" && !config().device)))) return;
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

interface KeyGuide { title: string; desc: string; tone?: "pairing" | "primary" }
const keyGuides: Record<string, KeyGuide> = {
  power: { title: "电源键", desc: "红外开关电视。遥控器直接发给电视的指令在演示中仍然有效。" },
  voice: { title: "语音键", desc: "按住说话，松手输入。双击开始或结束实时通话，朗读时短按打断。", tone: "primary" },
  up: { title: "上方向键", desc: "向上移动或选择。" },
  down: { title: "下方向键", desc: "向下移动或选择。" },
  left: { title: "左方向键", desc: "向左移动或选择。" },
  right: { title: "右方向键", desc: "向右移动或选择。" },
  ok: { title: "OK 键", desc: "确认选择，听写完成后按 OK 发送。" },
  back: { title: "返回键", desc: "Mac 上短按清空输入并取消识别。Windows 请用菜单键 ≡。" },
  volume: { title: "音量键", desc: "调节电脑音量。" },
  home: { title: "主页键（小房子图标）", desc: "短按切换桌宠和聊天窗口（关闭桌宠时最小化/还原）。与菜单键（三条横线图标）同时长按 3～5 秒进入蓝牙配对。", tone: "pairing" },
  menu: { title: "菜单键（三条横线图标）", desc: "Windows 上短按清空输入或退出通话。与主页键（小房子图标）同时长按 3～5 秒进入蓝牙配对。", tone: "pairing" },
  tv: { title: "TV 键", desc: "电视 / 直播功能键，电脑语音输入中未使用。" },
};

const activationKey = (event: KeyboardEvent) => event.key === " " || event.key === "Enter";
const keyId = (event: KeyboardEvent) => event.code || event.key;
const arrowKeys = new Map([["ArrowUp", "up"], ["ArrowDown", "down"], ["ArrowLeft", "left"], ["ArrowRight", "right"]]);

function initDemoMode(guide: HTMLElement, hotspots: HTMLButtonElement[]) {
  const settings = document.getElementById("voice-controls")!;
  const toggle = button("remote-demo-toggle");
  const capturedKeys = new Set<string>();
  let capturedPointer = false;
  let requested = false;
  let endedOnBlur = false;
  let revision = 0;
  let requests = Promise.resolve();

  function show(active: boolean, focus: boolean) {
    demoMode = active;
    settings.inert = active;
    guide.toggleAttribute("data-demo", active);
    toggle.textContent = active ? "退出演示" : "进入演示";
    text("remote-demo-help", active ? "按下按键查看高亮，按 Esc 退出" : endedOnBlur ? "已退出演示，按键已恢复正常。" : "点选按键查看用法");
    if (!active) demoPressedKeys.clear();
    pointerPressedKeys.clear();
    keyboardPressedKeys.clear();
    syncPressedHotspots();
    if (focus) (active ? guide : toggle).focus({ preventScroll: true });
  }

  function setDemo(enabled: boolean, focus = true) {
    if (!focus) {
      if (demoMode || requested) endedOnBlur = true;
      show(false, false);
    }
    if (enabled === requested || (enabled && pending)) return;
    requested = enabled;
    const current = ++revision;
    if (enabled) {
      endedOnBlur = false;
      settings.inert = true;
      toggle.textContent = "取消进入";
      text("remote-demo-help", "正在启用系统按键拦截…");
      actionError = "";
      text("error", "");
    }
    requests = requests.then(async () => {
      if (current !== revision) return;
      try {
        let active = false;
        if (enabled) {
          const feedback = new Channel<DemoKeyEdge>();
          feedback.onmessage = ({ key, pressed }) => {
            if (current !== revision || !requested) return;
            if (key === "ended" || key === "unavailable") {
              ++revision;
              requested = false;
              endedOnBlur = key === "ended";
              show(false, false);
              if (key === "unavailable") {
                actionError = "系统按键拦截已中断，演示已退出。";
                text("error", actionError);
              }
              return;
            }
            if (pressed) demoPressedKeys.add(key);
            else demoPressedKeys.delete(key);
            if (demoMode) syncPressedHotspots();
          };
          active = await invoke<boolean>("remote_voice_enter_demo", { feedback });
        } else {
          await invoke("remote_voice_set_demo_mode", { enabled: false });
        }
        if (current !== revision) return;
        requested = active;
        show(active, focus);
      } catch (error) {
        if (current !== revision) return;
        requested = demoMode && !enabled;
        show(requested, focus);
        actionError = String(error);
        text("error", actionError);
      }
    });
  }

  const block = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const hotspotFor = (target: EventTarget | null) => hotspots.find(spot => spot.contains(target as Node | null));

  toggle.addEventListener("click", () => setDemo(!requested));
  window.addEventListener("blur", () => {
    capturedKeys.clear();
    capturedPointer = false;
    setDemo(false, false);
  });
  document.addEventListener("keydown", event => {
    const id = keyId(event);
    if (!demoMode && !capturedKeys.has(id)) {
      if (requested && event.key === "Escape") {
        block(event);
        setDemo(false);
      }
      return;
    }
    const modified = event.ctrlKey || event.altKey || event.metaKey;
    if (demoMode && event.key === "Tab" && !modified) return;
    block(event);
    if (!demoMode || event.repeat || capturedKeys.has(id)) return;
    capturedKeys.add(id);
    if (event.key === "Escape" || (!modified && event.target === toggle && activationKey(event))) {
      setDemo(false);
    } else if (!modified) {
      const focusedKey = activationKey(event) ? hotspotFor(event.target)?.dataset.key : undefined;
      const key = arrowKeys.get(event.key) ?? focusedKey ?? (event.key === "Enter" ? "ok" : undefined);
      if (key) {
        keyboardPressedKeys.set(id, key);
        syncPressedHotspots();
      }
    }
  }, true);
  document.addEventListener("keyup", event => {
    const id = keyId(event);
    const captured = capturedKeys.delete(id);
    if (demoMode || captured) block(event);
    if (captured && keyboardPressedKeys.delete(id)) syncPressedHotspots();
  }, true);
  for (const type of ["pointerdown", "pointerup", "click", "auxclick", "dblclick", "contextmenu", "dragstart", "beforeinput", "wheel"]) {
    document.addEventListener(type, event => {
      if (!demoMode) {
        if (type === "pointerdown") capturedPointer = false;
        if (type === "click" && capturedPointer && (event as MouseEvent).detail > 0) {
          capturedPointer = false;
          block(event);
        }
        return;
      }
      const pointerEdge = type === "pointerdown" || type === "pointerup";
      if ((type === "click" || pointerEdge) && toggle.contains(event.target as Node | null)) return;
      if (type === "pointerdown") capturedPointer = true;
      if (pointerEdge && hotspotFor(event.target)) event.preventDefault();
      else block(event);
    }, { capture: true, passive: false });
  }
}

function initRemoteGuide() {
  const guide = document.getElementById("remote-guide");
  const card = document.getElementById("remote-key-card");
  const title = document.getElementById("remote-key-title");
  const desc = document.getElementById("remote-key-desc");
  if (!guide || !card || !title || !desc || typeof document.querySelectorAll !== "function") return;
  const hotspots = Array.from(document.querySelectorAll<HTMLButtonElement>(".remote-hotspot"));
  if (!hotspots.length) return;
  guideHotspots = hotspots;
  syncPressedHotspots();
  const pairing: KeyGuide = { title: title.textContent || "", desc: desc.textContent || "", tone: "pairing" };
  let pinned = "";
  const apply = (key: string) => {
    const info = keyGuides[key] || pairing;
    card.dataset.tone = info.tone || "default";
    title.textContent = info.title;
    desc.textContent = info.desc;
    for (const spot of hotspots) {
      spot.classList.toggle("is-active", spot.dataset.key === key && key !== "pairing");
    }
  };
  for (const spot of hotspots) {
    const key = spot.dataset.key || "pairing";
    const releasePointer = (event: PointerEvent) => {
      if (pointerPressedKeys.delete(event.pointerId)) syncPressedHotspots();
    };
    spot.addEventListener("mouseenter", () => apply(key));
    spot.addEventListener("focus", () => apply(key));
    spot.addEventListener("mouseleave", () => apply(pinned || "pairing"));
    spot.addEventListener("blur", () => {
      if (!demoMode) {
        for (const [id, pressed] of keyboardPressedKeys) {
          if (pressed === key) keyboardPressedKeys.delete(id);
        }
      }
      syncPressedHotspots();
      apply(pinned || "pairing");
    });
    spot.addEventListener("click", () => {
      pinned = pinned === key ? "" : key;
      apply(pinned || "pairing");
    });
    spot.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      if (demoMode) spot.focus({ preventScroll: true });
      pointerPressedKeys.set(event.pointerId, key);
      syncPressedHotspots();
      spot.setPointerCapture(event.pointerId);
    });
    spot.addEventListener("pointerup", releasePointer);
    spot.addEventListener("pointercancel", releasePointer);
    spot.addEventListener("lostpointercapture", releasePointer);
    spot.addEventListener("keydown", event => {
      if (activationKey(event) && !event.repeat) {
        keyboardPressedKeys.set(keyId(event), key);
        syncPressedHotspots();
      }
    });
    spot.addEventListener("keyup", event => {
      if (keyboardPressedKeys.delete(keyId(event))) syncPressedHotspots();
    });
  }
  initDemoMode(guide, hotspots);
}
initRemoteGuide();
void listen<KeyActivity>("aichat-desktop:remote-voice-keys", event => applyKeyActivity(event.payload), { target: "remote-voice" }).catch(() => {});
