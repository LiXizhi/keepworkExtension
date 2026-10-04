# Paracraft art creation with MCP

The shared Keepwork MCP server exposes creation capabilities, scouting, source
execution, job status/cancellation, official engine documentation, scene reads,
fresh screenshots and independent camera captures. Use only `paracraft_cli({action,clientId?,params?})`; discover worlds with
`{action:"clients"}`. `{action:"help"}` lists actions and
`{action:"help",params:{action:"run_code"}}` loads one action schema.

Packaged templates can run without copying Lua: query `template_info` for one
of `desk_fan`, `compact_car`, `rowing_boat`, `light_aircraft`, `butterfly` or `bird`, then `run_template` with its hash, world
identity and request ID. Keepwork submits native `run_code` using the same chat,
pet and job controls. It exports unique assets; source saving is opt-in and world
saving remains explicit. See the skill's connection guide for the schema and
transport-recovery behavior. The native engine does not need a new action.
For clean exported-asset feedback, `camera_capture` also accepts a world-local
`asset:{filename,animId,timeSeconds}`. On supported desktop engines it renders a
fresh neutral-background PNG in a separate mini-scene and reports native final
bone poses and meter bounds at scale 1. Time is local to the selected clip; source
movies, world blocks and player/main camera are unchanged. Optional asset yaw,
elevation, meter distance and image size are discovered in the existing action's
schema. Older engines return an explicit unsupported capability error. Native
acceptance: `scripts/paracraft-asset-mcp-native.cjs` and its decoded-pixel check.
For clean multi-part feedback, the same action accepts
`assembly:{moviePosition:[x,y,z],timeSeconds:1.25}`. Supported engines seek movie
time and freeze up to 16 world-local model actors together in a neutral PNG.
Optional actor names and camera settings load through the same action schema.
Native clone bone transforms, relative meter positions and the absolute origin
are returned without changing source timelines or moving the player/main camera.
Use world views for ground contact. Acceptance uses
`scripts/paracraft-assembly-mcp-native.cjs`; no new tool or eager resource.
Each template exposes named RGB palette roles; partial overrides can make a new
variant without rewriting source. Existing placed components still use named
group revisions through `run_code`. Native template acceptance is
`scripts/paracraft-template-mcp-native.cjs` against an exact disposable world.

## Skill distribution

The lazy animal guide also routes `idle_fox`: a ~0.75 m stylized juvenile fox
with a separate bushy tail, pointed ears, cream muzzle and planted paws. Native
acceptance checks all nine tail poses, dimensions and joint offsets; isolated
assembly PNGs show the rest and sway extremes. This template exports two rigid
color meshes and keeps its MovieBlock, without claiming a walking gait or a
single skinned character. Palette roles are discovered through `template_info`.

For integral BoneBlock technical rigs at a different construction scale, the
engine's `voxelExportScale` capability permits uniform baked `exportVoxelX` scale.
Independent acceptance measures mesh dimensions, native pivots and root motion
at instance scale 1, while checking unchanged rotations, source and camera.
This is infrastructure for small multi-joint animals; it does not make the
current rigid `idle_fox` template a skinned walking character.

Packaged `skinned_fox` provides the six-bone counterpart: whole-carrier component
ownership, retained BoneBlocks, baked 1/32 scale, embedded idle ID 0 and diagonal
trot-in-place ID 1. Native isolated-file acceptance checks all six parents and
pivots, foot-corner clearance, both clip IDs, loop closure and unchanged source.
The technical construction site is 30 × 16 × 30 m; delivered bounds are about
0.17 × 0.44 × 0.78 m. This rigid-limb cycle has no knee IK or forward locomotion.

The shared `curious_fox` variant adds one independently bound head bone and an
idle look left/right cycle. Native asset feedback checks seven parents/pivots,
head quaternions, loop endpoints and fixed body/foot poses without a source movie.
The original six-bone template remains available with its own deterministic hash.

MCP `code_job` defaults to `resultDetail:"summary"`: dense actor rotation audit
arrays become counts and time bounds in `resultDetails.omitted`, while job state,
placement, actor dimensions and generated file references remain available.
`resultDetails.full` contains a complete `paracraft_cli` call to retrieve the full
result from the same job, retaining its chat and world identity. Do not rerun the
generator to recover details. This is a gateway display option; native HTTP/poll
job data remains complete and unchanged.

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

## Art improvement series

The [100-round RSI record](paracraft-art-rsi.md) tracks verified changes and remaining
visual defects. Vegetation guidance and its compact garden template load on demand
from the root skill; they add no MCP tools or advertised subfile resources.

The lazy `pond_garden` template combines flush gravel/stone paths, backed-up pool
terrain, native reeds/flowers and horizontal LilyPad 222 (`data=2`), plus a
1.5 m color-only bench exported once and reused at scale 1. Its vegetation guide
loads the example only for geometry changes. Native acceptance checks containment,
original terrain snapshots, member fingerprints, independent meter bounds and
fresh screenshots without moving the player/main camera.

On engines advertising `requestJobLookup`, `code_job` accepts an original
`requestId` in place of `jobId` to recover a lost initial execution response.
World/chat identity remains mandatory; no template is recompiled or run again.
The acceptance runner preserves original request/template metadata on recovery
and labels missing legacy provenance as unknown rather than replacing it with
the current template version.

Stdio ignores a discovery record naming an exited process and chooses its
configured hub port before sending an action. A live process still takes
precedence. Failed requests never retry mutations against another port; recover
the original job/request instead. Tests cover native fresh-image feedback under
stale discovery and verify exactly one dispatch for execution.

Template metadata includes `requiredCapabilities` only for examples that require
a newer helper. The single gateway checks those flags and exact world identity
before dispatching source. Missing capability or changed session sends no
construction request; templates with sequential fallbacks incur no extra read.
