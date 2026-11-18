const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const script = path.resolve(__dirname, "../../../scripts/vscode-pnpm-task.zsh");
const zsh = ["/bin/zsh", "/usr/bin/zsh"].find((candidate) => fs.existsSync(candidate));

function launcherTest(name, fn) {
  test(name, { skip: zsh ? false : "zsh is not installed on this host" }, fn);
}

function writeExe(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
}

function assertTaskCwd(stdout, cwd) {
  const reported = stdout.match(/^CWD=(.*)$/m)?.[1];
  assert.ok(reported, stdout);
  // macOS tmpdir is /var/folders, and /var is a symlink to /private/var.
  assert.equal(fs.realpathSync(reported), fs.realpathSync(cwd));
  assert.notEqual(fs.realpathSync(reported), fs.realpathSync("/"));
}

function runTask(home, cwd, pathPrefix, zshrc) {
  const zdot = path.join(home, "zdot");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(zdot, { recursive: true });
  fs.writeFileSync(path.join(zdot, ".zshrc"), zshrc);
  return spawnSync(zsh, [script, "tauri", "dev"], {
    cwd,
    env: {
      HOME: home,
      ZDOTDIR: zdot,
      PATH: pathPrefix ? `${pathPrefix}:/usr/bin:/bin` : "/usr/bin:/bin",
      TERM: "dumb",
      LANG: "C",
      DEBIAN_PREVENT_KEYBOARD_CHANGES: "1",
    },
    encoding: "utf8",
    timeout: 20000,
  });
}

launcherTest("macOS task launcher keeps pnpm already visible to the login shell", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-task-"));
  try {
    const cwd = path.join(home, "work dir");
    const bin = path.join(home, "bin");
    writeExe(path.join(bin, "pnpm"), "#!/bin/sh\nprintf 'CWD=%s\\nARGS=%s\\nWHICH=path\\n' \"$(pwd)\" \"$*\"\n");
    writeExe(path.join(home, "Library/pnpm/pnpm"), "#!/bin/sh\nprintf 'WHICH=library\\n'\n");
    const result = runTask(home, cwd, bin, "echo SOURCED\nexit 9\n");
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /WHICH=path/);
    assert.match(result.stdout, /ARGS=tauri dev/);
    assertTaskCwd(result.stdout, cwd);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /SOURCED/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

launcherTest("macOS task launcher finds the official ~/Library/pnpm install", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-task-"));
  try {
    const cwd = path.join(home, "work");
    writeExe(
      path.join(home, "Library/pnpm/pnpm"),
      "#!/bin/sh\nprintf 'CWD=%s\\nARGS=%s\\nWHICH=library\\n' \"$(pwd)\" \"$*\"\n"
    );
    const result = runTask(home, cwd, "", "echo SOURCED\nexit 9\n");
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /WHICH=library/);
    assert.match(result.stdout, /ARGS=tauri dev/);
    assertTaskCwd(result.stdout, cwd);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /SOURCED/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

launcherTest("macOS task launcher prefers the official install over a leftover nvm pnpm", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-task-"));
  try {
    const cwd = path.join(home, "work");
    writeExe(path.join(home, "Library/pnpm/pnpm"), "#!/bin/sh\nprintf 'WHICH=library\\n'\n");
    writeExe(path.join(home, ".nvm/versions/node/v22.11.0/bin/pnpm"), "#!/bin/sh\nprintf 'WHICH=nvm\\n'\n");
    const result = runTask(home, cwd, "", "# no interactive pnpm\n");
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /WHICH=library/);
    assert.doesNotMatch(result.stdout, /WHICH=nvm/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

launcherTest("macOS task launcher prefers the newest nvm pnpm when login PATH has none", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-task-"));
  try {
    const cwd = path.join(home, "work");
    writeExe(path.join(home, ".nvm/versions/node/v18.0.0/bin/pnpm"), "#!/bin/sh\nprintf 'WHICH=v18\\n'\n");
    writeExe(path.join(home, ".nvm/versions/node/v22.2.0/bin/pnpm"), "#!/bin/sh\nprintf 'WHICH=v22.2\\n'\n");
    writeExe(path.join(home, ".nvm/versions/node/v22.11.0/bin/pnpm"), "#!/bin/sh\nprintf 'WHICH=v22.11\\n'\n");
    const result = runTask(home, cwd, "", "# no interactive pnpm\n");
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /WHICH=v22\.11/);
    assert.doesNotMatch(result.stdout, /WHICH=v18|WHICH=v22\.2/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

launcherTest("macOS task launcher exposes the selected nvm Node to pnpm's env shebang", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-task-"));
  try {
    const cwd = path.join(home, "work dir");
    const bin = path.join(home, ".nvm/versions/node/v22.11.0/bin");
    writeExe(path.join(bin, "pnpm"), "#!/usr/bin/env node\n// pnpm fixture\n");
    writeExe(path.join(bin, "node"), "#!/bin/sh\nprintf 'CWD=%s\\nARGS=%s\\nWHICH=nvm-node\\n' \"$(pwd)\" \"$*\"\n");
    const result = runTask(home, cwd, "", "# no interactive pnpm\n");
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /WHICH=nvm-node/);
    assert.ok(result.stdout.includes(`ARGS=${bin}/pnpm tauri dev`), result.stdout);
    assertTaskCwd(result.stdout, cwd);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

launcherTest("macOS task launcher reads interactive zsh PATH and stays in the task directory", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-task-"));
  try {
    const cwd = path.join(home, "work");
    const fake = path.join(home, "custom/bin");
    writeExe(path.join(fake, "pnpm"), "#!/bin/sh\nprintf 'CWD=%s\\nARGS=%s\\nWHICH=zshrc\\n' \"$(pwd)\" \"$*\"\n");
    const result = runTask(home, cwd, "", `export PATH="${fake}:$PATH"\ncd /\n`);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /WHICH=zshrc/);
    assert.match(result.stdout, /ARGS=tauri dev/);
    assertTaskCwd(result.stdout, cwd);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

launcherTest("macOS task launcher reports a missing pnpm instead of a shell command-not-found", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-task-"));
  try {
    const cwd = path.join(home, "work");
    const result = runTask(home, cwd, "", "# pnpm is not installed\n");
    assert.equal(result.status, 127, result.stdout);
    assert.match(result.stderr, /pnpm was not found/);
    assert.match(result.stderr, /zsh -l/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
