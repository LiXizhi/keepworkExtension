# Paracraft art creation with MCP

The shared Keepwork MCP server exposes creation capabilities, scouting, source
execution, job status/cancellation, official engine documentation, scene reads,
fresh screenshots and independent camera captures. Use only `paracraft_cli({action,clientId?,params?})`; discover worlds with
`{action:"clients"}`. `{action:"help"}` lists actions and
`{action:"help",params:{action:"run_code"}}` loads one action schema.

## Skill distribution

Canonical skill: [`skills/paracraft-create/SKILL.md`](../skills/paracraft-create/SKILL.md).
It has focused reference guides and executable Lua examples. It adapts the staged
design/visual-review approach of [img2threejs](https://github.com/img2threejs/img2threejs)
to Paracraft's native voxels, bindings and editable timelines. It does not depend
on Three.js or that repository's runtime.

Both application builds include the same files under `dist/skills/paracraft-create`.
MCP clients can use:

- Tool: `paracraft_cli({action:"skill"})`, then
  `{action:"skill",params:{path:"references/animation.md"}}` for a selected guide.
- One resource: `keepwork://skills/paracraft-create/SKILL.md`.

Subfiles, examples and action schemas are fetched only when needed. No individual
Paracraft operation tools, subfile resources or separate prompts are registered.

For local Codex discovery, copy the entire `paracraft-create` directory into your
Codex skills directory, or link it to the canonical checkout. Do not copy only the
root file. A Windows development junction can be created with PowerShell:

```powershell
New-Item -ItemType Junction -Path "$HOME/.codex/skills/paracraft-create" -Target 'C:/path/to/keepworkExtension/skills/paracraft-create'
```

## Codex MCP connection

Build with `npm run compile:only --prefix apps/vscode-extension`. Keep the singleton
Keepwork HTTP daemon running (the extension normally starts it). Register stdio:

```powershell
codex mcp add keepwork -- node C:/path/to/keepworkExtension/apps/vscode-extension/dist/cli.js --stdio
codex mcp get keepwork
```

Stdio reads the existing hub port and pairing token locally; it does not start
another registry. Alternatively connect directly to the daemon's `/mcp` endpoint
using the configured authentication. Do not paste tokens into tracked files.
See [official Codex MCP configuration](https://developers.openai.com/codex/mcp).
New configuration may require a new Codex session before tool discovery refreshes.

Try: “Use $paracraft-create to build a small pavilion without coordinates, inspect
it from two viewpoints, then create an editable character with idle and wave clips.”

## Validation

`node --test scripts/paracraft-guide.test.cjs` checks file links and the compact MCP discovery surface and on-demand guide/schema reads. Existing creation transport tests cover HTTP and stdio.

For a real running daemon and disposable world, invoke:

```powershell
node scripts/paracraft-live-acceptance.cjs 'C:/exact/disposable/world/' 'C:/temporary/captures' --build
```

It uses real Streamable HTTP and stdio clients, discovers the exact world, fetches
the bundled examples over MCP, creates uniquely named samples with automatic
siting, captures pavilion/idle/wave images, and checks player/main-camera invariance.
It explicitly exports assets and saves source/manifests from the examples, but
does not save/reopen the world. Omit `--build` for a read/capture smoke test. Images
are written to the requested directory; image bytes and pairing tokens are never
printed. A script pass is transport/runtime evidence; inspect the images separately
for visual quality.

## Local acceptance record (2026-10-03)

Installed Keepwork 0.1.25 and connected Codex's `keepwork` stdio configuration.
That initial build advertised separate tools and resources. The current revision
consolidates them into one `paracraft_cli` tool and one root skill resource; all
14 bundled files remain available on demand.
The live HTTP/stdio test in `CreationAcceptance_20261003` built uniquely named
pavilion and character examples with automatic pet siting, returned native images
and preserved player/main-camera state. Visual inspection confirmed the pavilion
and the two-bone fixture's rest/raised-arm poses. These are technical examples,
not a claim of finished character art. Source/manifests and exports were written;
the test does not implicitly save the native world.

That run also exposed a floating-point face-contact bug in the engine's creation
entity-overlap test. The ParaWorld fix uses a tolerance well below 1/512 voxel and
has a regression distinguishing face contact from a real miniature overlap.

## Multiple chat sessions

`paracraft_cli` accepts `chatSessionId` and optional `petId` at the top level.
Use action `context` to obtain a stable chat identifier and retain it across
reconnects. Chats sharing an MCP connection must supply distinct IDs. Job
exclusivity, deduplication, cancellation and selected sites are scoped to the chat;
the engine's world-session identity still fences reopen. Helpers revalidate each
write after yields, so concurrent chats cannot silently overwrite a changed target.

Each chat can retain several named pet references for scouting and independent
captures. Siting uses short renewable reservations to avoid competing claims.
Edits remain sequential per chat: wait for completion, or cancel its persistent
runtime, before the next job. Other chats are not blocked by that chat's lock.

Opt-in native validation: `node scripts/paracraft-multichat-native.cjs <exact-world-path>`.
It runs two chat scopes through one MCP connection against the same world and
checks overlapping jobs, per-chat busy/dedup/cancel/site ownership, three pet
references, and independent captures without moving the player/main camera.

Only the latest active authoring pet is visible in the client. Other chats retain their
pet positions and jobs while hidden. A screenshot or independent camera capture
shows only the requesting chat's selected pet, then restores the latest active pet
(including activity that arrived during capture). Ordinary scene NPCs are unaffected.
Captures share a visibility lease, including movie pose preparation: overlapping
requests return retryable `capture_busy`; retry the capture after the current one
finishes. Editing remains sequential within each chat and independent across chats.

The single MCP gateway also supports desktop startup without a `clientId`:
`{action:"launch", params:{projectId:530, waitSeconds:15}}`. The hub first reuses
a desktop whose project matches and whose world has entered. Otherwise it opens
the installed Windows `paracraft://cmd/loadworld 530 debug="main"` protocol handler.
It never switches unrelated clients. A pending result contains `launchId`; poll
`{action:"launch_status", params:{launchId:"...",waitSeconds:0}}` until `ready`
returns `clientId`, then fetch world capabilities. Pending launches are shared
across HTTP/stdio and chats; registration deadline is 60 seconds. Saving or editing
the opened project remains a separate operation.

Launch checks: `node --test scripts/paracraft-launch.test.cjs` covers reuse,
concurrent launch coalescing, entering worlds, handler errors and timeout recovery.
Opt-in native acceptance: `node scripts/paracraft-launch-native.cjs 530` opens or
reuses the requested project and verifies registration, native health and reuse.

World-scene guidance uses a small native palette of colored fences, stairs, slabs,
slopes and walls, plus textured wood/stone, leaves, glass, windows and doors.
Paintable blocks share the helper's `color="#RRGGBB"` input; block-specific encoding
is internal. BMax props and character visible geometry use only color blocks and
miniature colored voxels; their groups stay separate from native scene materials.
The pavilion example includes native decking, timber posts, colored rails,
and foliage while exporting only its separate color-block prop.

Real-world design scale is one authored block per meter, with the roughly 1.75 m
main player as the reference. The root skill applies realistic sizing to scenes,
BMax props and `.x` characters unless the user requests another scale. Supporting
guides include human-scale anchors, fractional-grid choices, construction/preview
space distinctions and independent export-bound checks. The pavilion example uses
a 6 m deck and 8 m roof; the coarse rig example is explicitly a technical fixture.

Flush-floor helpers: opt in with `terrainDepth`, use `surface` to replace the
supporting ground at local y=-1, and use bounded `terrain` edits for contained
pools/excavation. Original cell snapshots persist in manifests; group removal
restores them before a rebuild. Manual changes remain protected by stale checks.
Native source water's still/flowing ID transitions are equivalent for ownership
checks; water level/data and material changes remain significant.
`node scripts/paracraft-terrain-native.cjs` is opt-in acceptance against the exact
CreationAcceptance disposable world on port 8100: paving, water, saved resume,
original-floor restoration, native undo/redo and a fresh independent capture.
