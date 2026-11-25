// The map is aligned with the operator's view of the floor. BLE reports gait
// and commanded velocity, but provides no measured position or orientation.
const SIDE = 5;
const CELLS = SIDE * SIDE;
const headings = ["上 ↑", "右 →", "下 ↓", "左 ←"];
const arrows = ["↑", "→", "↓", "←"];
const mapKey = "keepwork.bumi.floor-map.v1";

type Terrain = "floor" | "blocked" | "unknown";
type Cell = { terrain: Terrain; name: string };
type Pose = { cell: number; facing: number };
type Route = { name: string; path: number[]; index: number; facing: number };
type Direction = "forward" | "left" | "right";
type Leg = { direction: Direction; pose: Pose };
const directionLabel: Record<Direction, string> = { forward: "前进", left: "左转", right: "右转" };

function address(cell: number) {
  return String.fromCharCode(65 + cell % SIDE) + (1 + Math.floor(cell / SIDE));
}
function emptyMap(): Cell[] {
  return Array.from({ length: CELLS }, () => ({ terrain: "unknown", name: "" }));
}
function loadMap(): Cell[] {
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(mapKey) || "null");
    if (Array.isArray(saved) && saved.length === CELLS && saved.every(cell =>
      cell && ["floor", "blocked", "unknown"].includes(cell.terrain) && typeof cell.name === "string"
      && cell.name.length <= 16 && (!cell.name || cell.terrain === "floor"))) {
      const names = saved.map(cell => cell.name).filter(Boolean);
      if (new Set(names).size === names.length) return saved;
    }
  } catch { /* Storage may be unavailable in this WebView. */ }
  return emptyMap();
}
function shortestPath(map: Cell[], start: number, goal: number) {
  const parent = new Map([[start, start]]);
  const queue = [start];
  for (let i = 0; i < queue.length; ++i) {
    const cell = queue[i];
    if (cell === goal) {
      const path = [cell];
      while (path[0] !== start) path.unshift(parent.get(path[0])!);
      return path;
    }
    const x = cell % SIDE;
    const neighbors = [cell - SIDE, x + 1 < SIDE ? cell + 1 : -1, cell + SIDE, x > 0 ? cell - 1 : -1];
    for (const next of neighbors) {
      if (map[next]?.terrain !== "floor" || parent.has(next)) continue;
      parent.set(next, cell);
      queue.push(next);
    }
  }
  return [];
}
function nextLeg(route: Route): Leg {
  const current = route.path[route.index];
  const next = route.path[route.index + 1];
  const towards = [-SIDE, 1, SIDE, -1].indexOf(next - current);
  const turn = (towards - route.facing + 4) % 4;
  if (!turn) return { direction: "forward", pose: { cell: next, facing: towards } };
  const left = turn === 3;
  return { direction: left ? "left" : "right", pose: { cell: current, facing: (route.facing + (left ? 3 : 1)) % 4 } };
}

export function createBumiNavigation(driver: { startLeg(direction: Direction, voiceId?: number): boolean; stopLeg(): void; canGuide?(): boolean }) {
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const panel = el<HTMLDetailsElement>("nav-panel");
  const mode = el<HTMLSelectElement>("nav-mode");
  const facing = el<HTMLSelectElement>("nav-facing");
  const nameField = el<HTMLInputElement>("nav-name");
  const grid = el<HTMLElement>("nav-grid");
  const status = el<HTMLElement>("nav-status");
  const drive = el<HTMLButtonElement>("nav-drive");
  const confirm = el<HTMLButtonElement>("nav-confirm");
  const map = loadMap();
  let pose: Pose | null = null;
  let route: Route | null = null;
  let remoteActive = false;
  let moving = false;
  let held: number | "voice" | null = null;
  let holdTimer: number | undefined;
  let motionObserved = false;
  const cells = map.map((_, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.addEventListener("click", () => editCell(index));
    grid.appendChild(button);
    return button;
  });
  function note(message: string) {
    if (status.textContent !== message) status.textContent = message;
    return message;
  }
  function instruction() {
    if (!route) return "";
    const leg = nextLeg(route);
    const target = leg.direction === "forward" ? `前进到 ${address(leg.pose.cell)}`
      : `${leg.direction === "left" ? "左转" : "右转"}到面向地图${headings[leg.pose.facing]}`;
    const controls = driver.canGuide?.() === false
      ? "请按遥控器方向键，停稳后目视确认到位。"
      : "说“执行本段”可点动一次，也可按住按钮（最多 2 秒）。停稳并看到到位后说“已到位”。";
    return `本段${target}。${controls}`;
  }
  function render() {
    const locked = moving || held !== null;
    el("nav-facing-label").hidden = (mode.value || "pose") !== "pose";
    el("nav-name-label").hidden = mode.value !== "goal";
    el<HTMLOptionElement>("nav-goal-option").disabled = remoteActive;
    mode.disabled = facing.disabled = nameField.disabled = locked;
    el("nav-route").hidden = !route;
    if (route) {
      el("nav-path").textContent = `去${route.name} · ${route.path.slice(route.index).map(address).join(" → ")}`;
      const leg = nextLeg(route);
      drive.textContent = "按住" + directionLabel[leg.direction];
      // Do not disable the captured button mid-press: pointerup releases it.
      drive.disabled = held === "voice" || (held === null && (!remoteActive || moving || driver.canGuide?.() === false));
      confirm.disabled = locked || !motionObserved || !remoteActive;
      confirm.textContent = leg.direction === "forward" ? `确认到达 ${address(leg.pose.cell)}` : `确认面向${headings[leg.pose.facing]}`;
    }
    cells.forEach((button, index) => {
      const cell = map[index];
      const isPose = pose?.cell === index;
      const tag = isPose ? "机器人" + arrows[pose!.facing] : cell.terrain === "floor" ? "通行" : cell.terrain === "blocked" ? "障碍" : "未标";
      button.textContent = `${address(index)} · ${cell.name || tag}${isPose && cell.name ? " " + tag : ""}`;
      button.dataset.terrain = cell.terrain;
      button.dataset.pose = String(isPose);
      button.dataset.route = String(!!route?.path.slice(route.index).includes(index));
      button.disabled = locked;
    });
  }
  function release() {
    if (held === null) return;
    const id = held;
    held = null;
    window.clearTimeout(holdTimer);
    holdTimer = undefined;
    if (typeof id === "number" && drive.hasPointerCapture(id)) drive.releasePointerCapture(id);
    driver.stopLeg();
    render();
  }
  function invalidatePose() {
    release();
    route = null;
    pose = null;
    motionObserved = false;
    note("请根据现场重新标记机器人所在格和朝向。");
    render();
  }
  function editCell(index: number) {
    if (moving || held !== null) return;
    const cell = map[index];
    const tool = mode.value || "pose";
    if ((tool === "pose" || tool === "goal") && cell.terrain === "blocked") {
      note("这一格标有障碍物。请核对现场并修正地图。");
      return;
    }
    const name = nameField.value.trim();
    if (tool === "goal" && (remoteActive || !name || name.length > 16 ||
      map.some((item, pos) => pos !== index && item.name === name))) {
      note(remoteActive ? "请关闭遥控后添加地点名称。" : "请输入唯一的地点名称，最多 16 个字。");
      return;
    }
    route = null;
    motionObserved = false;
    switch (tool) {
      case "pose": {
        const heading = Number(facing.value);
        if (!Number.isInteger(heading) || heading < 0 || heading > 3) return;
        cell.terrain = "floor";
        pose = { cell: index, facing: heading };
        note(`已定位到 ${address(index)}，面向地图${headings[heading]}。`);
        break;
      }
      case "goal":
        cell.terrain = "floor";
        cell.name = name;
        note(`地点“${name}”在 ${address(index)}。可说“走到${name}”。`);
        break;
      case "floor":
      case "blocked":
      case "unknown":
        cell.terrain = tool;
        if (tool !== "floor") {
          cell.name = "";
          if (pose?.cell === index) pose = null;
        }
        note(`已更新 ${address(index)}。`);
        break;
      default: return;
    }
    try { window.localStorage.setItem(mapKey, JSON.stringify(map)); } catch { /* Keep session map. */ }
    render();
  }
  function plan(name: string) {
    panel.open = true;
    if (moving || held !== null) return note("先松开移动控制，等机器人停稳再规划。");
    route = null;
    motionObserved = false;
    render();
    if (!pose) return note("请在场地地图上标记机器人当前所在格和朝向，再说出目的地。");
    const destination = name.trim();
    const target = map.findIndex(cell => cell.name && cell.name === destination);
    if (target < 0) return note(`未标记地点“${destination}”。${remoteActive ? "关闭遥控后，" : ""}在场地地图上命名目的地。`);
    if (target === pose.cell) return note(`按上次现场确认的位置，机器人已在${destination}（${address(target)}）。`);
    const path = shortestPath(map, pose.cell, target);
    if (!path.length) return note("没有已标记为可通行的路线。请核对现场并补全通道。");
    route = { name: destination, path, index: 0, facing: pose.facing };
    render();
    return note((remoteActive ? "" : "开启方向键遥控后可按住执行。") + instruction());
  }
  function beginLeg(owner: number | "voice", voiceId?: number): string {
    if (!remoteActive || !route) return note("请先开启遥控并说出要去的地点。");
    if (held !== null || moving) return note("请先等机器人停稳。");
    if (driver.canGuide?.() === false) return note("请用遥控器方向键完成本段。");
    if (typeof owner === "number") {
      try { drive.setPointerCapture(owner); }
      catch { return note("未按住移动按钮，请再试一次。"); }
    }
    held = owner;
    const { direction } = nextLeg(route);
    if (!driver.startLeg(direction, voiceId)) {
      held = null;
      if (typeof owner === "number" && drive.hasPointerCapture(owner)) drive.releasePointerCapture(owner);
      render();
      return note("本段未启动。请松开方向键并确认遥控与步态已就绪。");
    }
    if (held !== owner) return note("本段已中断，请核对机器人位置。");
    holdTimer = window.setTimeout(release, owner === "voice" ? 400 : 2000);
    motionStarted();
    if (owner === "voice") {
      return note(`已请求${directionLabel[direction]}一次。停稳后，若还差一点可再说“执行本段”，目视到位后说“已到位”。`);
    }
    return note(instruction());
  }
  drive.addEventListener("pointerdown", event => {
    if (event.button !== 0 || !event.isPrimary || held !== null) return;
    event.preventDefault();
    beginLeg(event.pointerId);
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
    drive.addEventListener(type, event => { if (event.pointerId === held) release(); });
  }
  drive.addEventListener("contextmenu", event => event.preventDefault());
  drive.addEventListener("blur", () => { if (typeof held === "number") release(); });
  panel.addEventListener("toggle", () => { if (!panel.open) release(); });
  window.addEventListener("blur", release);
  window.addEventListener("pagehide", release);
  document.addEventListener("visibilitychange", () => { if (document.hidden) release(); });
  el("nav-cancel").addEventListener("click", () => {
    release();
    route = null;
    motionObserved = false;
    note("路线已取消。");
    render();
  });
  function confirmStep(): string {
    if (!route || !remoteActive) return note("当前没有正在执行的路线。");
    if (moving || held !== null) return note("请先等机器人停稳。");
    if (!motionObserved) return note("本段还未移动，请先执行本段。");
    const leg = nextLeg(route);
    pose = leg.pose;
    route.facing = pose.facing;
    if (leg.direction === "forward") ++route.index;
    motionObserved = false;
    if (route.index === route.path.length - 1) {
      const arrival = `现场已确认到达${route.name}（${address(pose.cell)}）。`;
      route = null;
      render();
      return note(arrival);
    }
    render();
    return note(instruction());
  }
  confirm.addEventListener("click", () => { if (!confirm.disabled) confirmStep(); });
  mode.addEventListener("change", render);
  function motionStarted() {
    if (!pose && (!route || motionObserved)) return;
    pose = null;
    motionObserved = !!route;
    note(route ? instruction() : "机器人位置已改变，请在规划前重新标记。");
    render();
  }
  render();
  return {
    plan, voiceStep: (voiceId: number) => beginLeg("voice", voiceId), confirmStep, motionStarted, invalidatePose, interruptLeg: release,
    setRemoteActive(active: boolean) {
      if (active === remoteActive) return;
      remoteActive = active;
      if (!active) invalidatePose();
      else if (mode.value === "goal") mode.value = "pose";
      el(active ? "nav-shield" : "nav-home").appendChild(panel);
      if (route) note(instruction());
      render();
    },
    setMoving(active: boolean) {
      if (active === moving) return;
      moving = active;
      render();
    },
  };
}
