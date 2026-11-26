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
  const pendingPolls = new Map();
  let pollId = 0;
  const window = Object.assign(new Control(), {
    setInterval(callback) { pendingPolls.set(++pollId, callback); return pollId; },
    clearInterval(id) { pendingPolls.delete(id); },
  });
  const document = Object.assign(new Control(), {
    getElementById: id => fields.get(id), createElement: () => new Control(),
  });
  vm.runInNewContext(script, {
    exports: {}, document, window,
    require(name) {
      assert.equal(name, "@tauri-apps/api/core");
      return { async invoke(command, { request }) {
        assert.equal(command, "bumi_box_link");
        const call = JSON.parse(JSON.stringify(request));
        calls.push(call);
        return await respond(call);
      } };
    },
  });
  const field = id => fields.get("box-link-" + id);
  return {
    calls, field,
    async fire(id, event) { field(id).fire(event); await settle(); },
    async poll() { for (const callback of pendingPolls.values()) callback(); await settle(); },
  };
}

const hotspotBox = { ip: "192.168.5.1", port: 8080, id: "8D91", name: "Bumi 8D91", firmware: "1.0.0" };
const routerBox = { ip: "192.168.1.23", port: 8080, id: "8D92", name: "Bumi 8D92" };

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
