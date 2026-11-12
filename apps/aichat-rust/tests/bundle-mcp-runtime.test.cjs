const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const appRoot = path.resolve(__dirname, "..");
const bundler = require(path.join(appRoot, "scripts", "bundle-mcp-runtime.cjs"));
const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8"));
const tauriConf = JSON.parse(
  fs.readFileSync(path.join(appRoot, "src-tauri", "tauri.conf.json"), "utf8")
);
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: appRoot, encoding: "utf8" }).trim();

test("uses the published macOS platform name for staged Node runtimes", () => {
  assert.deepEqual(
    bundler.TARGETS["universal-apple-darwin"].map((runtime) => runtime.platform),
    ["macos", "macos"]
  );
});

function fixture(runtime) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aichat-rust-mcp-"));
  const stage = path.join(dir, "staging", runtime.stage);
  fs.mkdirSync(path.join(stage, "app"), { recursive: true });
  fs.writeFileSync(
    path.join(stage, "runtime.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        product: "keepwork-mcp-node-runtime",
        version: "0.1.45",
        commit: head,
        platform: runtime.platform,
        arch: runtime.arch,
        node: runtime.platform === "windows" ? "node.exe" : "bin/node",
        entry: "app/cli.cjs",
      },
      null,
      2
    )
  );
  const nodeRel = runtime.platform === "windows" ? "node.exe" : "bin/node";
  fs.mkdirSync(path.dirname(path.join(stage, nodeRel)), { recursive: true });
  fs.writeFileSync(path.join(stage, nodeRel), "#!/bin/sh\n");
  fs.writeFileSync(path.join(stage, "app", "cli.cjs"), "// mcp entry\n");
  return { root: path.join(dir, "staging"), out: path.join(dir, "resources"), stage };
}

test("bundles the staged MCP runtime into the Tauri resource layout", () => {
  const { root, out } = fixture(bundler.TARGETS["x86_64-pc-windows-msvc"][0]);
  assert.deepEqual(
    bundler.bundle({ root, out, target: "x86_64-pc-windows-msvc", sourceChanged: () => false }),
    ["x64 0.1.45 (" + head.slice(0, 10) + ")"]
  );
  assert.ok(fs.existsSync(path.join(out, "x64", "runtime.json")));
  assert.ok(fs.existsSync(path.join(out, "x64", "app", "cli.cjs")));
  assert.ok(fs.existsSync(path.join(out, "x64", ".keep")));
  assert.deepEqual(tauriConf.bundle.resources, ["resources/mcp-runtime"]);
});

for (const target of ['aarch64-apple-darwin', 'x86_64-pc-windows-msvc']) test(`legacy Node stage produces a self-contained Rust-readable manifest for ${target}`, t => {
  const runtime = bundler.TARGETS[target][0];
  const { root, out, stage } = fixture(runtime);
  t.after(() => fs.rmSync(path.dirname(root), { recursive: true, force: true }));
  const sourcePath = path.join(stage, 'runtime.json');
  const legacy = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  delete legacy.commit; delete legacy.node; delete legacy.engine;
  fs.writeFileSync(sourcePath, JSON.stringify(legacy));
  fs.writeFileSync(path.join(stage, 'app/package.json'), JSON.stringify({ version: legacy.version, commit: head }));
  const outputPath = path.join(out, runtime.arch, 'runtime.json');
  const verify = () => {
    const output = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.equal(output.commit, head, 'Rust cannot read a commit that only exists in app/package.json');
    assert.equal(output.node, runtime.platform === 'windows' ? 'node.exe' : 'bin/node');
    assert.equal(output.engine, 'node');
    assert.equal(output.schemaVersion, 1);
    assert.ok(fs.statSync(path.join(out, runtime.arch, output.node)).isFile());
    assert.ok(fs.statSync(path.join(out, runtime.arch, output.entry)).isFile());
  };
  bundler.bundle({ root, out, target, require: true, sourceChanged: () => false });
  verify();
  // A previous copy may contain the same version but lack normalized fields.
  fs.writeFileSync(outputPath, JSON.stringify(legacy));
  bundler.bundle({ root, out, target, require: true, sourceChanged: () => false });
  verify();
  assert.equal(JSON.parse(fs.readFileSync(sourcePath, 'utf8')).commit, undefined, 'bundling does not mutate its legacy input');
});

test("a universal build carries both macOS slices and drops foreign ones", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aichat-rust-mcp-"));
  const root = path.join(dir, "staging");
  for (const runtime of bundler.TARGETS["universal-apple-darwin"]) {
    const fixtureRoot = fixture(runtime);
    fs.cpSync(fixtureRoot.root, root, { recursive: true });
  }
  const out = path.join(dir, "resources");
  fs.mkdirSync(path.join(out, "x64"), { recursive: true });
  fs.mkdirSync(path.join(out, "stale-slice"), { recursive: true });
  fs.writeFileSync(path.join(out, "stale-slice", "runtime.json"), "{}");
  bundler.bundle({ root, out, target: "universal-apple-darwin", sourceChanged: () => false });
  assert.ok(fs.existsSync(path.join(out, "arm64", "runtime.json")));
  assert.ok(fs.existsSync(path.join(out, "x64", "runtime.json")));
  assert.equal(fs.existsSync(path.join(out, "stale-slice", "runtime.json")), false);
  assert.ok(fs.existsSync(path.join(out, "stale-slice", ".keep")));
});

test("a missing runtime skips quietly unless the release requires it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aichat-rust-mcp-"));
  const root = path.join(dir, "staging");
  const out = path.join(dir, "resources");
  assert.deepEqual(bundler.bundle({ root, out, target: "x86_64-pc-windows-msvc", sourceChanged: () => false }), []);
  assert.ok(fs.existsSync(path.join(out, "x64", ".keep")));
  assert.throws(
    () => bundler.bundle({ root, out, target: "x86_64-pc-windows-msvc", require: true, sourceChanged: () => false }),
    /No staged Keepwork MCP runtime/
  );
});

test("a stale runtime is refused for a staged release", () => {
  const { root, out } = fixture(bundler.TARGETS["x86_64-pc-windows-msvc"][0]);
  assert.throws(
    () => bundler.bundle({ root, out, target: "x86_64-pc-windows-msvc", sourceChanged: () => true }),
    /is stale/
  );
});

test("a runtime built for another target is rejected", () => {
  const { root, out } = fixture(bundler.TARGETS["aarch64-apple-darwin"][0]);
  assert.throws(
    () => bundler.bundle({ root, out, target: "x86_64-pc-windows-msvc", require: true, sourceChanged: () => false }),
    /No staged Keepwork MCP runtime for windows-x64/
  );
  assert.throws(
    () => bundler.bundle({ root, out, target: "universal-apple-darwin", require: true, sourceChanged: () => false }),
    /No staged Keepwork MCP runtime for macos-x64/
  );
});

test("a hand-made runtime cannot be released", () => {
  const { root, out } = fixture(bundler.TARGETS["x86_64-pc-windows-msvc"][0]);
  const manifestPath = path.join(root, "windows-x64", "runtime.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, entry: "dist/cli.cjs" }));
  fs.mkdirSync(path.join(root, "windows-x64", "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "windows-x64", "dist", "cli.cjs"), "// dev\n");
  assert.throws(
    () => bundler.bundle({ root, out, target: "x86_64-pc-windows-msvc", require: true, sourceChanged: () => false }),
    /is not a staged runtime/
  );
  // Development builds may still use it.
  assert.equal(
    bundler.bundle({ root, out, target: "x86_64-pc-windows-msvc", sourceChanged: () => false }).length,
    1
  );
});

test("AICHAT_MCP_RUNTIME_DIR cannot feed a universal build", () => {
  const { stage, out } = fixture(bundler.TARGETS["aarch64-apple-darwin"][0]);
  const previous = process.env.AICHAT_MCP_RUNTIME_DIR;
  process.env.AICHAT_MCP_RUNTIME_DIR = stage;
  try {
    assert.throws(
      () => bundler.bundle({ out, target: "universal-apple-darwin", sourceChanged: () => false }),
      /AICHAT_MCP_RUNTIME_DIR cannot serve a universal build/
    );
  } finally {
    if (previous === undefined) delete process.env.AICHAT_MCP_RUNTIME_DIR;
    else process.env.AICHAT_MCP_RUNTIME_DIR = previous;
  }
});

test("Node compatibility release scripts explicitly require a runtime for the build target", () => {
  for (const [script, target] of [
    ["make:mcp-node:mac", "universal-apple-darwin"],
    ["make:mcp-node:win:x64", "x86_64-pc-windows-msvc"],
  ]) {
    assert.match(pkg.scripts[script], /bundle-mcp-runtime\.cjs --require/);
    assert.ok(pkg.scripts[script].includes(`--target ${target}`));
  }
  // Node's published slices remain independent of the default Rust installer.
  assert.deepEqual(bundler.TARGETS["aarch64-pc-windows-msvc"], []);
});
