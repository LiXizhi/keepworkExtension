const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const read = name => fs.readFileSync(path.join(__dirname, "..", name), "utf8");
const html = read("bumi-control.html");
const script = ts.transpileModule(read("src/bumi-box-link.ts"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const settle = () => new Promise(resolve => setImmediate(resolve));

class Control extends EventTarget {
  children = [];
  dataset = {};
  value = "";
  textContent = "";
  replaceChildren(...children) { this.children = children; }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); return child; }
  focus() {}
  fire(type) { this.dispatchEvent(new Event(type, { cancelable: true })); }
}

function loadRenderer(respond) {
  const fields = new Map();
  for (const [tag, id] of html.matchAll(/<[^>]+\bid="(box-link-[^"]+)"[^>]*>/g)) {
    fields.set(id, Object.assign(new Control(), {
      hidden: /\shidden\b/.test(tag), disabled: /\sdisabled\b/.test(tag),
    }));
  }
  const calls = [];
  const cameraCalls = [];
  const pendingPolls = new Map();
  let pollId = 0;
  const window = Object.assign(new Control(), {
    setInterval(callback) { pendingPolls.set(++pollId, callback); return pollId; },
    clearInterval(id) { pendingPolls.delete(id); },
  });
  const document = Object.assign(new Control(), {
    getElementById: id => fields.get(id), createElement: () => new Control(),
  });
  class Channel {}
  vm.runInNewContext(script, {
    exports: {}, document, window,
    require(name) {
      assert.equal(name, "@tauri-apps/api/core");
      return { Channel, async invoke(command, args) {
        if (command === "bumi_box_camera") {
          cameraCalls.push({ enabled: args.enabled, frames: args.frames });
          return null;
        }
        assert.equal(command, "bumi_box_link");
        const call = JSON.parse(JSON.stringify(args.request));
        calls.push(call);
        return await respond(call);
      } };
    },
  });
  const field = id => fields.get("box-link-" + id);
  return {
    calls, cameraCalls, field, boxCamera: () => window.__keepworkBoxCamera,
    async fire(id, event) { field(id).fire(event); await settle(); },
    async poll() { for (const callback of pendingPolls.values()) callback(); await settle(); },
  };
}

const hotspotBox = { ip: "192.168.5.1", port: 8080, id: "8D91", name: "Bumi 8D91", firmware: "1.0.0" };
const routerBox = { ip: "192.168.1.23", port: 8080, id: "8D92", name: "Bumi 8D92" };
const boxHotspot = { ssid: "xiaozhi-box-8D91", rssi: -52, channel: 6, band: "ghz2", security: "open", isBox: true };
const routerNetwork = { ssid: "Home-5G", rssi: -61, channel: 36, band: "ghz5", security: "wpa2", isBox: false };

test("hotspot names need the usage description, location entitlement, and main-thread prompt", () => {
  const plist = read("src-tauri/Info.plist");
  const entitlements = read("src-tauri/entitlements.mac.plist");
  const macScanner = read("src-tauri/src/app/box_wifi_macos.m");
  assert.match(plist, /CFBundleIdentifier/);
  assert.match(plist, /NSLocationUsageDescription/);
  assert.match(plist, /NSLocationWhenInUseUsageDescription/);
  assert.match(entitlements, /com\.apple\.security\.personal-information\.location/);
  assert.match(read("src-tauri/build.rs"), /src\/app\/box_wifi_macos\.m/);
  assert.match(macScanner, /dispatch_get_main_queue\(\)/);
  assert.match(macScanner, /requestWhenInUseAuthorization/);
  assert.doesNotMatch(macScanner, /\[NSDate\s+date\]\s*</);
  assert.match(html, /id="box-link-wifi-scan"/);
  assert.match(html, /<ul id="box-link-wifi-list" class="wifi-list"/);
  assert.match(read("src/bumi-control.css"), /\.wifi-list li\.box \.wifi-name/);
});

test("the video and voice box panel can scan, select and connect independently from BLE", async () => {
  const ui = loadRenderer(({ operation }) => {
    if (operation === "status") return {};
    if (operation === "scan") return [routerBox, hotspotBox];
    if (operation === "connect") return hotspotBox;
    assert.fail(`Unexpected operation ${operation}`);
  });
  await settle();
  await ui.fire("scan", "click");
  assert.deepEqual(ui.calls.map(call => call.operation), ["status", "scan"]);
  assert.equal(ui.field("devices").hidden, false);
  assert.ok(ui.field("picker").children.some(option => option.value === hotspotBox.ip));
  ui.field("picker").value = hotspotBox.ip;
  await ui.fire("picker", "change");
  assert.equal(ui.field("ip").value, hotspotBox.ip);
  assert.equal(ui.calls.length, 2);

  await ui.fire("form", "submit");
  assert.equal(ui.calls.at(-1).operation, "connect");
  assert.equal(ui.calls.at(-1).ip, hotspotBox.ip);
  assert.match(ui.field("state").textContent, /已连接/);
  assert.equal(ui.field("disconnect").hidden, false);
});

test("an empty scan leaves manual entry available and a single result fills the address", async () => {
  let discoveries = [];
  const ui = loadRenderer(({ operation }) => {
    if (operation === "status") return {};
    if (operation === "scan") return discoveries;
    assert.fail(`Unexpected operation ${operation}`);
  });
  await settle();
  await ui.fire("scan", "click");
  assert.equal(ui.field("devices").hidden, true);
  assert.equal(ui.field("ip").disabled, false);
  assert.match(ui.field("status").textContent, /手动输入/);

  discoveries = [hotspotBox];
  await ui.fire("scan", "click");
  assert.equal(ui.field("ip").value, hotspotBox.ip);
  assert.equal(ui.field("connect").disabled, false);
  assert.deepEqual(ui.calls.map(call => call.operation), ["status", "scan", "scan"]);
});

test("a remembered box reconnects once and stops showing connected when the native link drops", async () => {
  let connected;
  let dropped = false;
  const ui = loadRenderer(({ operation }) => {
    if (operation === "status") return {
      last: { ip: routerBox.ip, id: routerBox.id }, connected,
      ...(dropped && { disconnectReason: "盒子网络已中断。" }),
    };
    if (operation === "connect") return connected = routerBox;
    assert.fail(`Unexpected operation ${operation}`);
  });
  await settle();
  assert.deepEqual(ui.calls.map(call => call.operation), ["status", "connect"]);
  assert.equal(ui.calls[1].ip, routerBox.ip);
  assert.equal(ui.calls[1].expectedId, routerBox.id);
  assert.match(ui.field("state").textContent, /已连接/);

  connected = undefined;
  dropped = true;
  await ui.poll();
  assert.doesNotMatch(ui.field("state").textContent, /已连接/);
  assert.match(ui.field("status").textContent, /网络已中断/);
  assert.equal(ui.calls.filter(call => call.operation === "connect").length, 1);
});

test("a remembered protected box waits for a key and a failed connection can be retried", async () => {
  let attempts = 0;
  const ui = loadRenderer(({ operation }) => {
    if (operation === "status") return { last: { ip: hotspotBox.ip, requiresKey: true } };
    if (operation === "connect") {
      if (++attempts === 1) throw "盒子拒绝了配对密钥。";
      return hotspotBox;
    }
    if (operation === "disconnect") return null;
    assert.fail(`Unexpected operation ${operation}`);
  });
  await settle();
  assert.equal(ui.field("ip").value, hotspotBox.ip);
  assert.equal(ui.field("key").value, "");
  assert.deepEqual(ui.calls.map(call => call.operation), ["status"]);

  ui.field("key").value = "wrong-test-key";
  await ui.fire("form", "submit");
  assert.equal(ui.calls.at(-1).key, "wrong-test-key");
  assert.match(ui.field("status").textContent, /拒绝了配对密钥/);
  assert.equal(ui.field("connect").disabled, false);
  assert.doesNotMatch(ui.field("state").textContent, /已连接/);

  ui.field("key").value = "correct-test-key";
  await ui.fire("form", "submit");
  assert.equal(ui.calls.at(-1).key, "correct-test-key");
  assert.match(ui.field("state").textContent, /已连接/);
  await ui.fire("disconnect", "click");
  assert.equal(ui.calls.at(-1).operation, "disconnect");
  assert.doesNotMatch(ui.field("state").textContent, /已连接/);
});

test("cancelling a pending connection ignores a late reply and allows another attempt", async () => {
  let resolveConnection;
  const ui = loadRenderer(({ operation }) => {
    if (operation === "status") return {};
    if (operation === "connect") return new Promise(resolve => { resolveConnection = resolve; });
    if (operation === "disconnect") return null;
    assert.fail(`Unexpected operation ${operation}`);
  });
  await settle();
  ui.field("ip").value = routerBox.ip;
  await ui.fire("form", "submit");
  assert.equal(ui.field("cancel").hidden, false);
  await ui.fire("cancel", "click");
  resolveConnection(routerBox);
  await settle();
  assert.deepEqual(ui.calls.map(call => call.operation), ["status", "connect", "disconnect"]);
  assert.match(ui.field("status").textContent, /已取消/);
  assert.doesNotMatch(ui.field("state").textContent, /已连接/);
  assert.equal(ui.field("connect").disabled, false);
});

test("an empty address lets the desktop search the network before connecting", async () => {
  const ui = loadRenderer(({ operation }) => {
    if (operation === "status") return {};
    if (operation === "connect") return routerBox;
    assert.fail(`Unexpected operation ${operation}`);
  });
  await settle();
  ui.field("ip").value = "999.1.1.1";
  await ui.fire("form", "submit");
  assert.deepEqual(ui.calls.map(call => call.operation), ["status"]);
  assert.match(ui.field("status").textContent, /请输入盒子的 IPv4 地址/);

  ui.field("ip").value = "";
  await ui.fire("form", "submit");
  const call = ui.calls.at(-1);
  assert.equal(call.operation, "connect");
  assert.equal(call.lan, true);
  assert.ok(!("ip" in call));
  assert.match(ui.field("state").textContent, /已连接/);
});

test("a box that moved to another network is searched for and connected at its new address", async () => {
  const moved = { ...routerBox, id: hotspotBox.id };
  const ui = loadRenderer(({ operation }) => {
    if (operation === "status") return { last: { ip: hotspotBox.ip, id: hotspotBox.id } };
    if (operation === "connect") return moved;
    assert.fail(`Unexpected operation ${operation}`);
  });
  await settle();
  assert.deepEqual(ui.calls.map(call => call.operation), ["status", "connect"]);
  assert.equal(ui.calls[1].ip, hotspotBox.ip);
  assert.equal(ui.calls[1].expectedId, hotspotBox.id);
  assert.equal(ui.calls[1].lan, true);
  assert.match(ui.field("state").textContent, /已连接/);
  assert.match(ui.field("details").textContent, /192\.168\.1\.23:8080/);
});

test("a stale address with several boxes on the network asks which one to connect to", async () => {
  const ui = loadRenderer(({ operation }) => {
    if (operation === "status") return { last: { ip: hotspotBox.ip, id: hotspotBox.id } };
    if (operation === "connect") return [routerBox, { ...hotspotBox, ip: "192.168.1.40", id: "8D93" }];
    assert.fail(`Unexpected operation ${operation}`);
  });
  await settle();
  assert.equal(ui.field("devices").hidden, false);
  assert.equal(ui.field("ip").value, "");
  assert.match(ui.field("status").textContent, /^无法访问盒子 192\.168\.5\.1。局域网中有 2 个盒子，请选择后连接。$/);
  assert.doesNotMatch(ui.field("state").textContent, /已连接/);
  assert.equal(ui.field("connect").disabled, false);

  ui.field("picker").value = routerBox.ip;
  await ui.fire("picker", "change");
  await ui.fire("form", "submit");
  assert.equal(ui.calls.at(-1).ip, routerBox.ip);
  assert.equal(ui.calls.at(-1).expectedId, routerBox.id);
  assert.equal(ui.calls.at(-1).lan, true);
});

test("the box panel lists nearby hotspots and points at the box hotspot", async () => {
  const ui = loadRenderer(({ operation }) => {
    if (operation === "status") return {};
    if (operation === "scanWifi") return [boxHotspot, routerNetwork];
    assert.fail(`Unexpected operation ${operation}`);
  });
  await settle();
  assert.equal(ui.field("wifi").hidden, true);
  await ui.fire("wifi-scan", "click");
  assert.deepEqual(ui.calls.map(call => call.operation), ["status", "scanWifi"]);
  assert.equal(ui.field("wifi").hidden, false);
  assert.equal(ui.field("wifi-title").textContent, "附近 Wi-Fi 热点（2）");
  const [box, router] = ui.field("wifi-list").children;
  assert.equal(box.className, "box");
  assert.deepEqual(box.children.map(child => child.textContent), [
    "xiaozhi-box-8D91", "盒子热点 · 强 -52 dBm · 开放 · 2.4G 通道 6",
  ]);
  assert.equal(router.className, "");
  assert.deepEqual(router.children.map(child => child.textContent), [
    "Home-5G", "中 -61 dBm · WPA2 · 5G 通道 36",
  ]);
  assert.match(ui.field("status").textContent, /^发现盒子热点 xiaozhi-box-8D91（信号强）。.*扫描设备/);
  assert.equal(ui.field("wifi-scan").disabled, false);
  assert.equal(ui.field("connect").disabled, false);
});

test("hotspot results explain when no box hotspot is in range and refresh on a new scan", async () => {
  let found = [];
  const ui = loadRenderer(({ operation }) => {
    if (operation === "status") return {};
    if (operation === "scanWifi") return found;
    assert.fail(`Unexpected operation ${operation}`);
  });
  await settle();
  await ui.fire("wifi-scan", "click");
  assert.equal(ui.field("wifi").hidden, true);
  assert.match(ui.field("status").textContent, /未发现 Wi-Fi 热点/);

  found = [routerNetwork];
  await ui.fire("wifi-scan", "click");
  assert.equal(ui.field("wifi").hidden, false);
  assert.match(ui.field("status").textContent, /发现 1 个 Wi-Fi 热点，未发现 xiaozhi-box 热点/);
  assert.deepEqual(ui.calls.map(call => call.operation), ["status", "scanWifi", "scanWifi"]);

  found = [boxHotspot, { ...boxHotspot, ssid: "xiaozhi-box-2A00", rssi: -88 }];
  await ui.fire("wifi-scan", "click");
  assert.match(ui.field("status").textContent, /发现 2 个盒子热点/);
});

test("a denied hotspot scan reports the reason and keeps box connection controls available", async () => {
  let scans = 0;
  const ui = loadRenderer(({ operation }) => {
    if (operation === "status") return {};
    if (operation === "scanWifi") {
      if (++scans > 1) throw "读取热点名称需要定位权限。请在系统设置中允许 Keepwork。";
      return [routerNetwork];
    }
    if (operation === "scan") return [];
    assert.fail(`Unexpected operation ${operation}`);
  });
  await settle();
  await ui.fire("wifi-scan", "click");
  assert.equal(ui.field("wifi").hidden, false);
  await ui.fire("wifi-scan", "click");
  assert.equal(ui.field("wifi").hidden, true);
  assert.match(ui.field("status").textContent, /需要定位权限/);
  await ui.fire("scan", "click");
  assert.equal(ui.calls.at(-1).operation, "scan");
  assert.match(ui.field("status").textContent, /手动输入/);
  assert.doesNotMatch(ui.field("state").textContent, /处理中|已连接/);
});

test("a pending hotspot scan can be cancelled and ignores its late reply", async () => {
  let resolveScan;
  const ui = loadRenderer(({ operation }) => {
    if (operation === "status") return {};
    if (operation === "scanWifi") return new Promise(resolve => { resolveScan = resolve; });
    if (operation === "disconnect") return null;
    assert.fail(`Unexpected operation ${operation}`);
  });
  await settle();
  await ui.fire("wifi-scan", "click");
  assert.equal(ui.field("wifi-scan").disabled, true);
  assert.equal(ui.field("cancel").hidden, false);
  await ui.fire("scan", "click");
  assert.equal(ui.calls.length, 2);
  await ui.fire("cancel", "click");
  resolveScan([boxHotspot]);
  await settle();
  assert.deepEqual(ui.calls.map(call => call.operation), ["status", "scanWifi", "disconnect"]);
  assert.match(ui.field("status").textContent, /已取消/);
  assert.equal(ui.field("wifi").hidden, true);
  assert.equal(ui.field("wifi-scan").disabled, false);
});

test("a connected xiaozhi box camera is offered under its device name and can be opened", async () => {
  const box = { ...hotspotBox, name: "xiaozhi-box", camera: true };
  const ui = loadRenderer(({ operation }) => {
    if (operation === "status") return {};
    if (operation === "connect") return box;
    if (operation === "disconnect") return null;
    assert.fail(`Unexpected operation ${operation}`);
  });
  await settle();
  assert.equal(ui.boxCamera().current(), null);
  ui.field("ip").value = box.ip;
  await ui.fire("form", "submit");
  assert.equal(ui.boxCamera().current().label, "xiaozhi-box");

  const seen = [];
  const stop = await ui.boxCamera().open(
    jpeg => seen.push(jpeg),
    reason => seen.push(reason),
  );
  assert.equal(ui.cameraCalls.at(-1).enabled, true);
  const frames = ui.cameraCalls.at(-1).frames;
  frames.onmessage({ jpeg: "frame" });
  frames.onmessage({ ended: "盒子摄像头已断开。" });
  assert.deepEqual(seen, ["frame", "盒子摄像头已断开。"]);
  stop();
  await settle();
  assert.equal(ui.cameraCalls.at(-1).enabled, false);
  frames.onmessage({ jpeg: "late" });
  assert.deepEqual(seen, ["frame", "盒子摄像头已断开。"]);

  await ui.fire("disconnect", "click");
  assert.equal(ui.boxCamera().current(), null);
});

test("a connected box without a camera is not offered in the camera list", async () => {
  const box = { ...hotspotBox, name: "xiaozhi-box", camera: false };
  const ui = loadRenderer(({ operation }) => {
    if (operation === "status") return {};
    if (operation === "connect") return box;
    assert.fail(`Unexpected operation ${operation}`);
  });
  await settle();
  ui.field("ip").value = box.ip;
  await ui.fire("form", "submit");
  assert.match(ui.field("state").textContent, /已连接/);
  assert.equal(ui.boxCamera().current(), null);
});
