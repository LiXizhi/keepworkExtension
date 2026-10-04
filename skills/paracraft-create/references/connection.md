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

For a local test/art world, discover `manage_world` and read the engine-owned
`world-management.md`. Names may contain spaces; native `open_world` paths take
no shell quotes. Wait for actual entered status, then refresh creation identity.
`open_requested` only acknowledges the request, and saving remains explicit.

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

Keep one chat/pet context through sequential revisions rather than creating a new
pet for every script. Use unique request IDs for new edits; chat identity stays
stable. Poll at a modest interval (about 0.5–1 second for local creation jobs),
request compact progress/results, and read only the guide needed for the next
step. This saves calls and repeated scouting travel without skipping validation.
`code_job` defaults to `resultDetail:"summary"`: actor names, sizes, files and
timeline overview stay visible, while dense rotation-key arrays become counts
and time ranges in `resultDetails.omitted`. To audit every generated key, query
the same job with `resultDetail:"full"`; do not run its source/template again.
This display option is handled by Keepwork and requires no new engine action.

The Keepwork daemon normally listens at `http://127.0.0.1:8089/mcp`. Stdio forwards
through that singleton hub, preserving its registry and authentication. Do not
launch another hub to work around missing clients or log pairing tokens.

Development build: `npm run compile:only --prefix apps/vscode-extension`.
Point a stdio MCP connection at its built `dist/cli.js --stdio`, with the daemon
running. A newly configured connection may need a new Codex session to refresh
its tool catalog. Read this skill locally or with `paracraft_cli` action `skill`.

## Run a packaged design without copying source

Load the relevant guide to choose a design: moving objects, animals or vegetation.
`template_info` returns only that template's description, dimensions, asset count
and `templateHash`; it does not return Lua or enumerate other templates.
It also lists named palette roles with uniform `#RRGGBB` defaults. Pass a partial
`palette` to `run_template` to override only those roles; unknown roles and invalid
colors fail before dispatch. A different palette builds a new variant with a new
request ID; inspect its color contrast. To revise an existing placed component,
resume its named scene/groups with `run_code` rather than duplicating the design.
Keep the same request/args
when recovering a transport timeout.
Use `help` with `params.action:"run_template"` for the current schema.

```json
{"action":"template_info","params":{"template":"bird"}}
{"action":"run_template","clientId":"<client>","chatSessionId":"<chat>","params":{"template":"bird","templateHash":"<returned hash>","expectedIdentity":{"clientId":"<client>","worldPath":"<world>","sessionId":2},"requestId":"bird-1"}}
```

This Keepwork action loads the packaged source and submits native `run_code`;
poll `code_job` with the returned job ID. It creates a deterministic unique scene
and exports world-local assets, without requiring coordinates. An optional
integral `origin` overrides scouting. It retains normal CodeBlock authority.
Source/manifest saving requires `saveSource:true`; world saving stays explicit.
Retain the returned template hash and job ID. If the package changes, a pinned
hash fails as `template_changed` before dispatch: recover an existing job instead
of resubmitting changed source or choosing a new request ID after a timeout.
Record `requestId`, chat ID and exact world identity before submitting. If the
first response is lost and no job ID arrived, engines advertising
`requestJobLookup:true` accept `code_job` with the original `requestId` instead
of `jobId`. Supply exactly one selector. This is a read of the original job,
even if the packaged template has since changed; it does not compile or run it
again. The response supplies its job ID and original request ID. `unknown_job`
requires checking client/world/chat identity and transport state, not submitting
new mutations blindly. Older engines return an explicit unsupported-capability
error for this lookup; use a known job ID there. Status/full/cancel use the same
selector and existing action, without adding a tool.
Native CLI does not implement this package action; it still receives `run_code`.
If `help` does not recognize `run_template`, that Keepwork connection is older;
reconnect to the updated runtime or use the linked Lua through `run_code`.

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

Stdio forwards to the same local HTTP hub. A discovery record whose process has
exited is ignored in favor of the configured port before sending the request.
Connection failure never automatically resends a mutation; recover its existing
job or original request ID before deciding whether any new execution is needed.

`template_info` lists `requiredCapabilities` when an example needs a newer helper.
`run_template` checks those flags and world identity before sending code; an older
engine receives `unsupported_capability` with no partial construction. Templates
with a native sequential fallback need no extra capability read. Existing job
recovery remains independent of the current template requirements.
