---
name: paracraft
description: Use for Paracraft / 帕拉卡 download, installation, local installation checks, opening a world or Keepwork project pid, connecting desktop or web clients, inspecting scenes, building, NPL programming, screenshots, and saving worlds.
Tools: paracraft
---

# Paracraft / 帕拉卡

Use the shared `paracraft` tool page, `tools/Paracraft/ParacraftTool.html`
(relative to AIChat.html). The `Tools` declaration resolves that existing catalog
entry; do not create a duplicate tool page.

## Discover and load

For Paracraft-related operations, first discover this local skill with
`runWorkspaceCmd({"cmd":"searchSkill","keywords":"Paracraft 帕拉卡"})`,
then load the returned id with
`runWorkspaceCmd({"cmd":"loadSkill","skillId":"local-paracraft"})`.
If this skill is already loaded in the current context, continue without reloading.

## Web or desktop client

Paracraft has both a **web version (网页版)** and a **desktop client (客户端)**.
Both are accessed through the same Paracraft tool page and accept the same `pid`.

- Web: runs in the browser; no desktop installation or `paracraft://` URL
	protocol registration is required.
- Desktop: requires installing Paracraft locally. Launching it from the browser
	also requires the OS to have a working `paracraft://` URL protocol handler
	registered by the supported installation/setup flow. An executable on disk
	alone does not prove browser launch is configured.

Honor an explicit desktop choice; otherwise default to **Web**. “打开客户端”,
“打开 Paracraft”, and “start Paracraft” mean Web even if desktop was used before.
If desktop installation or protocol registration is missing, offer official
installation/setup or the web version. Repair protocol registration through the
official setup flow with user authorization; do not invent registry commands.
A browser permission prompt or blocked protocol launch is not proof that the
client is absent. Verify both installation and protocol registration separately.

## Creation requests

Open the catalog tool and obtain the selected client's authoring instructions from Keepwork MCP through `paracraft_read_creation_skill`. External CLI sessions discover that conversation-bound action via `aichat_list_tools`.

## Download and install

The official download page is https://paracraft.cn/download. Give the user this
link for manual download and installation, or open it when requested:

```json
{"cmd":"openIntegratedBrowser","filePath":"https://paracraft.cn/download"}
```

Pass this to `runWorkspaceCmd`. Opening the official download website is allowed;
it is not a substitute for opening a world in the Paracraft agent tool.

When asked to help install, first check the user's OS and existing installation.
Fetch the official page with an available webpage-fetch tool to resolve the
current installer link. Select Paracraft 3D编程 unless the user requests another
edition; the page also lists 智慧教育 and 帕帕奇遇记. Do not hard-code dated
installer URLs, infer unavailable OS packages, or use unofficial mirrors.
If fetching does not expose the correct download link, open the page for manual
selection rather than guessing it.

With the user's installation authorization and available local tools, download
the selected official installer, verify the download and available publisher
signature, then run its normal supported installation flow. Use the existing
Keepwork `run_terminal` confirmation for each local command. Do not invent silent
install switches, bypass OS security, uninstall an existing edition, or overwrite
user worlds. If elevation, passwords, an app-store login, or an installer dialog
requires human input, ask the user to complete that step directly. Without local
tools, explain the manual steps; browser tools alone cannot install desktop apps.

After installation, repeat the local checks below, then open the Paracraft tool
and verify the intended client/world. An installer download or successful launch
request is not proof of completed installation or a loaded world.

## Check local availability

Distinguish **installed**, **running**, **connected**, and **world loaded**:

1. Open `paracraft` with `openUserTool` and read `getToolContext`. The tool's
	client monitor discovers running desktop clients through Keepwork MCP on
	`localhost:8089`; a web client does not prove desktop installation.
2. No desktop clients, an unavailable MCP service, or a failed connection means
	discovery is unavailable or no client is connected, not "not installed".
3. If local tools are enabled, use bounded read-only OS checks. On Windows,
	inspect the `paracraft` URL protocol registration under
	`HKCU\Software\Classes\paracraft` and `HKLM\Software\Classes\paracraft`,
	plus Paracraft entries in the per-user, machine, and WOW6432Node uninstall
	registry locations. Check that the referenced executable actually exists;
	stale registry entries alone are not proof. Inspect a user-provided install
	folder if needed, without recursively scanning the entire disk.
	On macOS, check `/Applications` and `~/Applications` for the Paracraft app
	and verify its bundle executable. Report paths/evidence and uncertainty.
4. Without filesystem/terminal access, say local installation cannot be verified
	automatically. Ask the user to check installed apps or open Paracraft; offer
	the official download page only as needed. Do not reinstall just because
	a client is not running.

For desktop launch, use the Paracraft tool's client picker and its registered
`paracraft://` flow, accepting any browser/OS confirmation. Keepwork MCP is a
separate connection helper, not Paracraft itself. Once a desktop client appears,
verify its identity and world status before operating on it.

## Open from main chat

Use the existing generic `runWorkspaceCmd` → `openUserTool` mechanism, whether
or not the Paracraft tool window is already open. For “打开客户端”, “打开
Paracraft”, or “start Paracraft”, call:

```json
{"cmd":"openUserTool","args":{"tool":"paracraft"}}
```

Without a PID, opening the tool leaves its client monitor idle. With a PID,
it reuses an already-open matching Web or desktop client first. Otherwise it
honors the remembered launch preference: Web opens the world, while desktop
shows a restore chooser with desktop, Web and cancel options. Cancellation
starts no client. An explicit `open_client` request can still open Web home;
`home-requested` is not proof that the engine has finished rendering.
Do not ask the user to click a tool tab or install a desktop client for Web.
There are no host-level Paracraft startup functions before the tool loads.

For "open paracraft pid 530 world", call:

```json
{"cmd":"openUserTool","args":{"tool":"paracraft","pid":"530"}}
```

Pass these arguments to `runWorkspaceCmd`. Preserve the requested PID; 项目编号、
项目ID、世界ID、project ID and world ID mean the same identifier. `projectId`
is also accepted by `openUserTool`. Opening a PID mounts/reuses its own tool tab.
The page starts that world in Web. Opening a tool tab is not evidence that the
world has finished loading; use `getToolContext` to check its connection state.

After the page is ready, its existing `paracraft_open_client`,
`paracraft_open_world`, and `paracraft_world_status` functions become available
in subsequent main-chat turns, including while the tool is inactive. Use those
for further client/world operations. Only use `mode:"desktop"` on an explicit
desktop request; the page's desktop button is also available. If the current
turn does not yet expose these functions, report readiness accurately instead
of inventing a function or using terminal commands. Do not route a startup
prompt back into the same main conversation with `promptUserTool`.

Do not use `openIntegratedBrowser` or invent a `web.paracraft.cn/world/<pid>` URL
as a substitute for Paracraft operations. A generic browser preview does not
establish a Paracraft tool connection.

## Inspect and operate

The Paracraft tool supports multiple clients at once. The active client is only
one of them. Before deciding whether a requested world is open, inspect all
available desktop and web clients and match their reported project IDs to the
requested `pid`. An active-client mismatch does not mean the world is unopened.
Reuse/select a matching client through available controls before further actions;
do not open a duplicate or replace another client's world. Report client identity
and loading state. If the available context only covers the active client, state
that other clients remain unchecked instead of claiming the world is not open.
Do not infer a match from the tool tab's pid or input field alone.

After opening the tool, use `getToolContext` for the returned tool id (for example
`paracraft:530`) to inspect its available actions and current connection:

```json
{"cmd":"getToolContext","args":{"tool":"paracraft:530"}}
```

Only request actions the user authorized. The tool page owns client selection,
engine commands, and its detailed world-controller instructions. Use its exposed
capabilities rather than inventing host commands or emitting executable slash
commands in the general chat. Never create, modify, save, or publish a world
implicitly when the user only asked to open or inspect it.

Opening the tool tab or submitting a prompt is not proof that the world has
loaded or an operation succeeded. Report only what the returned context/results
verify; say when client selection, loading, or execution is still pending.

## Find a world by name

After the tool is loaded (at home or inside a world), use `paracraft_list_worlds`
with optional `query` to read the signed-in user's own world names and PIDs.
`paracraft_open_world({name:"森林"})` resolves a partial name from that list;
`projectId` / `pid` or a numeric `name` opens by ID directly. Name matching ignores
case, spacing and punctuation. A unique match opens; `needs-selection` returns
candidates and must be followed by the user's choice of PID. `not-found` means
ask for another name or ID, never invent one. Follow `nextOffset` to read more
summaries; `sourceIncomplete` warns that the server list is incomplete. Login or
network errors are not an empty world list. Do not create a world just because
no name matched. After switching, verify world_status before editing.
