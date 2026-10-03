# Connection and execution

Use the single `paracraft_cli` MCP tool. Its small input is
`{action, clientId?, chatSessionId?, petId?, params?}`. Action names are CLI operations, not additional
MCP tools. Discover only what the task requires:

```json
{"action":"help"}
{"action":"help","params":{"action":"run_code"}}
{"action":"skill","params":{"path":"references/animation.md"}}
{"action":"clients"}
```

`help` lists names; `help` with `params.action` returns one action's schema.
Put `clientId` at the tool's top level; other action arguments go in `params`.
The `skill` action returns only the requested file, without appending every guide.
The root skill is the only advertised MCP resource; subfiles are not resources.

If the user names a Keepwork project and no matching desktop is connected, use
`launch` without a client ID. It reuses an already entered matching desktop or
invokes the installed Windows `paracraft://` handler with CLI debugging enabled.

```json
{"action":"launch","params":{"projectId":530,"waitSeconds":15}}
{"action":"launch_status","params":{"launchId":"<returned launchId>"}}
```

`ready` returns the selected `clientId`; only then fetch capabilities and world
identity. `waiting` returns `launchId` and `retryAfterMs`: poll `launch_status`,
optionally with `waitSeconds` up to 20. Launch registration expires after 60 seconds.
A transport timeout does not mean launch failed: list clients and recover the
pending launch with the same project ID; the hub coalesces pending launches across
chats and transports. Do not close other clients or switch their worlds to satisfy
startup. `protocol_launch_failed` means the installed URL handler needs attention.
Opening a project does not authorize edits or saving that world.

1. Call `clients` to select the intended world. Ask only if several clients are
   open and the user's context does not establish which one to use.
2. Call `get_creation_capabilities` with `clientId`. Retain its exact world
   `identity`, limits and exporter availability. Unsupported capability means
   the engine needs an update, not that terrain is empty.
3. Call `read_official_wiki` with `params:{path:"creation.md"}` for the current
   engine-owned API before authoring. The skill guides design decisions.
4. Call `run_code` with `params:{expectedIdentity:identity,requestId,code}`.
   It returns a job ID. Keep the request ID and source for transport recovery.
5. Poll `code_job` with `params:{expectedIdentity:identity,jobId}`. Inspect output,
   errors, result, progress and created references. Source completion and
   persistent runtime are distinct; cancel owned callbacks with `operation:"cancel"`.

One creation/scouting job is active per chat session, including persistent callbacks.
Other chats can work in the same world concurrently. A busy result is not permission to
interrupt someone else's task. Deadlines default to 120 seconds, up to 600.
After a transport timeout, recover the identical request ID/source and poll the
existing job; never repeat a mutation with a fresh ID just because its response
was lost. After world reopen, rediscover identity and inspect before resuming.

The Keepwork daemon normally listens at `http://127.0.0.1:8089/mcp`. Stdio forwards
through that singleton hub, preserving its registry and authentication. Do not
launch another hub to work around missing clients or log pairing tokens.

Development build: `npm run compile:only --prefix apps/vscode-extension`.
Point a stdio MCP connection at its built `dist/cli.js --stdio`, with the daemon
running. A newly configured connection may need a new Codex session to refresh
its tool catalog. Read this skill locally or with `paracraft_cli` action `skill`.

## Multiple chats and pet viewpoints

Call `context` once and retain its `chatSessionId` on every subsequent request,
including polling, cancellation and captures. Different chats sharing one MCP
connection must use different IDs. Reconnecting the same chat should reuse its ID.
Do not confuse this with `expectedIdentity.sessionId`, which identifies a world
opening. Direct CLI callers use the equivalent `params.authoringSession` field.

Use a stable `petId` (default `main`) to select a pet reference within the chat.
For example, `petId:"detail"` creates/reuses a second reference when scouting;
`get_scene_info` with `anchor:"pet"` and `camera_capture` with `nearPet:true` use
that selected reference. No new MCP tools are needed. Explicit eye/lookat cameras
remain independent of pet movement.

Wait for your active job to settle before submitting the next edit; overlapping
submissions in the same chat return `creation_busy`. A chat cannot accidentally
poll/cancel another chat's jobs or consume its selected-site handle. Different
chats edit shared native data, not isolated copies: the helpers recheck writes
following yields and preserve competing edits during rollback. Scouting reserves
its footprint briefly (120 seconds, renewed while its helper is active); another
chat routes/scouts around it. Failure/cancellation releases that reservation.
Normal CodeBlock authority is unchanged; these ownership checks are workflow
coordination, not a security sandbox for arbitrary Lua.

Only the latest active authoring pet is visible in the client. Other chats retain their
pet positions and jobs while hidden. A screenshot or independent camera capture
shows only the requesting chat's selected pet, then restores the latest active pet
(including activity that arrived during capture). Ordinary scene NPCs are unaffected.
Captures share a visibility lease, including movie pose preparation: overlapping
requests return retryable `capture_busy`; retry the capture after the current one
finishes. Editing remains sequential within each chat and independent across chats.
