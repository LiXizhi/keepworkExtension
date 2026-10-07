# Paracraft art creation with MCP

## Game-engine workflow acceptance — 2026-10-07

The skill now starts rule-driven work with `references/game-engine.md`: translate
inputs, state, feedback, endings and reset into native scene/actor/CodeBlock/movie
responsibilities; prove uncertain capabilities with a playable slice before art
expansion. Static-art workflows remain available on demand. Canonical files are
under `skills/paracraft-create/`; the local Codex skill is a junction to that tree.

This iteration used a separate desktop client on port 8100 and the dedicated
`CreationAcceptance_Engine_RSI_20261007` world. The native checks were:

| Suite | Passed | Evidence |
|---|---:|---|
| Three games and genuine rule transfers | 31 | Sequence puzzle/movie, 4×4 connect-three in four directions, draw/boundary rules, natural lane victory/defeat, unordered switches, connect-four, stale inputs, isolation, missing dependency recovery and stop cleanup |
| Input and persistence | 12 | Native keyboard event dispatch, interrupted movie reset without drift, saved code/movie/mesh/source, fresh session and actual play after reopening |
| Revised collection/NPC regression | 23 | Real 20-second timeout, repeated hits/restarts, patrol/follow/idle, actor cleanup, power cycling and preserved player/camera |
| Collection deadline boundary | 3 | Different CodeBlock clock origins, deadline-equality rejection of the last hit, 200 native requests score exactly five |

The 31-game suite also passed again using the final packaged `engine_games`
compiler, independently of the first raw-source installation. Counts above do
not count that repeat twice. Running close-up captures showed labeled puzzle
inputs, colored board state, visible rules, and danger-lane feedback.

Observed corrections are reflected in examples and guidance:

- Explicit replacement is needed even when layering a second material over a
  floor created by the same generator. A failed early layout left one unused
  floor in the disposable test world; it is not a playable station.
- Read the native lever state when deciding whether to toggle, then wait for
  consistent powered/loaded/actor state. Reading only the delayed code state
  caused a hot-edit restart to toggle in the wrong direction.
- `getTimer()` belongs to a CodeBlock's local lifetime. The collection example
  now queues target IDs and adjudicates score/deadline in one controller, with
  deadline taking precedence at equality. Feedback follows accepted hits.
- Keyboard registration disables stop-last, unlike the default event policy;
  short input callbacks and one worker also prevent concurrent long handlers.
- Stop a movie before returning position ownership to game movement; a test
  reset during playback and observed no later positional drift.

`template_info {template:"engine_games"}` discovers the inactive six-station
lab under `interactions`; `run_template` retains normal identity/hash/recovery
semantics. A measured native compiler input was 263 bytes versus 8,094 bytes of
generated Lua, excluding the surrounding MCP envelope. The final fresh HTTP MCP
session discovered the template and new guide and recovered the existing native
job by original request ID, without repeating construction. The extension's
non-versioning compile and 15 guide/template/package tests passed; skill validation
passed with Python UTF-8 mode (`python -X utf8 .../quick_validate.py ...`).

Evidence directories under `%TEMP%` are `paracraft-engine-rsi-20261007-v2`,
`paracraft-engine-rsi-lifecycle-20261007`, `paracraft-engine-rsi-collection-20261007`,
`paracraft-engine-rsi-deadline-20261007` and `paracraft-engine-rsi-packaged-20261007`.
Native runners are `scripts/paracraft-engine-games-native.cjs` (optional
`--template`), `paracraft-engine-lifecycle-native.cjs`,
`paracraft-codeblocks-native.cjs`, and `paracraft-collection-deadline-native.cjs`.
The lifecycle/deadline runners take the relevant prior `build.json` after
`PORT WORLD_PATH OUTPUT`; `paracraft-engine-mcp-check.cjs` takes saved request/job
JSON and performs read-only discovery and job recovery.

These are desktop rule/event/actor tests, not a claim that every game genre has
been validated. Hardware keyboard/focus, screen picking, mobile/WASM, multiplayer,
pathfinding and physical collision for the lane game remain untested. The lane
game intentionally uses abstract lane checks, not physical collisions. The
examples use prototype art. Protected edits to native code do not silently
refresh old construction-manifest fingerprints: preserve conflicts and use the
recorded native source as authority rather than blindly rerunning a generator.

During final delivery the test client's native endpoint disconnected. A new
isolated client reopened the saved world and confirmed the original six-station
lab; the later packaged lab and collection/NPC runtime installations had not
been saved. They were not blindly reconstructed. Their tests, screenshots and
source remain evidence, while world documentation explicitly separates that
history from the six retained stations. All six retained controllers were
confirmed off and the consolidated documentation/source was followed by a
successful native local save. `%TEMP%/paracraft-engine-rsi-final-state.json`
records the fresh identity, inspected controls and save result.

CodeBlock follow-up acceptance on 2026-10-07 passed **39 native checks**:
the original 23 gameplay/NPC/power/reset checks, plus 16 checks covering two
isolated template games, retry deduplication, stale-round input, 200 queued clicks,
12 board-rule assertions, source/manifest/mesh persistence, native save/reopen and
fresh gameplay after reopen. Evidence is retained in the OS temporary directory
`paracraft-codeblock-perf-20261007`; the dedicated world is
`CreationAcceptance_CodeBlocks_Comprehensive_20261007`. Native screen picking and
complete F1 tutorial playback remain untested. All test controllers are off.

The original acceptance run used 311 native calls (including seven build/job
calls), 165,477 request bytes and 179,270 response bytes in 29.4 seconds.
Repeating the same 23 checks on the existing inactive scene used 122 calls,
68,288 request bytes and 118,457 response bytes in 28.0 seconds. Excluding the
seven first-build calls, acceptance calls fell from 304 to 122 (60%); native
behavior probes fell from 292 to 111 (62%). Counts measure transport calls and
UTF-8 JSON bytes, not tokenizer output. Natural timeout remains a real 20-second
test. Adaptive 150 ms–1 s polling, compact state/source-length returns, batched
clicks/power-off and one document update reduce traffic without skipping checks.

`template_info {template:"codeblock_playground"}` / `run_template` now creates
the physical collection-game/NPC combination from packaged source. A measured
request was 300 bytes versus 6,448 bytes of generated Lua, before the Lua's JSON
escaping; model-side source copying is avoided. Request IDs still isolate scene,
shared-state and mesh names and deduplicate retries. `saveSource:true` preserves
editable source/manifest but does not save the native world. The updated template
is included by the extension build; an already running older daemon needs its
normal restart/update before it recognizes the new name.
The current singleton daemon was checked with a fresh SDK MCP session: the new
template was discovered, `run_template` completed, and an identical retry
recovered the existing job. Native development CLI then confirmed real lever
activation, running game state and five clones; controls were stopped and the
disposable world saved. This live request used 358 parameter bytes with a hash,
versus 6,431 bytes of packaged Lua. `run_npl_code` is a native development action,
not an action exposed by the general creation MCP tool.

Additional acceptance: `node scripts/paracraft-codeblocks-comprehensive.cjs PORT
WORLD_PATH OUTPUT`. This runner saves/reopens only a guarded disposable world,
checks fresh session identity and retries read-only readiness observations. Movie
reload supplies a default character skin on these self-colored `.x` meshes;
acceptance records that difference and compares their applicable asset/scale
fields and mesh bytes. Skin-dependent actors must still compare actual skin.

CodeBlock creation now routes to
[code-blocks.md](../skills/paracraft-create/references/code-blocks.md), with
[interaction patterns](../skills/paracraft-create/references/codeblock-patterns.md)
and a [native lesson map](../skills/paracraft-create/references/codeblock-lessons.md).
Research on 2026-10-07 indexed 41 installed F1 programming lessons and 141 loaded
CodeBlocks in project 530 (CodeBlockTest), then read 23 selected programs and their
native movie associations. Project 530 remained read-only; its historical samples
were not executed. The map distinguishes lesson metadata/template source from
full tutorial playback and tested behavior.

[codeblock-playground.lua](../skills/paracraft-create/examples/codeblock-playground.lua)
creates editable CodeBlock/MovieClip/lever stations for a timed collection game
and patrol/follow/idle NPC, plus a world-local miniature color mesh. It does not
activate or save the world. Native acceptance in the disposable
`CreationAcceptance_CodeBlocks_Verified_20261007` world passed 23 behavior checks:
real lever power and actor association, clone count, hit deduplication, winning,
natural timeout, mid-round reset, rapid repeated start, NPC motion/state changes,
power-off cleanup, power cycling and missing/restarted target station recovery.
The final programs were also installed through protected source read/update/readback.
The independent capture preserved the player and main camera. Native click dispatch
was tested; OS screen picking, 41 full tutorial replays and native save/reopen were
not. All three test stations were switched off afterward; world documentation and
the mesh file exist, while native world edits were not saved by the test.

The interruption test exposed an existing runtime edge: `broadcastAndWait` can
wait indefinitely after the last receiver unregisters while its event container
remains. The example uses asynchronous cleanup, monotonic round epochs and
per-actor stale-round checks; it does not change the engine. Guidance also covers
default stop-last-event behavior, avoiding yielding click handlers with stuck
busy flags, and the seconds/milliseconds distinction in movement/movie APIs.

Reproduce with `node scripts/paracraft-codeblocks-native.cjs PORT WORLD_PATH OUTPUT`
in an initialized disposable `CreationAcceptance_CodeBlocks_*` world. The runner
loads the actual skill example, retains request/job identity for recovery, uses
`run_npl_code` for native observations and `tail_log` for recent logs, records
behavior results/capture and updates world docs. A supplied existing build must
match the current world session; it never rebuilds merely to recover a response.

Integrated scene authoring now routes to
[integrated-scenes.md](../skills/paracraft-create/references/integrated-scenes.md):
shared meter-based layout and scouting, cell ownership/deduplication, compact
inspection returns, component checkpoints and separate visual/functional checks.
It clarifies that a failed job can retain earlier successful helper edits; resuming
an older manifest is not recovery. Native undo must be bounded to owned operations
and checked against actual cells, including newly added cells.

An independent desktop trial on 2026-10-06 built a 32 x 28 m wooded waystation:
two enterable cottage shells, flush connected roads, courtyard seating, three
trees, relief and native `Enable AND (A OR B)` lighting. Initial construction took
5906 ms and authored 755 cells in 16 groups. All eight native lighting combinations
passed. A 219 ms single-roof revision preserved native ID/data signatures of the
roads, other house and lighting. Immediate imagery initially showed the old roof
color; subsequent same-view capture confirmed the updated mesh. The visual guide
now distinguishes native data, render-mesh readiness and fresh-image delivery.

The initial inspection payload was 59,484 bytes; retaining group counts, bounds,
stale totals, origin and artifacts reduced the equivalent summary to 1,517 bytes
(about 97%). Three equivalent 200-cell surface probes measured 109–219 ms for
200 per-cell helper calls and 31–47 ms for ten row spans; all six cases restored
the original native ID/data after removal. These are this desktop's observations,
not total-task or universal speed guarantees. Preparation and functional waits
are separate costs. The code environment did not expose ParaGlobal directly;
the probe used commonlib.TimerManager.timeGetTime after checking the native source.

The trial exposed missing gable infill and a unit-amplitude height field collapsing
to isolated cells; the settlement/terrain guides now cover these concrete checks.
A refinement also failed on overlapping foliage placements after previous helpers
had succeeded. Precisely bounded native undo restored the saved geometry in 72
steps, with fingerprint and extra-cell checks; no forced snapshots or raw block
overwrites were used. Trial requests, generators, native results and images are
retained outside the world in the OS temporary folder
`paracraft-integrated-20261006-2010`; final editable source and docs belong to the
disposable `CreationAcceptance_Integrated_20261006_2010` world.

With the revised guidance, a subsequent refinement completed in 671 ms, retaining
781 cells in 18 groups. Fresh reopened images confirmed green west roofing,
filled gables, thinner asymmetric crowns and wider stepped relief. Native local
save/reopen advanced the session identity to 3; the 4,298-byte full generator
matched exactly and all 751 non-circuit members matched their stored fingerprints.
One of 30 circuit cells differed through normal Wire simulation; all eight input
combinations passed again and the lamp was reset off. Doorway dimensions and the
approach's native occupancy were checked, but actual player traversal was not.
The scenery remains a compact stylized test fixture, with terraced hills and an
exposed teaching circuit; these images do not establish polished landscape art.

Finally, the opposite courtyard bench was corrected in 47 ms: native stair data
2 and 1 confirmed opposing backs, with 0.5 m seats and a fresh close-up. The full
generator then became 4,319 bytes and native saving succeeded again. This final
bench revision was saved but not separately reopened; the comprehensive reopen
checks above precede it.

The full exercise took roughly 24 minutes, including preparation, functional
waits, visual iterations and approximately six minutes of failure recovery.
Construction timings and payload reduction should not be presented as that total
workflow's measured speedup. Detailed report and reopened images are retained
in the same external temporary evidence folder.

Circuits and connected mechanisms use one integrated
[circuits.md](../skills/paracraft-create/references/circuits.md), replacing the five
component guides. It covers series signal paths, AND conditions, parallel inputs
and outputs, repeaters, logic, timing, memory and application recipes, with an
index to the 37 native circuit lessons and their actual block-template files.
Paracraft teaching resources and implementation are authoritative; Minecraft
official references inform the teaching structure. The guide includes a self-contained
Lua builder for eight demand patterns, so common circuits do not need access to
the installation's template files. Native acceptance on 2026-10-06 extracted this
exact example into a fresh disposable world and passed 32 state checks, including
all OR/AND and three-input mixed truth-table combinations, button release, fan-out,
long-range regeneration and four-stage activation/deactivation timing. First-on
times were 0/390/797/1250 ms; first-off times were 0/422/875/1329 ms on that run.
The evaluation corrected lateral wire-to-lamp connections: native wire strength
does not establish power output on every adjacent face. Eight independent native
captures preserved the player's location and main camera. Screen picking and all
37 teaching lessons are outside this acceptance scope.

Reproduce with `node scripts/paracraft-circuits-native.cjs PORT WORLD_PATH OUTPUT
PARAWORLD_ROOT skill` after entering and initializing a disposable
`CreationAcceptance_Circuits_*` world. The runner fences world identity, extracts
the guide's first Lua example, uses native click handling and simulation, and
retains request/job, source, ports, state observations and timing traces in OUTPUT.
It never saves the native world. World continuation uses existing circuit notes
or direct `docs/circuits.md`, keeping native saving separate.

The guide now prioritizes synthesis from boolean conditions, history/state and
timing contracts. Lessons explain primitives; layouts are redesigned for the
current requirement. Challenge coverage includes four-input lighting with three
outputs, independently remembered puzzle achievements controlling an iron door,
and button-latched warning lights with a native feedback oscillator, staggered
edges, bounded stop drain and restart. It covers negative logic ports, feedback
distance, initialization, reset conflicts, spatial isolation and pulse/stop budgets.

Reproduce the transfer evaluation with
`node scripts/paracraft-circuits-transfer-native.cjs PORT WORLD_PATH OUTPUT`
in an initialized `CreationAcceptance_Circuits_Transfer_*` world. It synthesizes
layouts without reading lesson files or copying the guide's standard examples;
native circuitry controls outputs, while the runner creates, clicks and samples.
On 2026-10-06 all 27 state checks passed, all three channels repeatedly rose in
order, restart passed, and stop samples after 2000ms stayed off (last powered
sample 1859ms). Source, request/job, ports and native traces are retained in
`temp/circuits-transfer-20261006-v8/`. Player position/scale and main camera were
preserved. No native world was saved. Captures failed or were black, so this
transfer run establishes functional behavior but does not establish visual review.

The evaluation exposed and corrected two engine issues in ParaWorld:
`BlockRepeater:OnBlockRemoved` temporarily retains orientation/delay metadata
for on/off notifications, and `BlockLogic` permits new input edges after an entry
has already run in the current tick. Pending-coordinate deduplication remains in
the simulator. These fixes are required by this native acceptance result; older
clients must be rechecked. The runner preserves failures and reports them instead
of forcing output states or replaying construction.

Engines advertising nativeHalfBlocks now accept half-grid batches that classify
each carrier into native full blocks, six slab orientations or native stair
variants including corners, inner corners, inverted and sideways shapes.
The [half-block guide](../skills/paracraft-create/references/half-blocks.md) lets
the AI describe tread/high-half geometry instead of camera-relative direction
numbers. Textured size=1/2 shape calls use the same converter; ordinary ColorBlock
microvoxels retain their exportable form unless opted in. Unsupported textured
masks fail without a partial write, while uniform color partial masks use existing
microvoxels. Supported materials and collision/visual review are documented there.
Opt-in acceptance: `PARACRAFT_TEST_PORT=8100 node scripts/paracraft-half-blocks-native.cjs OUTPUT`
against an entered CreationAcceptance_HalfBlocks* disposable world. It verifies
four directions, paired benches, slabs, preserved color carriers, failed-batch
isolation, manifest resume, native undo/redo and fresh independent screenshots.

Lifecycle subguides are loaded on demand: client-startup.md for desktop startup
with/without a project ID, local-worlds.md for named anonymous/signed-in local
create/open/save, and login.md for optional native sign-in. `launch` may omit
projectId; its target=client readiness means registration, while target=project
still requires matching world entry. Local lifecycle calls use `run_command`
with params.world; the frontend's manage_world name is not a gateway action.

The canonical skill now routes natural landscapes to
[terrain-biomes.md](../skills/paracraft-create/references/terrain-biomes.md) and
villages/city streets to
[settlements-roads.md](../skills/paracraft-create/references/settlements-roads.md).
These guides cover continuous deterministic relief, mountains, dunes, snowfields,
plains, habitat transitions, connected roads and terrain-aware building placement.
They use existing CLI creation/inspection actions; no new biome action or packaged
landscape template is claimed. Authored biome appearance is distinct from native
generator settings. Flat scouting, loaded cells, terrainDepth and bounded-volume
limits still apply. Large work uses inspected adjacent regions with stable origins
and explicit shared-cell ownership.

World continuation records go directly in docs/terrain.md, docs/settlements.md and
docs/roads.md when relevant, linked from the world's docs/README.md. Keep seed,
absolute region bounds, height/water/snowline parameters, road connections and
generator/manifest paths. Source stays under creation/<name>/ and exports under
blocktemplates/. Existing world_docs expected-content checks and separate native
save semantics remain in force. Guide/link and exact-copy package checks cover
distribution; live landscape generation and visual acceptance require a separate
disposable-world run.

The shared Keepwork MCP server exposes creation capabilities, scouting, source
execution, job status/cancellation, official engine documentation, scene reads,
fresh screenshots and independent camera captures. Use only `paracraft_cli({action,clientId?,params?})`; discover worlds with
`{action:"clients"}`. `{action:"help"}` lists actions and
`{action:"help",params:{action:"run_code"}}` loads one action schema.

Discover candidates through the same `template_info` action with a category/query
and `limit` (default five, maximum ten). `offset:nextOffset` reads another page.
This returns curated metadata without reading any Lua; named lookup loads only
the selected source/hash. Categories cover architecture, gardens, furniture,
animals, characters and moving objects. No new MCP tools/resources are advertised.

Extension and Local Helper builds copy the same canonical skill into their own
output. Successful rebuilds replace only the generated skill subtree, so removed
guides cannot survive as obsolete bundled files; failed builds keep the previous
successful copy. Canonical-source overlap and linked output directories are
rejected. Validate this with `node --test scripts/creation-skill-build.test.mjs`.

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
## World memory and native films

The Skill now reads the selected world's AGENTS.md at every task start and world
switch. Before the first edit, missing files are initialized via `world_docs`;
analysis-only tasks remain read-only. Detailed documents live directly under world
docs/ (README, codeblocks, movies, signs, modules, changes), not docs/paracraft/.
Updates preserve user text outside managed sections and use expectedContent.
Failed document writes never justify replaying scene edits. Native saving remains
explicit; docs identify unsaved changes that a new session must verify.

`analyze_world` defaults to grouped counts and examples above 50 matching objects;
`view:"summary"` forces a compact overview and `view:"objects"` expands paginated
details through the returned cursor. Large code/sign documentation groups inspected
objects by purpose, module or area and links focused notes directly under docs/.
It avoids copying every source or sign and explicitly records sampling/coverage.

`analyze_world` is a paginated saved/live object index. Core objects are code blocks,
MovieBlocks, signs and third-party smart modules, including AgentSign provenance,
versions, dependencies and connected code. Unloaded region XML is parsed without
loading entities or running code. Inspect returned world_object refs via existing
read_scene_object. Scope/coverage and inferred relationships are labeled.

The lazy filmmaking guide covers same-world sets, reusable actors, camera tracks,
native master/child movie sequences, continuous playback and editable delivery.
Engine helpers cameraKeyframes, movieSequence and playMovie are capability gated.
Both products continue packaging the canonical Skill; no extra MCP tools/resources.

Validation: `node --test scripts/paracraft-world-memory.test.cjs` plus guide/build
and scene/transport regressions. In a disposable CreationAcceptance_WorldMemory_*
world run `paracraft-world-memory-native.cjs OUTPUT`, then
`paracraft-world-memory-reopen-native.cjs OUTPUT`, then
`paracraft-film-playback-native.cjs OUTPUT`. Set PARACRAFT_TEST_PORT when needed.
The reopen runner deliberately saves the fixture and leaves its final camera
revision unsaved; the playback runner verifies all three shots and camera recovery.
Native reports and fresh screenshots are written to OUTPUT. The test geometry is
a technical fixture, not a finished animated story.

## Fifty-round integrated scene campaign

The 2026-10-06/07 campaign completed 50 independent native rounds: five scene
families × five design/control variants × two write strategies. All 25 pairs
have equal actual native geometry after scoped revision and save/reopen, with
486 circuit assertions, 30,906 geometry checks and 100 fresh images manually
reviewed. Contiguous spans reduce native build elapsed time by a median 31.7%
and helper calls by 84.8%; native guards remain enabled.

[Campaign report](paracraft-integrated-50-report.md) records reproducible runners,
evidence locations, recovered failures, timing method and coverage limits.
The skill now also covers sandbox-safe timing, settled camera baselines,
same-path asynchronous session changes, actual slab collision support and
avoiding unchanged ground writes. Additional sparse-ground/height speedups are
recommendations, not measured results. These fixtures do not establish actual
player traversal or finished environment-art quality.
