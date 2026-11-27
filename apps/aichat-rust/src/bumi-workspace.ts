// The native control window requires its exact URL, including an empty fragment.
// Scroll within the document so that navigating never reloads a live connection.
export function bindSectionShortcuts() {
  const toolbar = document.getElementById("control-toolbar")!;
  const sections = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-bumi-target]"), control => ({
    control, target: document.getElementById(control.dataset.bumiTarget!)!,
  }));
  if (!sections.length) return;
  function markVisibleSection() {
    const edge = toolbar.getBoundingClientRect().bottom + 12;
    let active = sections[0];
    for (const section of sections) {
      if (section.target.getBoundingClientRect().top <= edge) active = section;
    }
    if (window.scrollY > 0 && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) {
      active = sections[sections.length - 1];
    }
    for (const section of sections) {
      if (section === active) section.control.setAttribute("aria-current", "location");
      else section.control.removeAttribute("aria-current");
    }
  }
  function updateToolbarHeight() {
    document.documentElement.style.setProperty("--toolbar-height", toolbar.offsetHeight + "px");
    markVisibleSection();
  }
  for (const { control, target } of sections) {
    control.addEventListener("click", () => {
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: "start" });
      markVisibleSection();
    });
  }
  if (typeof ResizeObserver === "function") new ResizeObserver(updateToolbarHeight).observe(toolbar);
  else window.addEventListener("resize", updateToolbarHeight);
  window.addEventListener("scroll", markVisibleSection, { passive: true });
  updateToolbarHeight();
}

export function bindStickHorizontal(onChange: () => void) {
  const fieldset = document.getElementById("stick-horizontal") as HTMLFieldSetElement;
  const yaw = document.getElementById("stick-yaw") as HTMLInputElement;
  const lateral = document.getElementById("stick-lateral") as HTMLInputElement;
  const status = document.getElementById("stick-status")!;
  let lateralSelected = false;

  for (const input of [yaw, lateral]) {
    input.addEventListener("change", () => {
      if (!fieldset.disabled && input.checked) lateralSelected = input === lateral;
      onChange();
    });
  }

  return {
    get lateral() { return lateralSelected; },
    sync({ connected, supportsLateral, gaitSelected, locked }: {
      connected: boolean; supportsLateral: boolean; gaitSelected: boolean; locked: boolean;
    }) {
      if (!connected || !supportsLateral) lateralSelected = false;
      fieldset.disabled = !supportsLateral || locked;
      yaw.checked = !lateralSelected;
      lateral.checked = lateralSelected;
      const hint = !connected ? "连接机器人并选择步态后可使用。"
        : !supportsLateral ? "当前连接的左右操作仅支持转向。"
        : !gaitSelected ? "选择步态后可切换。" : "";
      if (status.textContent !== hint) status.textContent = hint;
    },
  };
}

export interface Device { id: string; name: string; rssi: number | null }

let deviceList = "";
export function renderDevices(picker: HTMLSelectElement, devices: Device[]) {
  const selected = picker.value;
  const serialized = JSON.stringify(devices);
  if (serialized !== deviceList) {
    deviceList = serialized;
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = devices.length ? "请选择机器人…" : "未发现 Bumi 设备";
    picker.replaceChildren(placeholder);
    for (const device of devices) {
      const option = document.createElement("option");
      option.value = device.id;
      option.textContent = `${device.name}${device.rssi === null ? "" : ` · ${device.rssi} dBm`}`;
      picker.appendChild(option);
    }
  }
  if (devices.some(device => device.id === selected)) picker.value = selected;
  const device = devices.find(item => item.id === picker.value);
  document.getElementById("device-id")!.textContent = device ? `设备 ID：${device.id}` : "";
}

export const commandLabels: Record<string, string> = {
  battery: "电量已更新", status: "状态已更新", dance: "跳舞指令已发送",
  wave: "挥手指令已发送", handshake: "握手指令已发送", cheer: "欢呼指令已发送",
  standUp: "一键起身指令已发送", standToFall: "一键收纳指令已发送，请在完成后扶稳机器人。",
  walk: "行走模式指令已发送。",
  run: "全身行走模式指令已发送。",
  startTeach: "示教录制已开始，请手动引导 Bumi 手臂摆动。",
  stopTeach: "示教录制已停止。",
  saveTeach: "示教动作保存指令已发送。",
  teachList: "示教动作库已刷新。",
  volume: "音量指令已发送", speak: "说话指令已发送",
};

// BLE status labels used by NOETIX Run 3.2.2 for the gait and power states.
export const bleStatusLabels: Record<number, string> = {
  0: "未启动", 1: "准备", 2: "行走", 3: "全身行走", 26: "保护", 30: "失能",
};
