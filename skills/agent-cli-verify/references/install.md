# Agent CLI installation

Use these recipes only for the platform the user requested. Read the current
official installer before running it; do not pin a downloaded release URL from
this machine. Check existing discovery and `--version` first. A usable installation
should be reused, not reinstalled. All commands run on the user's local computer
through Keepwork `run_terminal` when available; browser JavaScript cannot install
native software. Keep the existing terminal confirmation flow.

## Cursor

The Cursor desktop editor and Cursor Agent CLI are separate installations.
`cursor --version` only verifies the editor. In the inspected Windows desktop
3.22.12, `cursor agent --help` returns editor help, not proof of an ACP CLI.
Check `agent --version` or `cursor-agent --version`, then the ACP handshake.

Official source: https://cursor.com/docs/cli/installation

Windows: fetch `https://cursor.com/install?win32=true` to a temporary `.ps1`,
inspect it, then run the saved file with **Windows PowerShell 5.1**:

```powershell
$cursorInstaller = Join-Path $env:TEMP 'keepwork-cursor-install.ps1'
Invoke-WebRequest 'https://cursor.com/install?win32=true' -OutFile $cursorInstaller
Get-Content -LiteralPath $cursorInstaller
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $cursorInstaller
```

The inspected official installer uses `Get-WmiObject`, absent in PowerShell 7.
It installs under `%LOCALAPPDATA%\cursor-agent`, creates `agent` aliases and adds
that directory to the user PATH. It deletes an existing CLI directory first:
resolve the absolute target and verify it is that exact directory before any
reinstall; prefer reusing a working CLI. Do not touch the desktop installation.
On the verified Windows installation, run
`& "$env:LOCALAPPDATA\cursor-agent\agent.cmd" --version` if the current
terminal/extension still has the old PATH. The installer supplied `.cmd` / `.ps1`
wrappers, not a top-level EXE. Keepwork resolves their dated `versions/<version>/`
package and starts its bundled `node.exe index.js acp` directly, without a shell.
Prefer the bundled Node runtime to avoid native module ABI mismatches.

macOS: download `https://cursor.com/install` to a temporary shell file, inspect
it, then run with `bash`. Official shorthand: `curl https://cursor.com/install -fsS | bash`.
Expected command location: `~/.local/bin/agent`; check that path
before changing shell startup files. This recipe is documented, not a native
macOS acceptance result.

Verify version, discover the actual executable, then initialize `agent acp` via
Keepwork. If authentication is needed, launch `agent login` in a user-visible
terminal and let the user complete browser login; never copy desktop tokens.
Check models before running any inference. Report installation, protocol/model
discovery and authenticated generation separately. Repeat model discovery for a
new conversation and verify the same child PID is reused.

## WorkBuddy / CodeBuddy

Official source: https://www.codebuddy.cn/docs/cli/installation

First inspect Keepwork discovery: some desktop WorkBuddy bundles already expose
the CodeBuddy ACP engine. If missing or lacking login modules, install the official
standalone CLI on Windows/macOS with `npm install -g @tencent-ai/codebuddy-code`.
Verify `codebuddy --version`, then `codebuddy --acp`. User login is `codebuddy
/login`. Node/npm are prerequisites; install them only when needed for the user's
requested provider. Windows standalone installation and WorkBuddy model discovery
were verified on this machine; desktop login alone does not establish CLI login.

## Copilot CLI

Official source: https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli

With compatible Node/npm installed, use `npm install -g @github/copilot` on
Windows/macOS. Verify `copilot --version`, let the user complete `copilot login`,
then Keepwork starts `copilot --acp --stdio --no-auto-update`. The VS Code Copilot
extension is a separate editor integration. Models and thinking options must be
those returned by the CLI/account; do not invent a static list.

## Other supported platforms

Read the selected backend's `installUrl` and native launch contract from
`GET /agents/backends?backend=<id>` before installation. Follow the current
official instructions for Codex, Claude, Trae, Qwen, Gemini, Kimi and OpenCode;
do not claim recipes were verified merely because their protocol fixtures pass.
Keepwork searches common Windows/macOS locations even with a stale GUI PATH.
An earlier missing-CLI result is retryable after installation. Explicit invalid
`KEEPWORK_<BACKEND>_PATH` overrides must be corrected rather than silently ignored.
