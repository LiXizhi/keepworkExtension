const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const appRoot = path.resolve(__dirname, "..");
const read = relative => fs.readFileSync(path.join(appRoot, relative), "utf8");

function asrProduction(source) {
  const boundary = /^#\[cfg\(test\)\]\r?\nmod tests\b/m.exec(source);
  assert.ok(boundary, "the ASR test module boundary must be present");
  return source.slice(0, boundary.index);
}

function assertCloudAsrContract(source) {
  const production = asrProduction(source);
  assert.ok(production.includes("wss://speechrtc.keepwork.com/speech?asr_format=pcm&asr_rate=16000"));
  assert.match(production, /async fn transcribe\(\s*&self,\s*audio: [\w:]*Receiver<Vec<i16>>,\s*cancel: watch::Receiver<bool>,\s*preview: impl FnMut\(&str\)/);
  assert.ok(production.includes("sample.to_le_bytes()"));
  assert.ok(production.includes('"asr_end"'));
  assert.doesNotMatch(production, /std::fs|tokio::fs|File::create|access_token|Authorization|asr_start/);
}

test("remote pages retain their existing ACL while only local settings can start and stop voice input", () => {
  const main = JSON.parse(read("src-tauri/capabilities/default.json"));
  const settings = JSON.parse(read("src-tauri/capabilities/remote-voice.json"));
  assert.deepEqual(main.windows, ["main", "pet", "updates"]);
  assert.equal(main.permissions.includes("allow-remote-voice-settings"), false);
  assert.deepEqual(settings.windows, ["remote-voice"]);
  assert.equal(settings.local, true);
  assert.equal(Object.hasOwn(settings, "remote"), false);
  assert.deepEqual(settings.permissions, ["allow-remote-voice-settings"]);

  const permissions = read("src-tauri/permissions/desktop-commands.toml").split("[[permission]]");
  const legacy = permissions.find(part => part.includes('identifier = "allow-desktop-commands"'));
  const isolated = permissions.find(part => part.includes('identifier = "allow-remote-voice-settings"'));
  const expected = ["remote_voice_status", "remote_voice_start", "remote_voice_stop"];
  assert.ok(legacy && isolated);
  const host = read("src-tauri/src/app/remote_voice_host.rs");
  const startup = read("src-tauri/src/app/startup.rs");
  const bridge = read("src/bridge.ts") + read("src-tauri/src/bridge.rs");
  for (const command of expected) {
    assert.ok(isolated.includes(`"${command}"`), `${command} must be in the local-only permission`);
    assert.equal(legacy.includes(`"${command}"`), false);
    assert.equal(bridge.includes(command), false, `${command} cannot be exposed in the remote-page bridge`);
    assert.ok(startup.includes(`remote_voice_host::${command}`));
    const body = host.slice(host.indexOf(`fn ${command}(`)).split("#[tauri::command]")[0];
    assert.match(body, /verify\(&window\)\?/, `${command} must verify the local settings sender`);
  }
  assert.doesNotMatch(isolated, /remote_voice_(prepare|pick)/, "voice input no longer installs Python or selects model files");
});

test("native voice packaging needs no Python, Node sidecar, model weights or sibling application", () => {
  const native = read("src-tauri/src/remote_voice.rs");
  const directory = path.join(appRoot, "src-tauri/src/remote_voice");
  const sources = [native, ...fs.readdirSync(directory)
    .filter(name => /\.(rs|m)$/.test(name))
    .map(name => fs.readFileSync(path.join(directory, name), "utf8"))].join("\n");
  assert.doesNotMatch(sources, /std::process::Command|Command::new|include_str!\([^\n]*\.py/);
  assert.doesNotMatch(sources, /faster.whisper|model-files\.json|requirements\.txt|apps\/aichat-desktop|mi-remote-voice\/scripts/);
  for (const oldFile of ["worker.py", "native_input.py", "atvv.py", "requirements.txt", "model-files.json"]) {
    assert.equal(fs.existsSync(path.join(appRoot, "voice", oldFile)), false, `${oldFile} is no longer a runtime dependency`);
  }
  assert.match(read("src-tauri/src/remote_voice/ble.rs"), /SpeechConnection\b/);
  const manifest = read("src-tauri/Cargo.toml");
  assert.match(manifest, /btleplug\s*=/);
  assert.match(manifest, /tokio-tungstenite\s*=/);
  assert.ok(read("vite.config.ts").includes('"remote-voice.html"'));
  assert.ok(read("src-tauri/Info.plist").includes("NSBluetoothAlwaysUsageDescription"));
});

test("cloud ASR uses the fixed Keepwork speech endpoint and a bounded cancellable PCM contract", () => {
  assertCloudAsrContract(read("src-tauri/src/remote_voice/asr.rs"));
  const host = read("src-tauri/src/app/remote_voice_host.rs");
  assert.doesNotMatch(host, /endpoint|proxy_url|api_key|access_token/, "the renderer cannot select a speech server or credential");
});

test("ASR production guards accept LF and CRLF while rejecting production violations", () => {
  const canonical = read("src-tauri/src/remote_voice/asr.rs").replace(/\r\n/g, "\n");
  const expected = asrProduction(canonical);
  for (const ending of ["\n", "\r\n"]) {
    const source = canonical.replace(/\n/g, ending);
    assertCloudAsrContract(source);
    const production = asrProduction(source);
    assert.equal(production.replace(/\r\n/g, "\n"), expected);
    for (const forbidden of ["std::fs", "tokio::fs", "File::create", "access_token", "Authorization", "asr_start"]) {
      const injected = production + `// forbidden production use: ${forbidden}${ending}` + source.slice(production.length);
      assert.throws(() => assertCloudAsrContract(injected), { code: "ERR_ASSERTION" }, forbidden);
    }
    for (const required of [
      "wss://speechrtc.keepwork.com/speech?asr_format=pcm&asr_rate=16000",
      "sample.to_le_bytes()",
      '"asr_end"',
    ]) {
      const changed = production.replaceAll(required, "REMOVED_CONTRACT") + source.slice(production.length);
      assert.throws(() => assertCloudAsrContract(changed), { code: "ERR_ASSERTION" }, required);
    }
  }
  assert.throws(() => asrProduction(expected), /ASR test module boundary must be present/);
});

test("ASR guards inspect production after an actual autocrlf Git checkout", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kp-asr-checkout-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "asr.rs");
  fs.writeFileSync(file, read("src-tauri/src/remote_voice/asr.rs").replace(/\r\n/g, "\n"));
  const git = args => execFileSync("git", ["-c", "core.autocrlf=true", "-c", "core.safecrlf=false", ...args],
    { cwd: directory, stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "--quiet"]);
  git(["add", "--", "asr.rs"]);
  fs.rmSync(file);
  git(["checkout-index", "--all", "--force"]);
  const checkedOut = fs.readFileSync(file, "utf8");
  assert.ok(checkedOut.includes("\r\n"), "the real checkout must exercise Windows CRLF bytes");
  assert.equal(checkedOut.replace(/\r\n/g, "").includes("\n"), false);
  assertCloudAsrContract(checkedOut);
  const production = asrProduction(checkedOut);
  const injected = production + "// forbidden production use: File::create\r\n" + checkedOut.slice(production.length);
  assert.throws(() => assertCloudAsrContract(injected), { code: "ERR_ASSERTION" });
});

test("voice settings explain cloud processing and expose only native device controls", () => {
  const html = read("remote-voice.html");
  assert.match(html, /云端/);
  assert.doesNotMatch(html, /id="(?:python|model|prepare|pick-python|pick-model)"/);
  assert.doesNotMatch(html, /faster.whisper|安装.*依赖|下载.*模型/);
  assert.match(html, /frame-src 'none'/);
  assert.match(html, /不会自动.*回车|不.*自动.*发送/);
});

test("remote-voice and updates windows follow desktop theme instead of OS dark mode", () => {
  const voiceHost = read("src-tauri/src/app/remote_voice_host.rs");
  const updatesHost = read("src-tauri/src/app/updates_window.rs");
  const commands = read("src-tauri/src/app/commands.rs");
  const voiceCss = read("src/remote-voice.css");
  const updatesCss = read("src/updates.css");

  for (const host of [voiceHost, updatesHost]) {
    assert.match(host, /\.theme\(Some\(theme\.native\(\)\)\)/);
    assert.match(host, /\.background_color\(theme\.background\(\)\)/);
    assert.match(host, /\.initialization_script\(&theme\.document_theme_script\(\)\)/);
  }
  assert.match(commands, /sync_secondary_windows_theme\(window\.app_handle\(\), theme\)/);
  assert.match(voiceCss, /:root\[data-theme="light"\]\s*\{\s*color-scheme:\s*light;\s*\}/);
  assert.match(voiceCss, /:root\[data-theme="dark"\]\s*\{[^}]*color-scheme:\s*dark;/);
  assert.match(voiceCss, /:root:not\(\[data-theme="light"\]\)/);
  assert.match(updatesCss, /:root\[data-theme="light"\]\s*\{\s*color-scheme:\s*light;\s*\}/);
  assert.match(updatesCss, /:root\[data-theme="dark"\]\s*\{\s*color-scheme:\s*dark;\s*\}/);
});
