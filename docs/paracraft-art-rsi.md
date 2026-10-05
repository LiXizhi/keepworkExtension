# Paracraft art RSI: 100 verified iterations

Target: improve beautiful Minecraft-like editable scenes, props, animated small
animals (dedicated on-demand guide), characters and moving fans/cars/aircraft/boats,
plus trees and flowers. Retain one MCP tool and one root skill. Completed: **100/100**.

A round must change maintained skill/template/CLI behavior and provide relevant
verification. Native code success does not count as visual quality: inspect fresh
images and record defects. Failures and retries within a round do not inflate the
round count. Every round adds a distinct improvement; do not count placeholders.

## Queue (adapt using observed failures)

- Next: isolate reference views from neighboring acceptance fixtures and temporary
  bounds overlays; improve crown asymmetry and add distinct tree species.
- Then: deterministic tree species, clustered flowers, reusable compact generators
  and truly lazy guide reads as the catalog grows.
- Dedicated animated-animal guide and templates: small birds, quadrupeds, tails,
  ears, gait/idle poses with meter-scale rigs and independently verified clips.
- Characters and props: silhouettes, material palettes, joints, accessories,
  BMax scale/readiness and source-backed component revision.
- Moving objects: pivoted fan, wheel/steering car, propeller aircraft and floating
  boat; local pivots, reusable clips and multiple-time screenshots.
- Scene composition: buildings, paths, terrain/pools, vegetation placement,
  landmarks, readable negative space and lighting/viewpoint comparisons.
- Revisit weak categories using new captures; add useful variations/templates,
  reduce execution latency and returned data, then regression-test integrated
  scenes and independently reloaded animated assets. All 100 rounds require
  concrete improvements; this queue is not evidence of completion.

## Round 001 — world vegetation starter

Changes: one optional vegetation guide and executable 10 × 7 × 8 m garden.
Native logs/leaves form a chamfered 6 m tree; quarter-meter color voxels form
pink/cream flowers and grass. Stone road replaces ground through `surface`.
One tree group and one miniature bed group respect per-carrier ownership.
Return group counts/stale totals/camera vectors instead of full members.
Added a reusable native template runner with exact-world fencing, durable job
handle, capture metadata, bounded polling and output files outside the skill.

Evidence:

- `node --test scripts/paracraft-guide.test.cjs`: 2 passed; single gateway/root,
  link resolution and on-demand reads remain intact.
- Skill creator quick validator: passed.
- `node scripts/paracraft-template-native.cjs 8099
  C:/lxzsrc/ParaEngine/ParaWorld/worlds/DesignHouse/CreationAcceptance_20261003/
  skills/paracraft-create/examples/vegetation-garden.lua out/rsi/001c`: passed.
  Real engine, automatic site, nonempty/stale-free groups, two fresh captures,
  unchanged player position and main camera. Project 530 was not edited.
- Local artifacts: `out/rsi/001c/{overview.jpg,detail.jpg,report.json,job.json}`.
  The runner explicitly saves test source/manifest, not the native world.

Observed failures and fixes: first snapshots missed freshly written geometry;
recapture showed it. Template now yields one second for native chunk meshes.
Player idle-facing changes made whole-player equality unsuitable for stationary
position checks; report heading separately, compare position and exact main
camera across capture. Do not claim heading preservation from this test.

Visual review: native leaf texture, trunk and flush road read clearly; flowers
have visible stems, petals and yellow centers at sub-meter scale. Crown is partly
cropped in the overview, neighboring test fixtures and temporary bounds overlay
pollute the reference, and grass is still simplistic. These remain next-round
work, not claimed resolved. The starter is a baseline, not proof that the complete
100-round quality goal has been achieved.


## Round 002 — complete silhouettes and grounded grass

Changed the garden overview to frame the whole crown using a camera outside the
construction footprint. Native units are derived from two legal `toWorld` points;
the 10 × 7 × 8 m construction bounds remain unchanged. Replaced two-cube grass
with three grounded, unequal blades at 1/8 m resolution; added these concrete
choices to the optional vegetation guide.

Evidence: native template runner passed in the same exact disposable world.
`out/rsi/002/{overview.jpg,detail.jpg,report.json}` contains two fresh views,
nonempty/stale-free group checks, stationary player position and main camera.
Images inspected: crown now fully visible with air above; slender grounded grass
is visible in the near view. Flower colors and flush stone path remain readable.
Temporary blue bounds and neighboring fixtures still clutter the images. These
are recorded unresolved, not claimed fixed.

## Round 003 — constant-cost on-demand guide reads

Runtime `readCreationGuide` now resolves and reads only the requested packaged
file; it no longer enumerates and reads every guide/template. Keep whole-catalog
enumeration solely for packaging/link audits. Preserve relative-path validation,
realpath confinement, file-type/size limits and explicit missing-file errors.
No tool/resource/schema expansion and no permanent cache that could hide edits.

Evidence: 3 guide tests passed, including a file-I/O spy proving one content read
and zero directory enumeration for vegetation. Traversal, absolute paths,
backslashes, missing paths and unsupported extensions fail before content reads.
The standard MCP test still proves one Paracraft gateway, one root resource and
on-demand action/guide reads. Shared TypeScript and repository layout checks pass.
This is a catalog-scaling latency improvement; it does not claim a measured
end-to-end model speedup or additional visual quality.


## Round 004 — native habitat and textile palettes

User correction: world vegetation should reuse existing plant block models rather
than defaulting to handmade miniature flowers. Added a short material router and
three separately loaded palettes: plants, ground/water and textiles. Each provides
native registry names/IDs, visible form, use and support/placement constraints.
Includes 50 exact name/ID pairs, distinguishing turf from tufts, droplets/ripple
stone from liquid water, and thin carpets from full wool cubes. Preserve color-only
geometry for BMax/characters. Deterministic habitat-masked scatter leaves paths
clear; puddles form connected, contained terrain replacements with backups.

Added native-material-garden.lua (no save/export) and generalized the native test
runner's unique scene-name substitution for simple `createScene` examples.
Also recorded the user's fallback: consult temporary Minecraft images/templates/
schematics for economical block combinations, keep external references out of
this skill, adapt verified Paracraft IDs, then use miniature voxels/BMax if needed.
No external reference was needed or added for this palette work.

Evidence: XML and live `run_npl_code` registry checks both verified all 50 named
pairs; live checks confirmed uniform color support for IDs 133/234/279. Native
runner passed automatic siting, nonempty/stale-free groups and stationary player
position/main camera. Fresh overview/detail screenshots visually show native
red/yellow plants, reed edges, water/pad, textured wool cubes and thin rugs.
After the temporary overlay expired, recaptured the same views without editing;
updated `out/rsi/004/report.json` records their metadata and live palette checks.
Water appears dark in this lighting/reflection setup; do not promise a fixed blue
screen color. A pleasing integrated scene remains future work; this is a material
reference/placement fixture, not a polished finished landscape.


## Round 005 — animal workflow and honest geometry readiness

Added a dedicated dynamically loaded animal guide: meter-scale silhouettes,
rigid versus articulated movement, rest/extreme/transition/loop checks, and
independent scale-1 asset reload. No new MCP tool or advertised subresource.
An experimental sub-meter bee exposed a concrete export gap: generic miniature
BMax export embeds BlockModel references, but the MovieBlock actor's loaded asset
has zero geometry bounds. Its position keys exist; identical captures were not
proof of hovering. Removed the experiment from the shipped skill; retained it
only as local failure evidence at `out/rsi/005/hover-bee-experimental.lua`.

Fixed native model/actor readiness to require finite nonempty bounds (flat models
remain valid). Loaded-empty assets fail with `asset_geometry_empty`; pose captures
fail with `pose_geometry_empty` instead of reporting successful invisible poses.
This is a validated reliability improvement, not a completed animated bee.

Evidence: 9 native CreationAssetRegression checks passed through run_npl_code:
empty/missing/invalid/infinite/NaN boxes, flat geometry, late geometry readiness,
loaded-empty errors and unloaded timeout errors. Real experimental actor's zero
bounds and actual persisted y keys are in `out/rsi/005/actor-audit.json`.
Its fresh capture now rejects with pose_geometry_empty and no image bytes;
`empty-pose-rejected.json` proves it. The earlier report is explicitly marked
visualAcceptance=false. Three guide/MCP tests and skill validation passed.

Next priority: a renderable single-mesh path for miniature animal geometry,
with intrinsic meter-scale assets, then articulate wings/legs and verify clips.
Do not solve this by inflating source geometry or counting invisible animation.


## Round 006 — renderable meter-scale miniature animals

Added `scene:exportVoxelX(filename,group)` in the native Code creation subsystem.
It expands color voxels onto one integer grid, preflights the 65536-cell limit,
yields during expansion, rechecks stale source/file collisions and uses the
installed ParaX exporter. Normalize geometry and pivots inside the file so
scale-1 reloads retain the intended meter dimensions. Only color geometry is
accepted; no implicit articulation or clip export. Preserve editable source.
Capabilities and bundled wiki document the new path; native regression is tracked.

Recovered hover-bee.lua as a working example: 0.75 m body, 0.5 m total height,
1 m wingspan, standalone .x reload at scale 1, two-second whole-animal hovering
with five explicit keys. This is a deliberately stylized bee; wings are rigid.
Extended native runner to check actual actor position/time, intrinsic dimensions,
scale and loop endpoints. Existing-job capture mode avoids repeating mutations
when only visual/pose feedback is needed.

Evidence:

- Five native expansion regression checks pass: mixed resolution, unique/negative
  coordinates, color blocks only, excessive expansion rejected before allocation/
  checkpoint and empty geometry rejected; original packed whole-cell data retained.
- Full native run in the exact disposable world: `out/rsi/006d/report.json` records
  all five poses, exact 0.75 × 0.5 × 1 m bounds at scale 1, varying height matching
  the timeline, matching loop endpoints, stationary player position/main camera.
  A separate model instance loaded the same file at scale 1 with nonempty bounds.
- Overview/detail plus five time captures inspected. Correct color regions and
  whole-animal rise/fall visible. Temporary overlay/background remain reference
  clutter; this round does not claim those fixed or animated wing articulation.
- Three MCP/guide tests and skill validator pass; no additional MCP tools/resources.

Observed retries: textured export first discarded useful color tint; color-only
export with inappropriate winding showed missing/inward faces. Use the installed
exporter's color-vertex path and native default winding, disable destructive LOD
on this export instance. Incorrect interim attempts remain in 006/006b; 006d is
acceptance evidence. They are retries inside one round, not extra rounds.

Next: articulated wings/legs and verified clip export; improve the bee silhouette
and clean review frames, then expand other animals and moving-object templates.

## Round 007 — rigid-part pivots and actual fan bone rotation

Changes: `exportVoxelX` accepts a scene-local pivot, rebases shared vertex tables
once and updates extents while retaining intrinsic meter dimensions. Its named
`root` bone has an identity pose and native animBones header. Added a lazily loaded
moving-object guide and an editable color-only desk fan template. The root skill
clarifies temporary Minecraft reference use without storing external examples.

Evidence:

- Seven native export regression checks pass, including shared-vertex rebasing
  and extents. Skill validator, three guide tests and extension build pass.
- `out/rsi/007d/report.json`: automatically scouted site, independent scale-1
  housing and rotor assets, six fresh poses, exact 1 × 1 × 0.125 m rotor bounds,
  native final bone quaternions matching the requested turn at every time, five
  persisted native rotation keys, and unchanged player position/main camera.
- Reviewed 0 and 0.125 second frames: rotor changes from cross to diagonal cross
  around its center while the housing stays fixed. Symmetric 0.125/0.375 frames
  look alike; different measured quaternions verify their distinct orientations.

Retries 007/007b showed saved keys with no visible rotation. Seeding the root pose
alone made the bone animated but still required the native file-header animBones
flag. 007c proved visible motion; 007d adds numerical final-pose acceptance. These
are one round. The low-detail cross rotor is a reusable animation foundation,
not a finished high-fidelity appliance. No embedded clips or multi-bone miniature
skinning claimed yet.

Next: improve the fan silhouette and grille, reuse pivots for articulated small
animals, verify exported clip IDs and reduce repeated scouting latency.

## Round 008 — realistic desktop fan silhouette

Replaced the oversized cross rotor with a ~0.44 m curved three-blade rotor at
1/32 m resolution, a hub, compact motor, sparse protective wires, a rounded ring
and switch. Overall height is ~0.78 m. The assembled source/asset stays at scale 1;
close independent views frame the smaller appliance without moving the player.
The moving-object guide explains clearance, sparse guards and intentional joins.

`out/rsi/008b/report.json` verifies auto placement, stale-free groups, six fresh
poses, native final bone quaternions, a 0.4375 × 0.40625 × 0.03125 m rotor and
stationary player/main camera. Inspected detail and 0.125 s: three curved blades,
negative space and guard wires are readable, and the rotor visibly turns behind
the stationary grille. Retry 008 detected a stem/motor overlap; 008b uses explicit
replacement only at that intentional join. One round, not two.

## Round 009 — centimeter-scale butterfly with two animated wings

Added a patterned orange/black/cream butterfly with a ~12.5 cm wingspan and
6.25 cm body using 1/128 m color voxels. The body and two independent scale-1
wing meshes retain editable sources; wing roots meet the body edges and use
mirrored angle keys. The dedicated animal guide now distinguishes real insect
scale from the earlier large bee toy and documents this rigid-part articulation.
The acceptance runner batches three actors' dimensions/joints/final rotations
in one native query per frame and waits boundedly for transient geometry readiness.

`out/rsi/009c/report.json` proves six fresh poses, exact three-part meter bounds,
unchanged joint positions, five native rotation keys per wing, final quaternions
matching all keys and the interpolated transition, matching loop endpoints and
stationary player/main camera. Reviewed 0.25/0.75 s: closed and spread patterned
wings are visually distinct. Nine asset and seven voxel native regression checks,
three guide checks, skill validation and extension build pass.

Found an external-bone interpolation cache failure at a direction reversal:
saved 70° keys evaluated at the prior 45° pose. Extending the idle duration did
not fix it and was removed. Creation seek/capture now reloads authoritative
MovieBlock tracks before evaluation. Both the original zero-length-idle assets
(009 recapture) and final newly exported small assets (009c) pass all final-pose
checks. Retries 009/009b/009c are one round. Assets are three rigid meshes plus
an editable MovieBlock; no single-file skinned rig or embedded clip IDs claimed.

Next: reduce repeated polling/scouting cost, then add a bird with wing/tail
articulation and validate a native BoneBlock character with embedded clip IDs.

## Round 010 — reuse the pet and reduce status traffic

The native template runner now retains a stable world-session authoring context
across sequential scripts while giving every scene/request a unique name/ID.
It polls at 500 ms instead of 150 ms (71% lower configured maximum polling rate)
and records per-action call counts and creation/capture durations. The connection
guide recommends stable chat identity, modest polling and compact results.

`out/rsi/010a` and `010b` show separate butterfly/fan jobs using the same
`rsi-validation-2` context and `__cli_pet_21__` entity. Creation times were 33854 ms
and 9559 ms, with 60 and 13 status calls respectively; these different subjects
are observations, not a controlled claim of a universal speedup. The three-part
butterfly audit used six native calls across six frames; the old single-part fan
audit used twelve. Both runs passed fresh multi-time captures, native poses,
dimensions and stationary player/main camera checks. No extra server tools.

## Round 011 — wing/tail bird with verified moving attachments

Added a ~31 cm stylized garden bird: ellipsoid torso/head, contrasting breast,
beak, eyes and feet; two tapered wings with feather tips and an independently
pitching tail. Four color meshes move together through a restrained hover. The
native runner checks joint offsets relative to the body in physical meters, in
addition to saved keys, actual positions, part bounds and final quaternions.
The animal guide documents this technique and a downward oblique review camera.

`out/rsi/011c/report.json` passes six frames for all four actors and three joints:
body 0.15625 × 0.28125 × 0.3125 m; each wing 0.140625 × 0.015625 × 0.140625 m;
tail 0.0625 × 0.03125 × 0.09375 m. Measured rotations include mirrored wings,
tail pitching, interpolated transition and matching loop endpoints. Player/main
camera remain stationary. Creation took 6498 ms, ten status calls; six native
queries cover 24 part checks. Skill validation, three guide tests and build pass.

Inspected 0.25/0.75 s frames: raised/spread wings and a distinct tail remain
attached; the final camera fills the background with ground and removes nearby
test fixtures from the review frame. Retry 011 detected intentional beak/head
overlap and now replaces only that join. 011b verified motion but showed clutter;
011c changes the review camera. These are one round, not separate rounds. Four
rigid files plus an editable movie, not a single skinned animation-ID export.

Next: execute packaged templates without copying their full source into a chat,
then improve native BoneBlock character/export support at realistic meter scale.

## Round 012 — run packaged art without copying Lua

Added lazy `template_info` and `run_template` actions inside the existing single
MCP tool. Metadata describes one template only; a source hash pins the reviewed
version. Trusted packaged source compiles to native `run_code` with a deterministic
scene/asset name scoped by world, chat, request and template. Origin remains
optional; source saving is opt-in, world saving explicit. No new engine action,
MCP tool, resource or prompt. Supported initial designs: fan, butterfly and bird.

Eight automated checks pass: deterministic retries and distinct request/chat/world
names, bad versions/names/coordinates rejected before dispatch, ownership fields,
native job recovery, existing image handling and one lazy skill entry. Type check,
skill validation and extension build pass. `out/rsi/012/mcp-report.json` proves a
fresh standard stdio MCP client uses the singleton HTTP hub to create the bird
without supplied coordinates, recovers the same native job on a duplicate request
and receives native MCP image blocks without bytes in metadata. A direct native
six-pose audit passes all four parts and joint offsets. `persistence.json` confirms
saved generator/manifest, five groups and four unique assets after explicit
`saveSource:true`. Visually inspected the spread-wing MCP frame.

The already connected Codex MCP process still has the older action implementation
(`help run_template` returns unsupported); the newly built stdio connection above
works. Reconnection is required for that existing process to recognize the new
action. No daemon was killed/restarted and no release deployed.

## Round 013 — named color regions for low-token art variants

Added template-specific uniform RGB palettes to fan, butterfly and bird metadata.
`run_template` accepts partial role overrides and rejects unknown roles/invalid
colors before dispatch. Simultaneous replacement prevents swapped default colors
from cascading into each other; case/key order produce the same native source.
Animal/moving-object guides explain coherent contrast and the distinction between
new variants and revisions of existing named groups.

`out/rsi/013` uses six blue/cream overrides through standard stdio MCP without
copying the 4260-byte bird source. Duplicate request recovery and native image
content pass. A six-pose native audit checks all four part dimensions, final
rotations, joint offsets and stationary player/camera. Inspected the blue/cream
spread-wing frame against round 012's warm gray bird: silhouette/motion remain
intact and regions visibly change. Nine automated checks, TypeScript, skill
validation and extension build pass. Same single MCP tool and lazy root skill.

Next: parameterized scene vegetation and reusable primitives, then native
BoneBlock character rigs and embedded clips with independent meter-scale reload.

## Round 014 — native conifer silhouette and sparse understory

Added a 7 m conifer with a half-meter color trunk, stepped/tapered native spruce
leaf rings (ID 91), ferns, grass and mushrooms. Its stone path uses surface edits
at ground level. Lazy template metadata reports zero assets; run_template's name
schema no longer grows an eager enum as the catalog expands. Vegetation guidance
routes to species by silhouette instead of merely changing leaf color.

out/rsi/014/report.json verifies current groups have no stale members and player,
facing and main camera remain unchanged. Inspected overview/detail again after
the temporary site overlay expired: narrow trunk and layered conical foliage are
readable, with sparse ground plants and a flush road. No model export claimed.

## Round 015 — branching native cherry and static-template MCP feedback

Added a 6 m cherry with miniature forked branches, an asymmetric crown of native
Cherry_Blossoms (92), sparse roses/grass and small fallen petals. Crown expansion
skips occupied wood carriers so foliage cannot erase editable branches. The
MCP acceptance runner now captures overview/detail for static templates instead
of assuming every packaged design has animation times.

out/rsi/015/report.json and 015mcp/mcp-report.json show stale-free groups, 16
flush path cells, duplicate request recovery and native MCP image blocks from a
fresh stdio client through the existing singleton HTTP hub. A later capture-only
pass in 015mcp removes the expired site overlay; inspected the pink crown, forked
trunk and ground cover. Neighboring test fixtures remain visible in the wider
frame; this is not a clean portfolio composition. Player/main camera unchanged.
Nine automated tests and TypeScript checks pass for the maintained infrastructure.

Next: realistic-scale native character rigs and embedded animation clips, with
independent reload and concrete pose checks rather than preview-only scaling.

## Round 016 — persisted exact rig membership by named groups

Added scene:bindBone with native explicit membership, parent validation and undo.
The model supplies component names rather than copying every carrier coordinate.
It checks owned/current geometry, rejects geometry groups containing controls,
protects external bone owners, and updates fingerprints of transferred owners.
Active group is restored even after failed checks. rig now reports authoritative
binding metadata, including missing members/parents. Capabilities and on-demand
rig guidance expose the helper without adding another MCP tool.

CreationBindingRegression.Run(scene) passed nine native checks in the disposable
world: exact body/arm membership, explicit resolved parenting, inspection, XML
persistence, rejection of control geometry, unowned parents and cycles, transfer
fingerprints, and native undo/redo. out/rsi/016/report.json has no stale groups and
stationary player/main camera. Inspected the 1.75 m blue miniature-column fixture
with a separate arm and editable BoneBlocks. This is a binding fixture, not a
finished human character or animated miniature export. Three guide checks, skill
validation and extension build pass. Initial integration retries fixed cross-group
validation and the harness's out-of-bounds camera/name contract; all are one round.

Remaining limitation: direct BMax rendering uses automatic ownership; exact
membership requires binding-aware ParaX output. exportVoxelX still exports one
rigid root, not an articulated miniature character. Next work must close that
specific export gap and verify actual embedded clips at realistic size.

## Round 017 — articulated miniature ParaX at realistic scale

exportVoxelX now accepts multiple color-geometry groups plus an explicit native
rig group. It expands persisted carrier membership onto the same fine grid as
geometry, delegates hierarchy/weights to the binding-aware installed exporter,
preserves physical pivots and names, and rejects missing/conflicting/unbound
members or external parents. Bone controls are omitted from visible mesh/extents
on this export instance. Preflight includes reserved bone cells, native horizontal
index spans and binding limits. Static single-root export remains supported.

Added a lazily loaded characters guide and mini_character template: a 1.75 m
color-voxel person with hair, face, clothing, shoes, separate legs, shoulder joins
and a right-arm wave. Seven RGB roles support compact requests. One exported .x
has two real bones and reloads at scale 1; the editable MovieBlock drives its wave.
Older libraries fail with unsupported_capability before any construction writes.
This is not yet an independently looping embedded idle/wave clip-ID asset.

Nineteen native export regression checks pass, including negative carrier offsets,
metadata cloning, missing parents, cycles, ownership conflicts and expansion/index
limits. Nine MCP/template/guide tests, skill validation, TypeScript and build pass.
out/rsi/017b, 017c and 017final verify five actual right-arm poses, unchanged player/
main camera and a reloaded 1.125 x 1.75 x 0.4375 m asset at scale 1. 017mcp and
017final prove fresh standard stdio clients build through the existing HTTP hub,
recover duplicate requests and return native MCP images without copying Lua.
The final variant uses blue clothing. Actual template preflight is verified for
supported and absent-helper environments in 017final/capability-preflight.json.

Inspected rest and raised-arm captures: right arm visibly moves while the face,
body and other arm remain fixed. Initial 017 exposed tiny rendered control cubes
and inflated bounds; fixed by excluding control tessellation. Shoulder gaps were
closed in 017c. Independent world views near the loaded terrain edge still show
blue void/clipped ground and occasional neighboring fixtures; portfolio framing
needs improvement. All retries/variants count as one round. Source and bindings
are retained; no world save/reopen or embedded clip completion claimed.

Next: embed native idle/wave clip IDs into the miniature .x, independently reload
and evaluate both clips; improve isolated asset feedback without moving the player.

## Round 018 — independently playable miniature idle/wave clips

Added exportVoxelX animation options for an owned source MovieBlock/actor, unique
clip IDs, loop flags and matching bone channels. Each clip has interpolated
boundaries and preserves interior keys; disabled ranges and animated actor
transforms/assets fail explicitly. Input checks reject malformed keys and zero
quaternions before asset writes. Capabilities expose voxelClipExport lazily.
The miniature human template now exports a rest rig and an embedded idle/wave
asset, then reloads that file in an independent actor with ID keys only.

Native acceptance uncovered and fixed two real issues: resume reserialized an
already canonical fingerprint, creating false stale bone pivots; exact capture
seeks retained a previous clip through native blending. Persisted fingerprints
are now retained verbatim, and exact seeks reset blending without changing
ordinary playback. Failed partial authoring-movie edits were backed up and
restored from our own original snapshots before the fixed revision; no manually
edited content or project 530 was replaced. The fixed origin stayed unchanged.

out/rsi/018c/report.json verifies seven actual poses (idle, boundary, wave and
recovery), zero external bone keys on the independent actor, scale-1 dimensions
of 1.125 x 1.75 x 0.4375 m, and stationary player/main camera. Eighteen native
clip checks passed for interpolation, intervals, source preservation and invalid
inputs. Nine MCP/template tests, TypeScript, skill validation and extension build
passed. 018mcp/mcp-report.json proves a fresh standard stdio client recovered the
existing native job through the singleton HTTP hub and returned seven native MCP
images. This recovery test did not submit a duplicate mutation or a new scout.

Inspected the independent raised-arm image: arm moves while face/body remain
fixed, but neighboring source characters and MovieBlock controls clutter the
background. Native FFI asset metadata was unavailable, so no separate metadata
enumeration claim is made; actual independent animation poses provide evidence.
A fresh scouting attempt reached its cooperative deadline near loaded terrain's
edge without writes; revision reused a valid saved site. All attempts count as
one round. No world save/reopen acceptance claimed.

Next: improve isolated character/model feedback and loaded-terrain site selection;
expand moving objects and animals with independently verified clips.

## Round 019 — character views and nonmutating pose audits

The miniature-character template now returns fixed full-body portrait and opposite
side cameras in addition to context views. Native and MCP acceptance use portrait
for all clip times, leaving room for the raised arm. Native captures record actual
camera metadata. A read-only review mode can reopen the saved scene without
replacing its generator with the review script, shortening camera iterations.

Repeated review exposed a concrete audit side effect: opening bone editor
variables on an independently animated actor created an empty bone-range time
series and made its MovieBlock stale. The audit now reads native final bone
attributes directly and counts existing time-series keys without creating editor
variables. Only the audit's empty records were removed; an exact native snapshot
check confirmed restoration of the original movie XML. Native capture tests now
compare all member snapshots plus manifest/source hashes before and after views.

out/rsi/019/report.json verifies four fixed viewpoints and seven clip frames,
actual poses, scale 1, zero stale members and identical saved/native summaries
before/after repeated capture. Player/main camera and the established scene origin
remain fixed. No source save or new asset export occurred in the review job.
019mcp/mcp-report.json verifies fresh portrait images through standard stdio and
the singleton HTTP hub. Nine maintained MCP/template tests, skill validation,
script syntax checks and extension build passed.

Inspected portrait, opposite side and peak wave: the whole character is larger,
face and moving arm are readable, but some distant fixtures and controls remain
in frame. Two camera variants did not remove all clutter; these are world views,
not clean isolated asset renders. Both variants and the audit fix count as one
round. Next: a dedicated model-only render for independent clip feedback, retaining
context screenshots to verify placement and scale.

## Round 020 — isolated exported-asset PNG feedback

Added `asset` options to the existing camera_capture action; no new MCP tool or
eager skill resource. It loads one world-local .x/.bmax at scale 1 in a separate
Canvas3D mini-scene, samples a selected clip at its local time, and returns a
neutral-background PNG with meter bounds and final native bone rotations.
World-session checks, bounded readiness waits, path/input validation, busy
responses and success/error cleanup protect existing work. The MCP wrapper
checks isolatedAssetCapture capability before forwarding to older engines.
Guides explain local clip time, optional framing and why context views remain
necessary. Wiki/index/API docs and packaged skill resources are updated.

Twenty native checks passed for validation, missing files, wrong world identity
and busy handling. Eleven MCP/guide/template/dashboard tests, TypeScript, skill
validation and extension build passed. out/rsi/020mcp/report.json verifies both
embedded clip IDs at seven pose times, two extra angles and repeated wave frames,
1.75 m height at scale 1, eleven cleaned controls and identical native members,
manifest/source, player and main camera before/after. The standard stdio client
uses the existing singleton HTTP hub and returns native image blocks. Sampling
took about 4.3 seconds. image-check.json verifies decoded nonempty opaque PNGs,
at least 41 px margins and identical pixels across three fixed-wave samples.

Inspected isolated rest, wave and three-quarter views: face, clothing, separated
legs and arm motion are readable with no other actors, terrain or movie controls.
The stylized person remains a basic two-bone character, not a complete walking
humanoid. Static BMax capture also succeeds (020/bmax.json and prop.png), reporting
the legacy prop's actual 2.88 m bounds; it does not fix old asset auto-scaling.
Native SaveToFile can return nil on success, so output is checked from actual
file bytes. Camera yaw must follow each model's axes; an initial side view led
to the verified miniature-person default yaw 0. All retries count as one round.
Arbitrary models' attachment/texture readiness and unknown clip availability are
not proven; this acceptance covers generated color assets and known exported IDs.

Next: expand moving-object templates (small cars, wheels and steering), apply
isolated clip feedback to animals, and address loaded-terrain scouting latency
and legacy BMax scale where those behaviors affect the next native build.

## 021 — Meter-scale rolling hatchback and faster miniature planning

Added the lazy compact_car template and moving-objects guidance: 3.75 m length,
1.875 m mirror span, 1.5 m assembled height, ten uniform RGB palette roles,
separate editable source/body/wheel/movie groups, two uniquely named ParaX files,
and four scale-1 wheel actors reusing one tire. Quarter-turn quaternion keys
rotate negative X while the body moves negative Z. A contrasting asymmetric rim
marker makes intermediate rotation readable. The authored straight movie is not
steering/collision physics or a standalone embedded driving clip.

Scene miniature planning now checks/snapshots once per distinct carrier and
encodes only the completed octree, with write-time conflict revalidation intact.
Native CreationPlanningRegression passes six cases, including a 4096-voxel shape
with only three carrier checks, exact unit volume/color after native decode,
and preservation of a concurrent edit. Scouting tries four sides deterministically
and rejects blocked/unknown route endpoints before expensive path search.

Evidence: out/rsi/021c/report.json and planning-regression.json, independently
loaded body.png/wheel.png with scale-1 bounds, and out/rsi/021mcp/mcp-report.json
plus report.json. Fresh SDK stdio uses the existing singleton hub: one gateway,
no coordinates, a changed blue body palette, recovered identical request ID,
completed native job creation-51, and six native MCP image responses. Numeric
pose audits verify all five actors at six times, native wheel bone rotations,
four joint offsets and 1.963491 m travel for a 0.3125 m radius revolution.
Generator/manifest/member hashes and main player/camera remain unchanged by
feedback. Eleven automated checks, TypeScript, skill validation and the product
build pass. Root skill still dynamically loads only the requested guide/template.

Inspected fresh intermediate frames and neutral body/wheel captures. The blue
MCP car has visible grass beneath it and readable windows, roof, lamps, mirrors
and turning rims. The earlier red car's site screenshots show missing rendered
ground, so those frames alone do not prove floor contact. Silhouette remains
basic and boxy; wheel arches and body contour refinement are next art work.

Two failed attempts count within this round: creation-48 reached its deadline
after earlier shapes wrote 15 owned carriers; fingerprints were checked, originals
backed up in creation/failed_creation-48_backup.lua and restored through native
undo. creation-49 timed out scouting without writes. The carrier optimization
and four-side route fix preceded successful jobs 50/51. No client/daemon restart,
project 530 edits or world save occurred. Same-path reopen and full release
acceptance remain unverified; this is round 21, not completion of the goal.

## 022 — Open wheel arches and shaped car panels

Refined compact_car in place: narrow internal chassis, actual curved negative
space at four wheel arches, inset nose/tail panels and narrower bumpers, door
seams/handles and a dark grille. Consecutive side-panel voxel runs become boxes,
keeping geometry editable without issuing a helper call for every tiny cube.
Added guide instructions for wheel swept-volume clearance, economical panel
runs and explicit car routing from the root; no new eager tool/catalog.

Native job creation-52 auto-scouted and built in 21.6 seconds. Evidence is
out/rsi/022/report.json, body.png and clearance.json. The clearance runner reads
fresh native miniature carriers, measures the actual tire voxel corners and
compares the full rotational envelope against every body leaf overlapping each
wheel axle. It covers 480 comparisons at four axles: the nominal 0.3125 m tire
sweeps a 0.35356 m radius and retains a minimum 0.02145 m body gap. The same audit
rejects round 21's solid side panels for actual tire/body overlap, demonstrating
that the check detects the corrected defect rather than only accepting the new
metadata. No world data is written by this audit.

Fresh standard MCP stdio job creation-53 verifies the packaged updated hash,
a gold body/gray-green roof palette, automatic placement, duplicate request
recovery and six native MCP animation images. out/rsi/022mcp/report.json and
clearance.json repeat all five actual actor scales, native wheel rotations,
attachment offsets, circumference-matched travel and geometric clearance.
Source/manifest/native member hashes and main player/camera are unchanged by
feedback. Six guide/template tests, skill validation, diff check and the
extension build pass; no daemon restart or world save.

Inspected assembled rest/intermediate frames and independent body views. Wheel
openings and narrower ends now read clearly; door details remain intentionally
sparse. Both the red native car and gold MCP car have supporting grass visible.
Neighboring source geometry, characters, movie controls and a temporary overlay
can enter world feedback views; clean assembled-object framing remains work.
This is a stylized hatchback, not a detailed interior or steering system. Next:
add explicit steering poses/turning logic and improve assembled object framing,
then extend the moving-object repertoire to boats/aircraft and animal gait rigs.

## 023 — Parked steering with continuous clearance bounds

Extended compact_car to a two-second authored sequence: straight wheel-matched
travel through 1 s, stop, front-wheel yaw +20 degrees at 1.25 s, zero at 1.5 s,
-20 degrees at 1.75 s, and return to zero at 2 s. Body and all attachments hold
the stopped position; rear wheels remain straight. Root Y quaternions and radians
are explained in the lazy moving-objects guide. This parallel front-wheel pose
is explicitly parked steering, not Ackermann or physical curved driving.

Expanded wheel arches from a 0.375 m to a 0.4375 m construction radius. Refactored
the native read-only geometry audit into a maintained Lua fixture called only
through run_npl_code. A conservative axial/radial cylinder contains every tire
spin and every yaw in the continuous +/-20 degree range, so clearance is not
only checked at discrete pictures. Native source-carrier analysis performs 1684
body comparisons at four axles and measures at least 0.05188 m body gap for the
actual 0.35356 m corner-swept tire radius. It also checks original fingerprints.

Evidence: out/rsi/023/report.json and clearance.json (job creation-54, build
18.8 seconds), and out/rsi/023mcp/mcp-report.json, report.json and clearance.json
(fresh packaged template job creation-55, green body). The standard MCP client
uses the singleton hub and only one gateway, obtains a changed template hash,
recovers a duplicate request without rebuilding, and receives ten native images.
All ten native pose audits verify five scale-1 assets, four attachment offsets,
key counts, final bone quaternions, circumference-matched travel, stopped body
positions, both front-wheel steering directions and return to straight. Native
member/source/manifest hashes and main player/camera stay unchanged by feedback.
Six guide/template tests, skill validation, diff checks and product build pass.

Inspected both steering extrema: the front tire's plane changes visibly while
the rear stays straight. The green MCP build has visible supporting grass.
The red native build still shows terrain render coverage missing beside the
car; that camera defect is not treated as a successful floor-contact picture.
World views also include neighboring fixtures, so next work is clean assembled
moving-object captures through the same CLI, followed by true curved car motion
and boat/aircraft/animal expansion. No project 530 change, world save, daemon
restart, commit, push or release. The full 100-round goal remains active.

## 024 — Clean multi-actor MovieBlock feedback on an independent canvas

Added desktop AssemblyCapture behind the existing camera_capture action's lazy
assembly option and isolatedAssemblyCapture capability. It seeks/waits for the
MovieBlock, freezes native actor transforms and bone values once, clones selected
world-local models into an offscreen scene and returns one neutral opaque PNG.
No additional MCP tool/root resource. Optional named actors select 1–16 parts;
metadata is bounded to 256 total bones and 128-byte bone names. World/session
checks, pending busy, bounded waits, invalid/missing assets and cleanup paths
return explicit errors. Old engines are rejected by MCP capability preflight
before any seek. The shared existing singleton hub and image-content path remain.

Read native source bone attributes without opening editor variables. Each clone
receives frozen dynamic rotation/translation/scale tracks, and its actual native
final transforms are checked against the snapshot before rendering. Metadata
reports those clone poses, relative meter positions and the original engine-space
anchor. Independent assembly framing follows that anchor across seeks; absolute
travel is available through originWorld rather than screen displacement. The
user's player, main camera, selection and world architecture are not captured.

Evidence: out/rsi/024/regression.json passes 18 native validation/busy/session
cases. out/rsi/024mcp/report.json uses a fresh standard stdio MCP client and existing
car job 55, verifies all five actor attachments/scales and clone rotations against
independently audited native poses, rejects a missing selected actor, takes eight
PNGs in about 4.2 seconds, and proves eight canvas UI/control resources removed.
All native members, movie timeline serialization, manifest and generator hashes
match before/after; player/main camera remain unchanged. image-check.json proves
all PNGs nonempty, opaque, unclipped (minimum margin 13 px) and pixel-identical
across three fixed-pose samples. Inspected roll and steering extrema: body and
four wheels are readable together, with no terrain/neighbor/model-control clutter.

Twelve guide/template/MCP/dashboard checks, TypeScript, skill validation, diff
checks and product build pass. Updated lazy art guides, Keepwork documentation,
engine bundled wiki and code/topic indexes; compiled script packaging and wiki
wildcards cover the existing area. Native code checks use run_npl_code/tail_log,
not the browser console. SDK tests initially tried the non-exposed run_npl_code
MCP action and a scene-query identity field; corrected the acceptance harness to
use fenced native CLI audits and preserve the existing scene-query schema.
Those harness retries count only within this round.

Acceptance covers generated color-model assemblies. Arbitrary attachments and
large deforming rigs need separate pose/readiness/framing checks; conservative
default bounds are not exact posed mesh bounds. Current explicit car framing has
more lower empty space than ideal. Isolated views do not prove ground contact.
Next: improve automatic assembly framing and curved vehicle motion, then broaden
boat/aircraft/animal templates. No new world construction or world save, project
530 edits, daemon restart, commit, push or release. Goal remains active at 24/100.

## 025 — Automatic centered framing for rigid assemblies

Added reusable native Framing helpers and integrated them into AssemblyCapture.
Static/single-root rigid parts use transformed rest bounds with actor scale and
roll/pitch/yaw, bone pivot, rotation, scale and translation. An external root
rotation track with multiple keys uses a full rotation envelope, preventing
camera pumping as tires spin or steer. The union is centered and its bounding
sphere fits the square 30-degree perspective camera with 8% padding. An explicit
meter distance remains available. Camera metadata gives center/default distance;
per-actor framingKind distinguishes rigid_pose, rotation_envelope and the labeled
multi-bone rest_sphere fallback. No new tool, root resource or mandatory input.

Native CreationFramingRegression passes six geometric cases: negative-position
scaled actor yaw, off-center root rotation/translation, rotation-independent
sweep bounds, union centering, perspective corner containment and non-rigid
fallback labeling. Evidence: out/rsi/025/regression.json. The standard MCP runner
now supports --auto-fit and verifies unchanged camera metadata at eight spin,
steering and repeated times, along with the existing actual clone pose/scale,
attachment, source hashes, player/main camera and eight resource cleanup checks.

out/rsi/025mcp/report.json/image-check.json/framing-check.json prove eight fresh
opaque PNGs, repeated fixed pixels, useful car width (55–90% of the frame), at
least 72 px margins and reduced worst vertical-center error from 13.48% of frame
height in round 24 to 2.05%. Inspected the new centered car image. Sampling takes
about 4.2 seconds, without model rebuilding or a manually supplied distance.
Updated only the relevant lazy art guides and authoritative engine camera wiki.
Six guide/template checks, skill validation, product build and diff checks pass.

The sphere fit deliberately leaves padding; it is a geometric framing metric,
not an invented art-likeness score. Single-root rotational sweeps are verified;
multi-bone rest-sphere fallback is not exact deformed-mesh measurement and may
need manual review at extreme poses. Translating/scaling internal parts can alter
the union. No world construction/save, project 530 edits, daemon restart, commit,
push or deployment. Next: broaden boats/aircraft and animal motion while reusing
clean assembly feedback; true curved car motion and full reopen acceptance remain.
Goal is active at 25/100.

## 026 — Open rowing boat with water stroke and reusable oars

Added the lazy boats guide and rowing_boat template: a scale-1, 3.5 m long,
1.5 m wide, 0.625 m deep open hull with tapered ends, a light rim, two fitted
seats and restrained trim. Aligned 1/16 m color voxels form the exported geometry;
equal-width rows are compressed into boxes. Two exported files supply three
actors: hull and two instances of one oar, with local oarlock pivots. Nine keys
combine mirrored yaw and local dipping/lifting, plus a small hull bob. Eight RGB
palette roles allow deterministic reuse through the existing single MCP gateway.

Actual Still_Water fills a contained preview basin; native stone bed/banks and a
flush wooden dock use bounded ground helpers. The basin includes the entire oar
stroke. Two failed construction attempts (jobs 56/57) revealed seat/wall overlaps;
each restored ten previously completed owned carriers only after fingerprint
checks and world-local backups. Job 58 then built successfully, but its world
images exposed blades touching the smaller basin banks. Final job 59 widened
the water footprint and aligned hull rows; retries count within this one round.

Evidence: out/rsi/026mcp/mcp-report.json and report.json verify the final packaged
template through fresh standard stdio MCP, duplicate-request recovery, nine native
poses, actual scale/bounds, editable members and unchanged source/manifest/player/
main camera. boat-check.json independently verifies both blade tips enter water
at 0.5 s (y=-0.131 m), lift at 1.5 s (y=0.878 m), and return to matching initial
poses at 2 s. Native pond inspection confirms 25 water cells, 49 bed cells, 24
bank cells and 98 retained original-ground backups. Ground restoration under the
active boat has not been tested; stored backups alone do not prove that operation.

Generalized the assembly acceptance runner from car-specific names/counts to
template actor metadata. out/rsi/026assembly/report.json and image-check.json
verify eight fresh opaque PNGs in about 4.3 seconds, native clone poses, repeated
fixed-pose pixels, missing-actor rejection and cleanup of eight capture resources.
Inspected the final water-stroke world image and clean assembly recovery image:
cockpit, seats, trim and both oars are readable. The stroke is illustrative;
there is no rower, propulsion, buoyancy or collision solver. Automatic full-oar
rotation envelopes leave loose framing, so the guide supplies a manual starting
distance. Six guide/template checks and skill validation pass; compilation checks
cover automatic origin, deterministic palette overrides and explicit source save.

Full world reopen, curved car travel, aircraft and richer animal motion remain.
No project 530 edits or release deployment. Goal remains active at 26/100.

## 027 — Meter-scale high-wing aircraft and longitudinal rotor

Added light_aircraft and its on-demand aircraft guide. The parked single-seat
design has a roughly 6.2 m fuselage, 8 m tapered high wing, glazed cabin, slim
struts, horizontal stabilizer, vertical fin and three landing wheels. Exportable
geometry uses 1/16 m color voxels, compressed cross-sections and scale-1 actors.
Three assets supply five actors: airframe, Z-axis rotor and three reused wheels.
Quarter-turn quaternion keys make two complete rotor turns in two seconds;
static parts keep fixed offsets. Eight RGB roles support fast palette variants
through template_info/run_template without placing source in model context.

First native construction (out/rsi/027) completed in about 18.3 seconds with nine
pose captures, scale/bounds/attachment checks and stationary player/main camera.
Its image revealed a missing visible shaft between hub and cowling. Added a
narrow shaft terminating at the rotor plane and adjusted declared exported
length to the actual 6.1875 m. Final out/rsi/027mcp uses fresh stdio MCP and the
existing singleton hub, blue accent override, automatic site and duplicate request
recovery. report.json independently verifies nine native poses, actual dimensions
at scale 1, all editable member fingerprints and unchanged manifest/source hashes.
Inspected the final 0.125 s world image and clean quarter-turn assembly image.

The new read-only native clearance audit decodes actual source miniature voxels.
out/rsi/027mcp/clearance.json proves a 0.93958 m corner sweep radius, 0.1875 m
minimum broad-cowling gap and 0.31042 m ground clearance, with 3,945 geometry
comparisons. Twelve central shaft cells touch the hub without crossing the rotor
plane; the intentional attachment is distinguished from rotating blade clearance.

Assembly acceptance now chooses rigid_pose versus rotation_envelope from each
part's actual key metadata, allowing static landing wheels alongside a moving
rotor. out/rsi/027assembly/report.json/image-check.json verify eight native MCP
PNGs in about 4.15 seconds: all five parts, actual clone bone rotations, fixed
attachments, repeated pixels, nonempty/unclipped opaque output, missing-actor
rejection and cleanup of eight capture resources. Source, player and camera stay
unchanged. Six guide/template checks, TypeScript, skill validation and product
build pass. Root and guides remain lazy; no new advertised MCP tool or resource.

This is parked propeller acceptance, not flight/taxi physics or embedded flight
clips. World images include neighboring fixtures; clean assembly captures isolate
the result. Full world reopen, curved car motion and richer animal locomotion
remain, along with aircraft motion. No project 530 edits, world save, daemon
restart, commit, push or deployment. Goal remains active at 27/100.

## 028 — Banked airborne assembly with rotated attachment frames

Added banking_aircraft as a validated variant of the same aircraft source,
avoiding a duplicate geometry file. Its transformed source has its own content
hash and reserves 24 x 8 x 14 m for source geometry and elevated preview. It
authors a two-second short elevated path, ±0.25 rad yaw and ±20° bank. All five
parts carry body orientation; propeller orientation composes body * local rotor.
Each attachment offset rotates with the body before adding its position. Dense
129-key tracks limit linear-position versus quaternion-slerp attachment drift;
poses and metadata use the same integer milliseconds as native persistence.

The native acceptance runner now checks rotated joints against actual parent
FinalRot, retaining fixed-offset checks for parked vehicles and a maximum allowed
1 mm tolerance. out/rsi/028final/report.json verifies nine actual native poses,
including 0.2578125 s between keys, actor scales, native quaternion keys, source
fingerprints and unchanged player/main camera. attachments.json independently
samples persisted native position tracks and quaternion slerp at 1,001 times:
maximum attachment error 0.00017 m, propeller axis vector error 0.00016, bank/yaw
and matching loop endpoints. This track audit is distinguished from actual native
pose checks. An initial audit used Lua's discrete bone-table lookup instead of
native quaternion interpolation and reported a false 0.0584 m lag; corrected it
after inspecting BonesVariable's AnimatedQuaternion loading and AnimBlock APIs.

First job 62 finished despite a hub 'client gone' response; recovered its original
job through native CLI, without repeating creation. Final job 63 passes fresh
stdio MCP, same-request deduplication and captures. The acceptance client now
retries only bounded read/status/capture calls on transient client-gone errors;
it never submits a second creation to recover a poll. Dense per-key native edits
remain relatively expensive; batching and smaller returned audit metadata are
follow-up optimization work rather than claimed fixes in this round.

out/rsi/028assembly passes eight automatic captures with stable framing, actual
clone poses, source hashes and cleanup. One initial assembly run detected a
player-facing change; a second run passed the unchanged-player/camera checks.
Its cause is not established, and the failed run is not counted as a pass.
Automatic full-rotation body bounds make this craft too small for useful detail.
A 14 m manual view clipped a wing, so the guide/runner now use an inspected 18 m
starting distance. out/rsi/028close18/report.json/image-check.json pass eight
fresh unclipped opaque images with stable repeated pixels and unchanged source/
player/camera. Inspected banked assembly views and retained the failed-view evidence.

Six guide/template checks, TypeScript and skill validation pass. Product build
packages the shared variant and lazy aircraft guidance. This is authored airborne
motion, not aerodynamic flight simulation, exact continuous parent constraints or
standalone embedded flight clips. Full reopen and remaining category work stay
open. No project 530 edit, world save, daemon restart, commit, push or deployment.
Goal remains active at 28/100.

## 029 — Batched native movie keys with exact live rollback

Added scene:keyframes(movie,actor,frames), automatically available through the
normal scene API in real/virtual CodeBlocks. It validates 1–512 ordered frames
and at most 4,096 scalar/bone-transform track keys before writing. Times must
increase after conversion to integer milliseconds. Planning yields and checks
world/cancellation; bounded native writes use one MovieBlock snapshot and undo
command per actor batch. Individual keyframe upserts remain supported, including
empty bones tables. Capabilities expose the helper and limits. The aircraft
generator now builds five batches, with a sequential fallback for older engines.

Native testing exposed two issues and fixed them within this round: resolving
GetBonesVariable/GetChild outside the snapshot seeds serialized tracks and makes
the target stale; native bone names are now validated by read-only attributes,
then track initialization occurs inside the snapshot. Failed write recovery can
recreate actors, so cached movie actors are reopened. Native XML/SCode roundtrips
also truncate dense quaternion decimals. World snapshots now weakly retain exact
in-memory MovieBlock item data for live rollback/undo, leaving fingerprints and
manifest formats unchanged. This does not extend saved-world numeric precision.

out/rsi/029final/regression.json proves 13 native checks: empty/oversized arrays,
duplicate rounded/decreasing/out-of-range times, later zero quaternion, missing
bone, unsupported field, nonfinite position, track-key limit, an injected partial
write failure with exact restoration, and one-step native undo/redo. Benchmark
uses the same MovieBlock and 129 actor frames, suppressing undo-stack pushes only
for timing (undo is checked separately), then exactly restores original contents.
Latest run measures 10,296 ms and 129 serialized edits sequentially versus 93 ms
and one serialized edit batched, about 111x for this fixture. Full generated
aircraft job 3 takes 16,578 ms including scouting/geometry/export, not a claimed
111x scene-wide speedup. Earlier measurement was 10,609/94 ms.

The prior client and hub were actually stopped when native testing resumed.
Started absent services through the repository CLI workflow, opened only the
disposable world and obtained a fresh client identity. Project 530 was loaded by
the standard launcher but never edited or saved. Local manage_world open exposed
an existing quote-handling failure; logs showed a literal quoted path, and the
authorized raw native OpenWorld path succeeded. That lifecycle bug remains for a
separate fix. Initial job 1 failed after earlier geometry/export work and retains
a partial fixture; job 2 built but a precision regression test changed its movie
fingerprint. Neither is counted as clean acceptance. Final job 3 is clean.

out/rsi/029final/report.json/attachments.json and out/rsi/029assembly verify nine
native poses, actual meter scale, 1,001 persisted-track interpolation samples,
unchanged source/manifest/member hashes, eight fresh unclipped opaque PNGs,
repeated fixed pixels, cleanup, and stationary player/main camera. Inspected the
banked assembly after rollback/benchmark. Eleven MCP/guide/template checks,
TypeScript, skill validation and product build pass; targeted guide/template
checks also pass after the batching assertions. Updated engine wiki, code/topic
indexes and lazy animation guidance. No new MCP tool or resource.

Next: reduce bulky returned audit data, fix local world opening and complete
save/reopen acceptance, then broader animal/scene animation work. No world save,
commit, push or deployment. Goal remains active at 29/100.

## Round 30 — compact MCP job replies with exact full recovery

Added a display-only job projection behind the existing single paracraft_cli
gateway. code_job defaults to summary, replacing known dense actor rotationKeys
audit arrays with counts and first/last times. Preserve job state, identity,
placement, actor dimensions, files, groups, errors, output and unknown fields.
resultDetails.full is a complete same-job recovery call retaining world identity
and chat ownership. resultDetail:full returns the complete native result; this
gateway option is removed before engine dispatch. Engine HTTP/poll data remains
unchanged. No new tool/resource and no scene mutation for display optimization.

Thirteen MCP/guide/template tests, TypeScript, skill validation and extension
build pass. Fresh standard SDK stdio against the singleton hub and the completed
native banking-aircraft job verifies 42,684 bytes full versus 4,717 bytes summary,
an 88.95% reduction. Five omitted arrays contain 645 audit keys; the returned
recovery call retrieves their exact native result. Native job contents match
before/after, and no creation mutation was submitted. Evidence:
out/rsi/030/report.json and scripts/paracraft-job-summary-native.cjs.

Existing running HTTP MCP daemon was not restarted and its schema refresh is not
claimed. The built code, in-memory MCP/poll tests and fresh stdio native acceptance
are verified. This display change uses round 29's visually reviewed aircraft;
no new visual-quality claim. Lazy connection guide and gateway module map updated.
The root and reference-analysis guide retain the user's temporary Minecraft
reference rule: borrow sparse construction techniques, keep external references
out of the skill, adapt verified native IDs/meter scale and fall back to BMax or
miniature voxels. Goal remains active at 30/100; local world-open quote handling
and save/reopen acceptance remain pending. No commit, push or deployment.

## Round 31 — native local world opening with spaces

Removed shell quotes around resolved local world paths in WorldManagement.lua.
Native /loadworld consumes the entire remaining command text; added quotes became
literal filename characters and caused opening to fail after open_requested.
Regression now checks unquoted spaced and Unicode paths and propagates native
open failures while retaining existing save and switch guards. Fengari regression
passes. Updated bundled world-management guidance, engine wiki/indexes and lazy
skill connection guidance without new MCP tools or eagerly loaded catalogs.

scripts/paracraft-world-open-native.cjs fences the exact disposable identity,
hotloads only WorldManagement, explicitly saves the acceptance world locally,
creates/opens CreationAcceptance RSI31 Space, waits for actual entered status,
then returns to the original world with fresh session 4 (original 2, fixture 3).
No raw OpenWorld workaround or forced save. out/rsi/031/report.json captures
status and tail_log; reopened.json holds the fresh identity for further tests.
Inspected native CLI reopened.jpg: existing pavilion and player visible after
reload. This is lifecycle evidence, not complete source/rig/timeline persistence
acceptance. Project 530 was neither edited nor saved. Guide checks, skill
validation, product build and engine diff check pass. No commit/push/deployment.
Goal remains active at 31/100. Next: fresh-session persistence and animation audit.

## Round 32 — roundtrip-safe animation persistence

Actual post-reopen audit found one stale MovieBlock among 50 members in the prior
aircraft fixture: native float serialization changed quaternion 0.02038 to
0.02037 after another roundtrip. Fixed ItemTimeSeries.SerializeServerData with
roundtrip-safe 17-significant-digit finite numbers in native SCode tables,
preserving sorted output, strings, empty-track pruning and source data. Applies
to native time-series items, not a second persisted timeline. No tolerance-based
stale bypass or legacy fingerprint refresh. Previously lost values are not
recovered; the old stale fixture was left untouched.

TimeSeriesPrecisionRegression verifies exact positive/negative/tiny/large floats,
escaped strings, 20 deterministic roundtrips, source-preserving empty pruning,
distinguishable edits and rejection of cycles/nonfinite values. Native parser
also passed 10 exact roundtrips. A fresh banking aircraft was created through
the standard single MCP gateway and its nine native poses audited before saving.
scripts/paracraft-persistence-native.cjs then performed two explicit local
save/switch/reopen cycles, sessions 4 → 6 → 8. All 50 member fingerprints, four
groups, five actors, fixed origin/dimensions, source/manifest hashes, exact actor
track hashes and three exported X asset hashes remained equal after both cycles.
Evidence: out/rsi/032/new and out/rsi/032/persistence/report.json.

Fresh stdio MCP isolated captures after reopening verify eight native poses,
all actor part transforms, stationary player/main camera and resource cleanup.
PNG checks pass for nonempty, opaque, unclipped and repeated stable images.
Inspected rest and banked aircraft PNGs; wings, wheels and rotating propeller
remain visible. No claim of aerodynamic simulation or completion of all
character/BMax persistence requirements. Engine wiki/indexes and lazy persistence
guide updated. Guide tests, skill validation, extension build, float regression
and diff checks pass. Project 530 unchanged; no commit/push/release. Goal active
at 32/100. Next: continue distinct animated animal/scene template improvements.

## Round 33 — meter-scale young fox with native tail idle

Added lazy idle_fox template and routed it through the existing animal guide.
Original color-only 1/64 m geometry has a rounded narrow torso, separated legs
and dark paws, pointed paired ears with warm interiors, tapered cream muzzle,
dark nose/eyes and bushy cream-tipped tail. Two scale-1 exported meshes keep
editable construction and a MovieBlock. Five-key ±25-degree native root-bone
tail yaw loops over two seconds; legs stay planted. Row-compressed voxel writes
and batched actor keys reduce repetitive calls. Four named RGB roles support
deterministic palette overrides through the existing one-tool gateway.

Fresh stdio native creation auto-scouted the disposable world and deduplicated
the request. out/rsi/033/report.json verifies nine actual tail quaternions,
body/tail joint offsets, non-stale groups and scale-1 bounds: body
0.171875 × 0.4375 × 0.46875 m; tail 0.109375 × 0.125 × 0.3125 m.
Neutral nose-to-tail span is approximately 0.75 m; documentation caption corrected
from the initial 0.77 estimate without changing geometry. Eight isolated assembly
MCP PNGs verify actual parts/poses, fixed source/player/camera, cleanup, opaque
unclipped pixels and repeated pose stability. Inspected the world image and
isolated tail extreme: ears/muzzle, separated paws and attached tail readable.

Six guide/template checks (including deterministic fox palette overrides),
TypeScript, skill validation, product build and diff checks pass. Native tail_log
read completed with ten lines. A null palette CLI argument was rejected before
mutation; corrected to an empty object within this same round, not another round.
No single skinned fox, walking gait or embedded clip claim. Source/manifest saving
was explicit in the test; no world save, project 530 edits, commit or deployment.
Goal remains active at 33/100. Next: quadruped joint/gait work and stronger animal
silhouettes alongside scene composition.

## Round 34 — baked meter normalization for small native rigs

Planning a multi-joint fox exposed the whole-carrier/integral-BoneBlock limit:
several tiny limbs cannot share one carrier and retain distinct explicit owners.
Added the necessary export infrastructure rather than claiming that the rigid
fox already has a skinned gait. exportVoxelX scale defaults to 1 and accepts
1/512..512, baking geometry, extents, joint pivots and embedded translations
uniformly. Source-local pivot and construction/Movies stay unchanged; quaternion
rotations, dimensionless bone scales and clip times are preserved. Result exposes
bakedScale while a loaded instance remains scale 1. Capabilities/limits advertise
the option so callers reject older engines before use. Isolated asset metadata
now includes native pivot/translation meters and parent indices.

CreationClipRegression passes 33 native checks including scaled root translations,
unchanged rotations/times/dimensionless scales/source, invalid factors and early
export rejection before world access/writes. A disposable two-bone character
fixture explicitly normalizes from 1.75 m to 0.4375 m, with embedded idle/wave IDs
and a 0.125 m authored root lift becoming 0.03125 m. Independent native captures
compare the original asset and normalized output at instance scale 1: dimensions
and pivots are exactly 1/4, both clip IDs retain arm rotations and measured root
displacement. Source/manifest/member hashes and player/main camera remain equal.
Ten fresh PNGs pass opaque/unclipped/nonempty/repeated-pixel checks and cleanup;
inspected the normalized peak wave. Evidence out/rsi/034final/report.json and
scripts/paracraft-normalization-native.cjs, with existing-job capture recovery.

Initial test authoring incorrectly converted helper meter translations a second
time and failed numeric acceptance; corrected that fixture input and recorded
the failed earlier fixture in out/rsi/034. A missing repeated-image sample was
added by recapturing the same completed final job, without repeating construction.
Only capabilities were hot-recompiled after exporter/capture hotloads; job
registries were preserved. Wiki/indexes and lazy rig/persistence guides document
technical construction versus delivered scale and prohibit preview-only fixes.
Guide checks, skill validation, build, diff checks and ten-line tail_log pass.
Default mini_character remains 1.75 m; the tiny figure is an explicit test fixture.
No new MCP tool, world save, project 530 edit, commit/push/deployment. Goal active
at 34/100; multi-joint fox geometry/bindings and gait remain next-round work.

## Round 35 — standalone six-bone fox and diagonal stepping loop

Added lazy skinned_fox with original fox geometry, six retained BoneBlocks and
explicit body/four-leg/tail whole-carrier ownership. Overlapping haunch voxels
are classified with their carrier once; row-compressed color writes avoid
conflicting component cells. The technical source is 32x delivered size (larger
than the initial 16x plan), with a 30x16x30 site, then geometry/pivots/translations
are baked by 1/32. Final rest bounds are 0.171875x0.4375x0.78125 meters, scale 1.
Two world-local files retain technical rig and standalone normalized clips.
ID 0 is tail idle, ID 1 is a two-second diagonal-pair trot in place. Four rigid
legs swing ±12 degrees with toe-clearance compensation and swing-foot lift;
tail sways ±20 degrees idle/±12 degrees stepping. Both IDs loop. Source and
verification MovieBlocks remain editable; no knees, forward travel or adaptive IK.

Initial source overlapped a rear-right control carrier. Original job 8 was
confirmed failed after a transport timeout; shifted the rear controls and added
blueprint preflight of all six control cells before geometry writes. Partial
failed fixture remains in the disposable world. Corrected job 9 completed; its
world-capture wrapper timed out, and status of that same job proved completion.
No new creation was submitted for observation recovery. Independent asset
acceptance in scripts/paracraft-quadruped-native.cjs loads the completed file
directly: seventeen native PNGs across both IDs, six native parents/pivots and
quaternions, all sampled toe-box corner clearances, visible swing lift and exact
loop closure. All 474 member fingerprints/source/manifest hashes remain unchanged,
as do player/main camera during isolated captures; all capture controls cleaned.
PNG checks prove unclipped/opaque/nonempty/repeated stable pixels. Inspected rest
and stepping peak: paws move while body/head/tail remain attached and readable.
Evidence out/rsi/035final/latest-job.json and out/rsi/035final/asset/report.json.

The capability guard now checks loaded export functions after createScene instead
of depending on the CLI Jobs registry, supporting lazy library initialization.
Four RGB roles and deterministic template hashing are covered by template tests.
Six guide/template tests, TypeScript, skill validation, packaging build and diff
checks pass; native tail_log returned ten lines. Animal guide distinguishes this
single skinned file from simpler idle_fox and states construction bounds/scale.
No new MCP surface, world save, project 530 edit, commit/push or deployment.
Goal remains active at 35/100; next improve quadruped posing/locomotion or another
distinct animal with native visual acceptance.

## Round 36 — expressive independently bound fox head

Added curious_fox as a lazy deterministic variant of the existing shared fox
source. An optional seventh BoneBlock owns whole head carriers: muzzle, eyes,
ears and upper neck, leaving the neck base/body and four feet in their existing
bindings. The planned head control is preflighted against geometry. Idle ID 0
looks ±25 degrees; stepping ID 1 keeps the head forward. All six existing motions,
source scale and baked meter bounds remain intact. Original skinned_fox defaults
to six bones; template hashes differ by variant, without duplicating the full
geometry guide/source or increasing advertised MCP tools/resources.

Creation-10 completed in 118,172 ms in the increasingly populated disposable
world. The wrapper hit a native transport timeout; read status of that exact job
showed it running, then completed. No repeated mutation or engine restart. An
early asset test against the running snapshot was rejected rather than counted
as acceptance; after completion the same saved job was used for all verification.
scripts/paracraft-quadruped-native.cjs now supports six/seven bones and checks
head native parent/pivot/quaternion, unchanged body/foot behavior and both idle
and stepping loop endpoints. Seventeen independent X-file PNGs pass native pose,
foot-corner clearance, cleanup, stationary player/main camera and source integrity
checks. All 475 member fingerprints/source/manifest hashes are unchanged.
Pixels are opaque, nonempty, unclipped and stable in repeated fixed captures.
Inspected both head-turn extremes: readable face/ears, attached neck, fixed body.
Evidence out/rsi/036/latest-job.json and out/rsi/036/asset/report.json.

Six template/guide tests, TypeScript, skill validation, packaging and diff checks
pass; native tail_log read completed. Lazy animal guide documents both variants,
proper hashes and neck-gap inspection. No forward locomotion/knee IK claim, world
save, project 530 edit, commit/push/deployment. Goal active at 36/100. The nearly
120-second build motivates profiling repeated source writes/bone work before
adding more large technical rigs; continue toward faster creation and richer art.

## Round 37 — fewer animal writes with exact geometry and measured bottleneck

The shared skinned/curious fox source now merges matching horizontal color rows
vertically, preserving the complete color/whole-carrier owner map. No new native
API, MCP surface or eagerly loaded guide. Native Lua planning comparison checked
all 2,603 voxels in both six/seven-bone variants: identical geometry, colors and
owners, no duplicates. Helper boxes decrease 577 -> 273 (52.7%); cumulative
carrier writes 1,520 -> 1,116 (26.6%). Lazy animal guidance explains compression
must not cross colors or skin owners. Evidence out/rsi/037/planning.json.

Initial creation-11 reached controls but failed the 120-second cooperative
deadline at 134.891 seconds; partial source remains and was not counted/repeated.
A profiling-only job creation-12 failed before geometry because ParaGlobal is not
a CodeBlock global. Corrected timing to commonlib.TimerManager.timeGetTime and
started independent creation-13 with explicit 600-second diagnostic deadline.
Read timeouts recovered that same live job, without restart/repeated submission.
Creation-13 completed at 128.25 seconds; instrumentation changes instance methods
only and records inclusive wall times. This does NOT demonstrate overall speedup.
Geometry boxes consumed 89,406 ms; world.EntitiesIntersect 3,868 calls/100,995 ms
(overlaps other helper timings); Snapshot 9,825 calls/344 ms, Restore 1,125/613 ms,
bindBone 7/13,594 ms, exportVoxelX 2/18,702 ms, keyframes 2/282 ms. Main next target
is repeated global entity-bound scans, with live obstruction checks preserved.
Evidence out/rsi/037/profile-final/latest-job.json; runners
scripts/paracraft-fox-planning-native.cjs and paracraft-fox-profile-native.cjs.

Seventeen independent embedded-animation PNGs pass seven-bone pivots/parents,
head turns, foot clearance, both loop endpoints, repeat pixel stability, opaque
nonempty unclipped imagery and source/player/main-camera preservation. Inspected
idle turn and trot extreme: readable eyes/muzzle/ears, connected neck, clear paws.
Evidence out/rsi/037/asset/report.json and image-check.json. Six template/guide
tests, TypeScript, skill validation, packaging and diff checks pass; native
 tail_log read completed. No world save, project 530 edit, commit/push/deployment.
Goal active at 37/100. Next optimize entity queries rather than extrapolating
helper-count reduction into an unsupported whole-job performance claim.

## Round 38 — live-input transformed-bound reuse without missing remote origins

World.EntityBounds now caches derived model extents per world adapter with weak
entity keys. Every call still reads loaded state, asset bounds, object position,
scale and ZXY angles; all thirteen numerical inputs must match to reuse extents.
Changed inputs recompute immediately; unloaded/empty assets use fresh native
fallback AABBs. Results are copied so callers cannot corrupt cached extents.
Cache misses use exact center/absolute-matrix-radius math, equivalent to eight
transformed corners including negative scales. Global current entity enumeration,
ignored pet/model handling and authoring reservation checks remain intact. Native
block-origin spatial queries were unsuitable because a large model can overlap
from outside those queried cells; no candidate/occupancy snapshot was introduced.

CreationBoundsRegression passed 86 synthetic checks, individually invalidating
all thirteen inputs plus 64 combined rotations/scales, changed geometry, loading
and fallback states, cache hits, weak keys and output mutation isolation.
Native benchmark compares the retained legacy eight-corner algorithm to the
optimized algorithm on every real entity; 3,093 bounds match within 1e-8.
Three alternating 64-query samples: baseline 2250/2219/2266 ms versus optimized
1281/1297/1296 ms (~42.5% reduction for this specific repeated-query fixture).
Earlier first benchmark used 2,616 entities and 73 checks; final report includes
the expanded regression and newly built source. No unverified general speed claim.
Evidence out/rsi/038/final-benchmark/bounds.json and
scripts/paracraft-bounds-native.cjs.

Creation-14 completed with the same instrumented curious_fox source and explicit
600-second diagnostic deadline. Actual job elapsed 117.219 seconds; previous
profile was 128.25 seconds, but different scouting/site/world population make
that an observation, not a controlled overall speed ratio. 273 boxes: 67,704 ms
(previous 89,406); 3,868 collision calls: 77,806 ms (previous 100,995); 9,825
snapshots 549 ms; 1,125 restores 578 ms; seven bindings 12,454 ms; two exports
19,500 ms. Inclusive timings overlap. Read timeouts recovered the same handle,
without repeated creation/restart. Evidence out/rsi/038/profile/latest-job.json.

Seventeen independent X-file frames pass head/leg poses, pivots/parents, actual
foot-corner clearance, both loop endpoints, repeated pixels, source integrity and
stationary player/main camera. Native PNG review confirms connected neck, readable
face and separated stepping paws; opaque/nonempty/unclipped checks pass.
Evidence out/rsi/038/asset/report.json and image-check.json. Six guide/template
tests, TypeScript, skill validation and diff checks pass; native tail_log read.
Wiki/CODEMAP/TOPIC-INDEX document live cache invalidation. No extra skill root/MCP
surface, world save, project 530 edit, commit/push/deployment. Goal active 38/100;
continue faster helper work and new art subjects with independent visual gates.

## Round 39 — native waterside garden with flush terrain and reusable bench

Added lazy pond_garden: a 12 × 11 m garden, irregular ~5 m pool, flush gravel
approach/stone banks, native reeds/grass/ferns/flowers and two lily pads. Bed,
water and bank share the pond group with original soil snapshots; aquatic plants
are separate for removal before restoration. Sparse deterministic planting leaves
open sightlines. A 1.5 m color-only bench has four legs, three separated seat
slats and three back rails. It exports once as a scale-1 X and is independently
instanced beside the pool. Surrounding native materials are excluded from export.
Two RGB roles and deterministic compilation are tested; one root/tool preserved.
Vegetation/material guides and Keepwork documentation route lazily to this design.

Native creation-15 auto-selected origin {19252,5,19146}, completed in 22.719 s.
Transport timeout recovered the same completed job, then MCP captured both views;
no repeated creation/restart. Review found absent-looking lily pads: BlockLilypad
uses the vine orientation, default data 0 vertical; data 2 is the horizontal
surface. Updated both pond and older native-material-garden examples plus the
plant guide. Creation-16 resumed the existing scene and replaced only two pads,
preserving origin/groups/backups and saving the corrected canonical generator.
Overview switched to a close overhead framing to reduce neighboring technical
fixture clutter. No new scene was built for this correction. The revision runner
initially rejected mismatched generated scene name before any submission because
existing-job recovery had rewritten the wrapper request timestamp; it now fixes
the authoritative existing scene name explicitly. Recovery-request provenance
is a follow-up improvement, not counted separately here.

scripts/paracraft-pond-native.cjs checks 128 current member fingerprints, 114
terrain backups, exactly two horizontal pads, 21 water cells and no water outside
the intended mask. Bench independently reloads at scale 1, exact meters
{1.5,0.9375,0.5}; three fixed PNGs are opaque/nonempty/unclipped and pixel-identical.
Two fresh native world views clearly show leaves on water, connected containment,
flush bank/path and restrained planting. Reviewed independent slatted bench too.
Source manifest and main player/camera remain unchanged during feedback; asset
capture cleanup is confirmed. Evidence out/rsi/039/latest-job.json and
out/rsi/039/review/report.json/image-check.json/revision.json; tail_log read.
Six guide/template tests, TypeScript, skill validation, packaging and diff checks
pass. No world save, project 530 edit, commit/push/deployment. Goal active 39/100;
continue new art subjects and faster reliable single-job recovery.

## Round 40 — request-only recovery without replaying templates

Existing code_job now accepts exactly one bounded jobId or original requestId.
Native lookup reuses the existing world-session/chat request registry; view adds
original requestId. Status/full/cancel continue through the same action. No source
is recompiled/submitted for lookup, and current packaged-template changes do not
matter. Capabilities advertise requestJobLookup; MCP explicitly rejects request
lookup on older engines. No new MCP tool/resource or expanded root skill. Lazy
connection guide and authoritative wiki explain lost-first-response recovery.

Fixed acceptance runner: existing-job recovery does not create/overwrite
request.json, retains original request/template metadata when available and labels
legacy provenance unknown. Current template metadata is separate; an unavailable
current template does not block native job reads. A saved request-only handle can
recover the returned job ID. New executions persist request and original template
metadata in their job handle before further observations. This fixes the concrete
provenance defect discovered during round 39's template correction.

Native validation selectively recompiles Control/view/Capabilities with retained
private registries rather than reloading Jobs.lua. All sixteen previous jobs
remain. Eight native assertions cover original lookup, chat/world/session isolation,
unknown request and invalid selectors. Existing creation-15 is recovered through
native HTTP and fresh stdio MCP with original request template-1791117726624.
One no-geometry wait job creation-17 is observed and cancelled by requestId;
status by its jobId confirms cancelled. No existing scene is rebuilt or reverted.
MCP/poll tests ensure request lookup dispatches only capabilities plus a read;
older-engine rejection sends no mutation. Selector schema rejects missing/both,
empty/oversized/nonstring values. Initial test omitted required clientId and failed;
corrected the fixture and reran: all fifteen creation/guide/template tests pass.
TypeScript, skill validation, build and diff checks pass; tail_log read completed.

Recovered pond screenshots are freshly captured through the same job; inspected
close view still shows horizontal lily pads, contained water, flush bank and slatted
bench. Request-only recovery leaves the original request file hash unchanged and
creates no new request artifact; original job ID is retained. Evidence
out/rsi/040/native-check.json, mcp-check.json, http-request-check.json,
request-recovered/mcp-report.json and original-request-sha.txt. Helpers do not claim
that absent legacy metadata can be reconstructed. Existing HTTP MCP daemon was
not restarted; fresh stdio and native HTTP run the verified implementation.
CODEMAP/TOPIC-INDEX and Keepwork docs updated. No world save, project 530 edit,
commit/push/deployment. Goal active 40/100; continue visual subject improvements
and low-token reliable authoring toward the complete 100-round scope.

## Round 041 — compact pergola, native floor collision and fence revisions

Added lazy garden_pergola template: 8 × 4 × 8 m construction bounds, 4.25 m
frame, native fence feet, quarter-meter posts, thin rafters, sparse climbers and
native ground plants. Oak-plank/stone-brick floors replace the soil; four upper
native slabs retain flush collision tops. Native color encoder now explicitly
uses the destination block format; public colors remain #RRGGBB. Original brown
feet visibly quantized to maroon; old/new encoders produce the same native value,
so this was not evidence of an encoder defect. Revised the frame to white to
match native fence colors.

Native neighbor updates changed fence selector 0 to 1, causing a false stale
member during creation-19. Fixed fingerprints to ignore only derived connection
selectors 0–14 for fence IDs 101/214/267; color, type, unknown selectors and entity
content remain significant. Legacy simple fence fingerprints normalize on resume
without reserializing model/movie entity fingerprints. Creation-20 completes the
atomic frame revision in 7.719 s; original creation-18 took 12.844 s. Both failed
attempts and observation retries remain this single round.

80 native color/fingerprint assertions and 12 standalone scene regressions pass.
Final native inspection verifies 91 members, 50 retained ground backups, four
flush slab collision tops, unobstructed 2 m passage and 2.5 m visible beam height.
Documented that miniature carriers collide as full block cells. Source manifest,
player and main camera remain unchanged across fresh stdio MCP views. Inspected
white-frame interior and overview: frame colors now agree, floor is flush;
overview still contains the earlier giant fox fixture, so it is not a clean
presentation image. Evidence out/rsi/041/review-final/report.json and images.

Feedback initially failed because instance.json named a dead process/port while
the live 8089 hub and native client remained healthy. Verified the live identity
and restored its discovery record without restarting or rerunning mutations;
producer of the stale record was not established. All 15 MCP/guide/template tests,
TypeScript, skill validation, build and diff checks pass. Native tail_log read.
Authoritative wiki/indexes updated. No world save, project 530 edits or deployment.
Goal remains active 41/100.

## Round 042 — stale singleton discovery without mutation replay

Stdio hub port selection validates discovery PID/port before network I/O. A dead
PID (ESRCH) or invalid record selects the configured port; a live PID or permission
denial preserves discovery precedence. Launch/status and all CLI actions share
this path. No request is automatically retried and no global discovery file is
rewritten by the resolver. The concrete failure in round 41 can now recover
without manual discovery repair when the configured hub is still available.

Real loopback tests assert a stale port dispatches run_code exactly once, live
hub overrides configuration, launch uses the same resolver, and a connection
failure against a live endpoint never sends the mutation to a fallback. First
fixture registered MCP capabilities after connecting; corrected registration
order. All 16 creation/guide/template/recovery tests pass; TypeScript/build pass.
Native script uses fresh stdio with a simulated dead PID and port 1, reads the
same completed creation-18 and captures its current revised scene through 8089.
Report out/rsi/042/report.json; inspected detail.jpg shows coherent white frame,
flush path and same pet. Player/main camera unchanged. Initial native script used
wrong local resultMode key, rejected before dispatch; corrected resultDetail.
No new construction job, world save, project 530 changes or daemon restart.
Lazy connection guide and Keepwork docs updated. Goal active 42/100.

## Round 043 — realistic picnic table with reusable color-only asset

Added lazy picnic_table: 1.75 m slatted tabletop, 0.8125 m work surface, two
0.4375 m benches, tapered open A-frame supports and longitudinal lower brace.
Only color voxels enter the .x; an independent model reuses the exported geometry
at scale 1. Flush native ground uses 32 original-soil backups. Template palette,
metadata, deterministic compilation and lazy composition routing updated.

First creation-21 failed at intentionally overlapping end caps. Added explicit
replacement for this group's assembled boxes. Failed-source persistence attempted
upvalue discovery but Control was hot compiled with an environment in round 40;
that assertion failed, and creation-22 rejected the absent valid manifest before
writes. Retrieved the original failed job from its retained environment and
explicitly saved its partial editable scene. Creation-23 removes/rebuilds only
table/ground groups at the unchanged origin and saves the corrected canonical
source, not the repair wrapper. Completed 15.921 s. Failures count only here.

Native checks confirm 37 current members, 32 ground backups, four color-only
source carriers, unchanged origin and nonstale fingerprints. Independent exported
bounds exactly 1.75 × 0.8125 × 1.53125 m at scale 1; three repeated fresh MCP PNGs
are decoded, nonempty, unclipped and identical. Inspected images show slat gaps,
open space beneath the top and stepped A-frame legs. World detail has both source
and reused table; earlier fixtures remain in the distant background. Player/main
camera unchanged. Evidence out/rsi/043/latest-job.json, native-check.json,
feedback/report.json and image-check.json. Six relevant guide/template tests,
TypeScript, skill and diff validation pass. No new tool, world save or project
530 edits. Goal active 43/100; continue distinct verified art/authoring improvements.

## Round 044 — batch color-box assembly without changing the art

Added bounded voxelBoxes to the reusable library and capabilities: 1–512 boxes,
one fractional resolution, per-box RGB/rotation/hollow, aggregate 65,536 scanned
voxel cap before expansion. Reuses existing carrier planning and Apply, including
bounds/permissions/stale checks, cooperative yields, undo and rollback. Ordered
overlap remains explicit replace=true; defaults reject it before world writes.
Picnic-table generator now collects its same 59 components and makes one batch
call, with a sequential fallback on older engines and geometry statistics.

Native pure planning compares all 6,244 final voxel colors against the baseline:
exact match, 59 geometry calls reduced to one. Actual completed creation-25 reports
one call, 6,436 expanded samples and four carrier writes. Native 9 batch checks
cover invalid color/type/size/empty/dimensions, aggregate overrun before expansion,
and exact 65,536 boundary. Standalone scene tests now 13/13, including negative
world-coordinate carrier crossings and overlap rejection with no writes.

First planning fixture omitted its scene name, failed before world writes; fixed.
Creation-24 unintentionally ran the old bundled template because the new example
had not been restaged; its default overlap failed. Explicitly saved retained
partial source, rebuilt packaging and rebuilt only those groups at the same site.
Creation-25 completes in 10.328 s including cleanup; round-43's 15.921 s is not a
controlled timing benchmark. No speed percentage is claimed. All retries count
as this one improvement. No private Jobs registry reset; selectively refreshed
capabilities with its existing environment to advertise voxelBoxBatch.

Independent model bounds remain 1.75 × 0.8125 × 1.53125 m. Three fresh PNGs pass
decode/clipping/stability checks; inspected screenshot SHA-256 exactly matches
round43: 4809fc756c7c0f8431595a04010e0555a338083498079ffa1c79c280b3f2639c.
Player/main camera unchanged. Evidence out/rsi/044/planning-check.json,
native-batch-check.json, repair/latest-job.json and feedback/report.json.
Six guide/template tests, skill validation, build and diff checks pass; wiki and
CODEMAP/TOPIC-INDEX updated. No new MCP tool, world save, 530 edits or deployment.
Goal active 44/100.

## Round 045 — compact striped garden parasol

Added lazy garden_parasol: 2.25 m diameter, 2.375 m overall height, eight broad
cream/teal panels with narrow darker border, slim pole and compact weighted base.
Rows merge equal-height/color spans; 320 boxes expand to 1,260 samples in one
batch across 20 source carriers. Geometry is color-only and exported once for a
scale-1 instance. Native gravel ground replaces 54 soil cells with backups.
Palette, deterministic template test and composition reference are maintained;
no additional root skill or MCP tool. No external references stored.

Creation-26 auto-scouts without coordinates, duplicates recover its same ID,
completes in 14.078 s and saves editable source. Native inspection verifies all
75 current member fingerprints and the 54 original-soil snapshots. Colored
canopy bottom is exactly 1.9375 m; reported 1.875 m is a conservative visual lower
bound, not a full-cell source collision claim. Independent exported bounds are
exactly 2.25 × 2.375 × 2.25 m at scale 1. Inspected PNG and world detail show the
striped canopy, thin stem and separate weighted stand. Three fresh repeated PNGs
are nonempty/unclipped/stable; player/main camera unchanged.

Evidence out/rsi/045/latest-job.json, native-check.json and feedback/report.json.
Six guide/template checks, TypeScript, skill validation, packaging and diff checks
pass. No construction failure/retry in this round. No world save, project 530
edit or deployment. Goal active 45/100.

## Round 046 — human-scale slatted patio chair

Added lazy garden_chair, 0.5 × 0.9375 × 0.5 m, with 0.4375 m seat, alternating
muted teal slats, open back, dark narrow stiles and slightly splayed metal legs.
Color-only geometry batches 876 samples into four editable carriers, then exports
once and reuses at scale 1. Native ground replaces 30 soil cells with backups.
Template currently requires voxelBoxBatch; metadata and lazy composition guidance
state it. Deterministic palette overrides and meter bounds are tested.

Creation-27 automatically finds a site, duplicate request retains the same job,
completes in 15.328 s and saves generator source. Native check verifies 35 members,
30 original-soil backups and four color-only carriers with exact fingerprints.
Independent loaded dimensions exactly 0.5 × 0.9375 × 0.5 m, scale 1. Inspected
neutral PNG shows readable seat/back gaps, top rail and four stepped legs; world
detail shows appropriately small furniture relative to the neighboring parasol.
Three repeated fresh PNGs pass decoding, clipping and stability; player/main
camera unchanged. Evidence out/rsi/046/latest-job.json, native-check.json and
feedback/report.json. Six guide/template tests and skill validation pass. No
failure/retry, added root skill/tool, world save, 530 edit or deployment. Goal
active 46/100; continue integrated art and runtime verification.

## Round 047 — required template capabilities before construction

Template metadata/compilation now carries requiredCapabilities for examples that
need a newer helper, starting with garden_chair/voxelBoxBatch. run_template checks
capability flags and exact world identity before dispatching any CodeBlock source.
Missing capability gives an explicit update message; changed world gives
world_session_changed. Templates with sequential fallbacks have no requirement
and incur no added read. Recovery of already submitted jobs remains independent
of current template metadata. No additional advertised tools or skill files.

MCP/poll tests cover missing flag, changed world and supported world: rejected
cases dispatch only the capability read, accepted case dispatches run_code after
verification. Fresh real stdio around the actual native hub repeats both rejected
cases with simulated older/changed capability responses. Two capability reads,
zero rejected mutations forwarded. The real current engine accepts the original
round46 request and returns the same completed creation-27, no new construction.
Evidence out/rsi/047/report.json. No new geometry or visual-quality claim.
All 17 related tests, TypeScript, build, skill and diff checks pass. Lazy connection
guide/Keepwork docs updated. No daemon restart, world save, 530 edit or deployment.
Goal active 47/100.

## Round 048 — round café table and useful elevated inspection

Added lazy bistro_table: 0.75 m disk at 0.75 m height, alternating timber strips,
darker rim and narrow central pedestal/cross foot. Fractional row spans batch
1,344 samples into four editable carriers; color-only .x is reused at scale 1.
Native plank floor retains 30 original-soil backups. Explicit required capability
is checked before source dispatch. Palette/determinism tests and lazy composition
routing maintained. No additional root skill/tool.

Creation-28 auto-scouts, duplicate request recovers the same job, completes
10.860 s and saves editable source. Native checks verify 35 current members,
30 backups and four color-only carriers without stale fingerprints. Independent
export dimensions exactly 0.75 × 0.75 × 0.75 m at scale 1. Inspected low view hid
the top's disk shape, so added optional elevation/distance to static-prop native
acceptance and guidance for thin tabletops. Elevated first view had 7 px margin
and failed the 8 px acceptance threshold; increased camera distance to 2.4 m,
without changing geometry or scale. Final elevation 0.65-radian PNG clearly shows
round outline, dark rim, timber bands and cross foot with adequate margin.
Three repeated final PNGs decode/stability/clipping checks pass. Player/main
camera unchanged. Observation retries do not count as rounds.

Evidence out/rsi/048/latest-job.json, native-check.json and
feedback-high-final/report.json/image-check.json. Seven guide/template tests
pass, TypeScript passed; no geometry failure, world save, 530 edit or deployment.
Goal active 48/100.

## Round 049 — conservative default isolated-asset framing

AssetCapture now reuses the existing Framing.Fit rest-bounds sphere at 30-degree
FOV with 8% padding, replacing largest-dimension × 2.6. Static corners remain in
frame at elevated/oblique angles. Explicit distance is preserved. Metadata labels
rest_bounds_sphere and reports automaticDistanceMeters even with an override.
This is a rest-bounds guarantee; deformed animations beyond that box still require
pose inspection. Wiki, topical index and lazy composition guide document it.

Existing six native framing regression checks pass. Real table capture at 0.65
radians now automatically uses 2.71032 m instead of 1.95 m, with ample margins;
three repeated PNGs pass decoded/opaque/clipping/stability checks and dimensions
stay 0.75 m at scale 1. Explicit 1.95 m/0.2-radian capture exactly matches the old
round48 PNG SHA-256 961718294297db0b071b6b513b376874b791b6f314041eba80f8bb50a4739800.
Higher 1.2-radian isolated asset capture also passes; inspected elevated view.
Player/main camera unchanged. No new construction jobs or source/asset edits.

During the supplementary high-angle run, world-view JPEG capture began returning
save_failed twice before reaching asset capture. Logs identify SceneVisionManager
SaveToFile, separate from isolated AssetCapture PNGs. Added explicit asset-only
mode to the acceptance helper and recorded worldCaptureSkipped=true for that
supplement, rather than claiming world-camera success or falling back to cached
images. This is an outstanding native world-view issue for the next round.
Evidence out/rsi/049/native-framing-check.json, auto-high/report.json,
explicit/report.json and asset-top/report.json. Skill/build/diff validation pass;
recent native tail_log read. No world save, 530 edit or deployment. Goal active
49/100; diagnose and repair world-camera failure next.

## Round 050 — release temporary viewport wrappers safely

Verified 60 destroyed scene capture wrappers remained in ViewportManager's Lua
registry. Viewport destruction now removes only its current registered owner,
clears cached native viewport/camera attributes and preserves a newer same-key
owner. Bulk cleanup snapshots instances before callbacks. Standalone regression
covers repeated destruction, replacement ownership and protected GUI cleanup.

Live native validation creates/destroys 100 disabled temporary viewports, then
tests same-name ownership: Lua registry remains 3, native viewport count remains
2, player position and protected GUI/main scene wrappers are preserved. Evidence:
out/rsi/050/native-lifecycle-check.json; standalone ViewportLifecycleRegression.
Wiki and repository indexes document ownership semantics. No world edits.

This does not claim a world-camera repair. Removing dead wrappers reduced the Lua
registry from 63 to 3, but retained native render targets remained and fresh world
captures still returned save_failed; main screenshot was black. Isolated asset
PNGs work. Native diagnostics show enabled main scene/GUI, visible non-minimized
window and Enable3DRendering=true. Root cause remains unproven. No renderer reset,
world reload, cached fallback or project 530 modification. Goal active 50/100.

## Round 051 — reusable terracotta topiary planter

Added lazy terracotta_planter: 0.5 × 0.875 × 0.5 m, tapered hollow pot, thick
terracotta rim, soil, exposed stem and rounded two-tone leaf crown. Row-span
planning packs the geometry into 413 boxes in one fractional batch/four native
colored-voxel carriers. Exported .x is reused at scale 1. Six RGB roles are
adjustable. Vegetation guide routes only this selected template; no extra tool.

Creation-29 auto-scouts without supplied coordinates, duplicate request recovers
the same job, completes and saves source/manifest. Native read-only checks verify
35 current members, 30 original-ground backups, four BlockVoxelModel colored
carriers, empty pot interior below the soil, connected soil/stem/foliage. Initial
verifier mistakenly counted all original snapshots as terrain backups and expected
ordinary ColorBlock ID 10 for miniature carriers; corrected to ground-group
backups and native colored-voxel carrier 289. No geometry changes were needed.

Independent asset reload proves exact meter bounds and scale 1; three fresh PNGs
pass decoding, clipping and repeatability checks. Visually inspected a readable
rounded topiary with visible pot rim, soil and stem. Main player/camera unchanged.
Evidence out/rsi/051/build/latest-job.json, native-check.json and
feedback/report.json/image-check.json. Seven guide/template tests pass.
Acceptance runner now persists completed job state before optional image capture
and explicitly labels asset-only worldCaptureSkipped; native world-camera failure
remains unresolved. No cached images, world save, 530 edit or deployment.
Goal active 51/100.

## Round 052 — small open-frame patio lantern

Added lazy patio_lantern: 0.25 × 0.5 × 0.25 m including its loop handle,
thin metal corner posts/open sides, candle, stepped roof and rim accents.
Fractional 1/64 colored geometry exports once and is reused at scale 1; four RGB
roles are adjustable. Composition guide explicitly distinguishes decorative flame
color from actual emitted light and avoids claiming transparent color-voxel glass.
Negative space expresses detail at human scale without enlarging the object.

Native creation-30 auto-scouts and duplicate request recovers the original job.
Read-only checks verify 35 current members, 30 floor backups and four colored
voxel carriers. Independent reload gives exact bounds and scale 1; three fresh
PNGs pass decoding, unclipped margins and repeatability checks. Inspected clear
handle, stepped cap, open frame and candle. Player/main camera unchanged.
Evidence out/rsi/052/build/latest-job.json, native-check.json,
feedback/report.json/image-check.json and recent tail-log.json. Template palette,
capability and lazy guide checks cover the new registration. World camera capture
is explicitly skipped while its separate renderer failure remains unresolved.
No world save, project 530 changes, deployment or new advertised tools.
Goal active 52/100.

## Round 053 — release owned render targets and recover world feedback

Native diagnosis proved CRenderTarget objects are separate from MiniSceneGraphs:
GetObject("<CRenderTarget>"..name)/ParaScene.Delete releases the retired target,
where DeleteMiniSceneGraph did not. SceneVisionManager now deletes only its unique
independent capture target after viewport destruction, only if it owned the
viewport and no other registered viewport references that target. Singleton/live
preview targets and newer same-name owners are preserved. Regression covers
shared targets, stale ownership, repeated destruction and pending callbacks.

Removed 61 confirmed unreferenced retired capture targets from the disposable
runtime, reducing native count 61→0. Twenty native independent instances then
create/destroy targets with count remaining 0. Real MCP world overview and detail
JPEGs now succeed, visibly show the new planter/lantern test scene, and leave
player/main camera unchanged. Independent PNG checks also pass. Evidence
out/rsi/053/native-lifecycle.json and full-feedback/report.json/image-check.json.
World camera failure is recovered after target cleanup, with no renderer reset,
world reload, cached fallback or source loss. Wiki/indexes document target
ownership; no project 530 edits or deployment. Goal active 53/100.

## Round 054 — meter-based native model offsets

scene:model now supports offset={x,y,z} in local meters with explicit conversion
to native SetOffsetPos units. Matches native X/Z [-0.5,0.5], Y [0,1] limits rather
than allowing native clamping. Invalid offsets fail before carrier writes; actual
transformed authoring bounds remain checked. Capabilities advertises modelOffset.
Native regression passes seven checks including bad offsets/no writes and XYZ
unit conversion. Wiki and lazy composition guide document the feature/limits.

Attempted a lantern on the 0.75 m table, but existing full-carrier occupancy checks
rejected the neighbor as entity_obstruction. This remains an outstanding precise
model-placement limitation; guide explicitly states offsets do not establish
tabletop contact support. Failed creation-31 retained the known table/floor only.
Saved its manifest and repaired those groups at the same origin through creation-32,
placing table and lantern separately with fractional horizontal offsets. No
relocation, unrelated edits or new exports. model-offset.lua demonstrates reuse
and requires the two existing export filenames to be supplied.

Native read-only checks prove 32 current members, 30 ground backups, two model
instances at scale 1, native offsets and XML offsetX/offsetZ persistence. Fresh
world views visibly show the intact round table and lantern; player/main camera
unchanged and capture targets remain zero. Evidence out/rsi/054/native-regression,
native-check, latest-job and report JSONs. Seventeen MCP/template/guide/recovery
tests and skill validation pass. No world save or 530 changes. Goal active 54/100;
resolve full-cell model occupancy for accurately positioned contact props next.

## Round 055 — precise same-scene model contact and rollback

Model helpers now exempt unchanged same-scene model entities from the new
carrier's full-cell check only for that carrier during the helper. After asset
readiness, transformed native AABBs are checked against every other entity and
all blocks in the loaded model volume, with the existing tiny face-contact
tolerance and 65,536-cell limit. Reserved authoring sites, permission checks,
stale members and foreign carrier checks remain enforced. Failure clears the
temporary exemption and native Atomic restores the model's own edits. Native
block ID filtering avoids snapshotting every floor cell while collecting owned
models. Flat asset bounds retain valid one-cell coverage. Capability:
modelContactPlacement. Wiki and lazy composition guidance cover limits and reuse.

Creation-33 auto-scouts and places reused scale-1 lantern on the 0.75 m round table
with distinct carriers/fractional offsets. Fresh world side view visibly proves
contact; native measured contact gap is exactly 0 m. Positive scene contains 32
unchanged members and 30 floor backups. Standalone collision checks pass seven
touching/penetrating/self/pet/scoped/foreign cases; native volume checks pass four
solid/unloaded/limit/flat cases; offset regression seven and Scene regression
13 pass. No new mesh generation/export is needed for this arrangement.

Initial negative probe creation-34 stopped before writes because normal CodeBlock
does not expose global pcall. Moved the acceptance assertion into a native test
module with a temporary method adapter, then creation-35 deliberately overlaps
two real models. It rejects true overlap and restores the temporary carrier,
retaining all original 32 fingerprints. Adapter removed after terminal success.
Evidence out/rsi/055/overlap-native-result.json, final-native-check.json,
volume-regression.json and report.json/detail.jpg. Captures leave player/main
camera unchanged and CRenderTarget count zero. No world save, 530 edits or release.
Goal active 55/100.

## Round 056 — dependency-backed lazy composition templates

run_template accepts named world-local assets only for the selected template's
declared assetSlots. tabletop_lantern reuses two existing scale-1 exports, with
no new mesh export. Role/path validation rejects missing roles, unknown roles,
traversal/absolute/URL/code-injection paths before dispatch. Simultaneous quoted
filename substitution avoids cascading swapped roles. Requirements include
modelOffset/modelContactPlacement/modelDependencies; one MCP tool/root skill
remain advertised. Native requireModels checks every path before loading, then
cooperatively waits for renderable models before the first floor write; duplicate
files load once. Lazy guides/wiki cover the input and saving semantics.

Eight template/guide tests and TypeScript pass. Native seven dependency checks
prove missing/invalid/dense-array/limit rejection before loading and duplicate
asset reuse with no block writes. Fresh stdio run_template creates creation-36
without coordinates; retry recovers that job. Native checks prove 32 current
members, 30 floor backups and exact zero tabletop contact gap. Missing dependency
creation-37 fails before any scene has writes/cells. Structured template request
is 486 bytes, compared with its 1,187-byte base Lua source (not a token/speed
benchmark). Lua serializes empty artifacts as {}, so verifier checks key count.

Fresh world screenshots fail while the test window is minimized. Verified live
IsIconic=true, native viewport count 2 and capture target count 0; CLI
bring_to_front reports success but does not restore it. Asked user to restore the
disposable test window; no new source submission, renderer restart or cached-image
fallback. Recovered original creation-36 for observation. World-image review is
pending window restoration; no claim of fresh visual acceptance for this round's
infrastructure. Evidence out/rsi/056/native-dependencies.json, native-check.json,
reuse-report.json, missing-result.json, capture-diagnostics/window-state/tail-log.
Bundled CLI rebuilt; modern schema verified in fresh stdio, running old HTTP MCP
daemon not restarted. No world save, project 530 edits or deployment.
Goal active 56/100.

Subsequent observation resolved the window limitation: the existing native
IsWindowMaximized setter, reapplied with its current value, restores the minimized
window without changing its maximized mode. Read-only Win32 check confirms
IsIconic=false. Both fresh world images of the original creation-36 now succeed
through MCP (out/rsi/056/review/mcp-report.json). No rebuild was submitted.

## Round 057 — compose a human-scale café terrace from reused props

Added lazy patio_cafe with four required asset roles and no exports: two round
tables, four inward-facing slatted chairs, two contacting tabletop lanterns and
three topiary planters at scale 1. Native plank border, stone inset, white colored
fence and roses complement the color-only models. A 10 × 8 m floor replaces ground
and retains 80 original-soil backups. Source/manifest saving remains explicit.
Eight guide/template checks cover role routing, native materials and no exports.

Creation-38 auto-scouts, duplicate request recovers the same job and finishes.
After restoring the minimized window with the supported native setting API,
fresh overview/detail images reveal an actual art error: ID 112 is Oak_Wood_Stairs,
not Rose. Verified live names: Rose/Red_Rose=115. Corrected the generator to 115
and revised only those four owned flower cells at the established origin.
Initial revision creation-39 had a missing return-table brace and failed compilation
before writes; corrected creation-40 succeeds and saves the canonical generator.
Original failed request is retained; no automatic mutation retry/new relocation.

Final native checks prove 105 current members: 80 floor backups, 11 reused model
instances, 10 native fence blocks and four correct roses. All model dimensions
match their expected meter bounds at scale 1; no stale fingerprints. Inspected
fresh matching views after revision: stairs gone, roses present, chairs face
tables, lamps rest on tops, planters frame the open front. Evidence
out/rsi/057/native-check.json and revision-corrected/report.json/overview.jpg.
Capture target count remains zero; no world save, 530 edits or deployment.
Goal active 57/100.

## Round 058 — restore minimized Windows clients before fresh visual review

BringToFront now reapplies the current native IsWindowMaximized mode before
BringWindowToTop, using the established settings API. It preserves the mode and
reports exceptions; no job or screenshot callback registries are reloaded.
Five native isolated checks cover both modes, ordering and read/restore/front
failures. Live CLI action plus fresh MCP overview verifies stationary player and
main camera, the same world session and no creation submission. Visually inspected
the café image. Earlier minimized-to-restored native evidence remains in round 056.
Updated lazy visual review, authoritative scene inspection and topic index.
Eight final guide/template tests pass after round 057's rose correction; bundled
CLI rebuilt. Evidence out/rsi/058/native-regression.json, report.json, overview.jpg.
No world save, project 530 changes or deployment. Goal active 58/100.

## Round 059 — resolve native block names instead of memorizing numeric IDs

Creation shape helpers now accept exact installed registry names through blockId,
including registered aliases, while retaining numeric IDs and uniform RGB.
Resolution runs before scouting/progress or shape expansion. Capability
nativeBlockNames advertises support; older clients use verified IDs. Lazy material
guide and authoritative creation wiki describe the contract. Eighteen native
read-only checks validate names, aliases, numeric IDs, invalid inputs and actual
Rose/fence shape planning through the native color encoder. The first test fixture
called the Atomic wrapper without its job environment; isolated Atomic in the
fixture and reran successfully, without changing production rollback semantics.
Evidence out/rsi/059/native-regression.json. No world writes, save or deployment.
Goal active 59/100.

## Round 060 — reject miniature requests that silently discard native shapes

Fractional geometry previously accepted a colored fence/stair ID but emitted
color-only miniature voxels, silently ignoring that shape. Resolve and validate
the requested material before scouting: fractions require ColorBlock, while
whole native blocks retain their shape/color behavior. Authoritative wiki explains
the distinction. Eight native read-only checks cover numeric/named fence and rose
rejection, 1/512 ColorBlock acceptance and whole fence compatibility.
Evidence out/rsi/060/native-regression.json. No world writes or save.
Goal active 60/100.

## Round 061 — reusable human-scale slatted garden bench

Added lazy garden_bench: 1.5 m wide, 0.9375 m high, seat at 0.4375 m, timber
slats with narrow dark end frames, four feet and a lower brace. Color-only
1/32 geometry is batched, exported once and independently instanced at scale 1.
First live creation-41 failed before any writes: my test hotpatch wrapped the
two-argument shape method with the one-options Atomic adapter. Corrected the
runtime-only adapter to the existing production pattern; no production adapter
change. Expanded round 059's positive planner tests to exercise the real Atomic
wrapper; all 18 pass. Creation-42 then auto-scouts and completes (duplicate
recovery tested). Native checks verify 40 members, 35 original-soil backups,
four miniature carriers and no stale members; failed-41 has zero cells/writes.

Independent reload found actual depth 0.46875 m versus an erroneous 0.5 m
declaration. Corrected the template and used source-only creation-43 to persist
the canonical generator and return corrected bounds at the same origin, with
no geometry rebuild or new export. Three fresh PNGs verify exact dimensions,
scale 1, stable pixels and no clipping; visually inspected the open slats/frames.
Fresh world images keep player/main camera stationary. Eight guide/template
tests and bundled CLI build pass. Evidence out/rsi/061/native-check.json,
metadata-corrected/latest-job.json, feedback-corrected/report.json/prop-0.png.
No world save, project 530 changes or deployment. Goal active 61/100.

## Round 062 — named native materials around reused pocket-garden seating

Added lazy bench_garden, 5 × 6 m with one verified bench and two existing topiary
assets, three pale native fence blocks, sparse native roses/yellow flowers/grass
and a flush stone path within grass. Both dependencies preflight before writes;
requires nativeBlockNames and model capabilities, no new exports. Creation-44
auto-scouts and completes; duplicate request recovers it. Native checks prove
44 unmodified members, 30 original-ground backups and exact expected native IDs
resolved from names. Eight guide/template tests cover new bench dimensions and
nook role routing/materials/no exports. Bundled CLI rebuilt.

First quick overview includes the temporary scouting overlay; recovered the
same job for fresh images after its normal 10-second lifetime. Inspected clean
overview: bench against pale back rail, planters framing paving and open front,
native plants in side grass. No rebuild or camera/player relocation requested.
Evidence out/rsi/062/native-check.json and review/mcp-report.json/mcp-overview.jpg.
No world save, project 530 changes or deployment. Goal active 62/100.

## Round 063 — material preflight before expensive helper expansion

Shape helpers now validate RGB and native painting/data encoding before progress,
site revalidation and geometry expansion. Previously unsupported flower coloring
or malformed input could allocate a large valid shape before failing. Native
read-only checks verify six invalid palette/data requests fail before progress
and two valid native requests reach it; all 18 named-block and eight miniature
material checks also pass with the production-shaped Atomic adapter.
Authoritative creation wiki describes preflight. Evidence
out/rsi/063/native-regression.json. No world writes or save. Goal active 63/100.

## Round 064 — hollow human-scale birdbath with a recessed basin

Added lazy garden_birdbath: 0.75 m diameter, 0.6875 m high, narrow column,
stepped base and raised hollow circular rim. Batched 1/32 color-only row spans
keep the blue decorative surface recessed; no native liquid/transparency claims.
Creation-45 auto-scouts, duplicate request recovers it, exports once and creates
a scale-1 instance. Native checks prove 35 unmodified members, 30 original-soil
backups and four miniature carriers. Independent reload at elevated view confirms
exact bounds; three fresh PNGs are nonempty, stable and unclipped. Visually
inspected the open ring, recessed blue surface and pedestal. Fresh world images
preserve player/main camera. Eight guide/template tests cover routing, palette
and decorative-water metadata. Bundled CLI built; evidence
out/rsi/064/native-check.json and feedback/report.json/prop-0.png.
No world save, project 530 changes or deployment. Goal active 64/100.

Batch follow-up: all 13 CreationSceneRegression cases pass with the new preflight,
TypeScript noEmit and both repository diff checks pass. Skill validator passes.
Recent native logs saved to out/rsi/064/tail-log.json. HTTP MCP daemon remains
the older live schema; fresh stdio clients tested the rebuilt templates through
the same singleton hub. Modern HTTP-template acceptance is still outstanding.

## Round 065 — revise contacting models without clearing their neighbors

Read-only native probe reproduces entity_obstruction when checking the lantern's
carrier beside its own table. Removal now scopes an exemption to owned model
carriers whose original was air. Each CheckCell rebuilds the unchanged owned-model
set so newly modified neighbors lose the exemption; foreign models/entities,
edit permissions, locked cells and stale target checks remain. Context clears
after success/failure, including snapshot errors. Capability modelContactRemoval
and lazy persistence/native wiki document the boundary.

Creation-46 resumes the original scene, tests simulated foreign obstruction and
manual-neighbor fingerprint change before writes, then deletes/recreates just
the contacting lantern. Native verification proves 32 unmodified members and
unchanged table; saves original generator plus current manifest. Fresh detail
image shows the same tabletop contact at the fixed origin. Native test adapter
removed; all 13 scene regressions pass. Evidence out/rsi/065/before-probe.json,
capabilities.json and revision/latest-job.json/report.json/detail.jpg.
No world save, project 530 changes or deployment. Goal active 65/100.

## Round 066 — small rabbit with grounded paws, tilting ears and an explicit hop

Added lazy hopping_rabbit, 0.453125 m long and about 0.46875 m to upright ear
tips. Color-only 1/64 body/head/haunches, cream paws/tail, pink muzzle/ear centers,
two separate pivoted ear meshes; three scale-1 assets and an editable MovieBlock.
Idle spans 0–2 s; the whole-animal toy-like hop spans 2–4 s with 0.125 m apex.
No skinned leg gait or embedded clip claims. Animal guide routes lazily to source.

Initial creation-47 fails on root bone readiness after geometry has loaded.
Bone keyframe preflight now waits cooperatively for native skeleton children,
retaining bounded failure/cancellation and unknown-name rejection before tracks.
Three native tests cover delayed readiness, 500-check missing skeleton limit and
cancellation. Persisted the known failed scene and repaired only its MovieBlock
at the fixed origin in creation-48, reusing its mesh exports.

Pixels then reveal disconnected floating paws. Pure source planning proves the
gap (2480/2650 connected voxels); added short front legs/haunches, positioned eyes
against the head. Final all 3038 body voxels connect by faces and four paw bases
touch y=0. Creation-49 revises body/movie at the same origin; ear assets stay.
Uses a new body filename to avoid native cached old geometry. Corrected canonical
generator and manifest saved. Nine native frames prove scale, final ear rotations,
joint offsets, 0.125 m apex and grounded/looped endpoints; source/member/manifest
hashes unchanged by capture. Eight isolated PNGs prove stable/unclipped feedback;
visually inspected rest and motion poses. Fresh stdio template creation-50 now
succeeds from new filenames with asynchronous skeleton loading and duplicate
request recovery, without the repair adapter.

Eight guide/template tests, skill validation and bundled CLI build pass.
Evidence out/rsi/066/bone-ready-regression.json, connectivity-before/after.json,
hop-check.json, body-corrected/report.json, assembly-corrected/report.json and
fresh/mcp-report.json. No world save, 530 changes or deployment. Goal active 66/100.

## Round 067 — author the rabbit's 33 poses in three native batches

Rabbit generator now builds one keyframes batch per actor, reducing 33 individual
helper calls/snapshots/undo commands to three while retaining the same 11 poses
per actor. Capability keyframeBatches gates the template on older engines; a MCP
test proves rejection before mutation when batching support is missing.
Creation-51 revises only the fresh round-066 scene's MovieBlock at the fixed
origin, reusing all three assets and saving the canonical generator. Read-only
native snapshots compare every authored actor/bone time and key value identically.
The native range track's cached slot zero differs; it is not an authored key and
is excluded explicitly, with original raw evidence retained. Initial snapshot
fetch returned health instead of execution; switched the verifier to the existing
native HTTP request contract with explicit Content-Length. No mutation occurred
until before-snapshot was validated. Recovering the saved job never replays writes.

Nine native frames reconfirm part scales, joints and final ear rotations; eight
isolated PNGs pass margin/stability checks and the rest pose was visually inspected.
Source/manifest/member hashes stay fixed during captures. Eight guide/template
tests and bundled CLI build pass. Evidence out/rsi/067/revision/track-check.json,
authored-before/after.json, report.json and assembly/report.json/image-check.json.
No geometry exports, world save, 530 changes or deployment. Goal active 67/100.

Batch verification: 13 scene regressions, TypeScript noEmit, skill validation and
both diff checks pass. All created/repaired jobs are terminal; no process remains
pending. Remaining work includes further species/scene composition, integrated
revision/undo acceptance and current HTTP MCP daemon verification before the
100-round completion audit. Existing daemon PID 9608 still predates newer schemas.

## Round 068 — invalid native HTTP POST cannot silently become health

Reproduced standard fetch returning health for a valid read-only command, with
and without explicit length: the installed native HTTP parser did not deliver
its JSON body. The endpoint previously treated this as missing action and replied
successfully with health. POST now returns invalid_json_body, missing_action or
invalid_params as appropriate; GET-without-action remains health and explicit
query aliases retain compatibility. This does not claim the older C++ parser
now supports fetch bodies; bundled CLI/Keepwork transport remains the usable path.

Eleven native decoder checks and six live HTTP cases verify canonical command
execution with matching request ID, GET health, bad JSON/envelopes and explicit
fetch failure with no false health. Page hot-refresh picks up the change without
resetting jobs or restarting the engine. Documented native limitation and indexed
the endpoint. Evidence out/rsi/068/fetch-probe.json, native-regression.json,
http-report.json. No scene mutations, world save, 530 edits or deployment.
Goal active 68/100.

## Round 069 — grounded sitting tabby with tail idle

Added lazy sitting_cat: two color-only scale-1 meshes, pointed pink-centered ears,
cream paws/muzzle, green eyes, tabby markings and a dark-tipped curved tail. Body
bounds are 0.21875 x 0.453125 x 0.328125 m; total length including the tail is
about 0.59 m. Body remains fixed while root-bone tail yaw alternates +/-0.35
radians in an editable two-second MovieBlock. No walking, skinning or embedded
animation claim. Batched boxes and keyframes keep execution compact.

Read-only planning verifies 2,413 connected body voxels and four grounded paws.
Native creation-52 completes through fresh stdio MCP with automatic placement
and duplicate-request recovery. Six seek times verify native scales, dimensions,
rotations and joint offsets. Eight independent assembly PNGs show rest and both
tail extremes; decoded images are nonempty, unclipped and repeatably stable.
Source/manifest/member hashes and player/main camera remain unchanged by captures.
Eight guide/template tests, TypeScript, skill validation and bundled build pass.
Evidence out/rsi/069/body-planning.json, request.json, build/report.json and
assembly/report.json. Source and two world-local .x assets explicitly saved;
no world save, project 530 edits or deployment. Goal active 69/100.

## Round 070 — reuse props in a native birdbath seating garden

Added lazy birdbath_garden with two required same-world asset roles, bench and
bath. Its 7 x 7 m composition uses a 1.5 m bench, 0.75 m decorative birdbath,
native oak-leaf low hedges, red/yellow flower clusters and sparse grass. Flush
stone paving leaves an open front approach and keeps planting away from paths.
Dependency preflight runs before floor edits; two scale-1 instances reuse existing
exports. Guide explains composition, asset provenance and decorative water.

Fresh stdio MCP completes creation-53 with automatic placement and duplicate
recovery. Native inspection verifies 72 unchanged members: 49 ground backups,
two model carriers, five fences, six leaf blocks, six flowers and four grass
plants; artifacts remain empty. Overview/detail screenshots show floor level,
readable prop separation and open entrance; neighboring acceptance fixtures are
visible in the background and are not part of this garden. Capture hashes,
player and main camera remain stable. Eight guide/template tests, TypeScript,
skill validation and bundled build pass. Evidence out/rsi/070/request.json,
build/report.json and native-check.json. No new assets, world save, 530 changes
or deployment. Goal active 70/100.

## Round 071 — scoped repaving preserves original soil and fixtures

Added a reusable native acceptance runner for changing only a garden's 16 paved
floor cells to named Oak_Wood_Planks. The script resumes the saved scene at its
fixed origin, retains the original ground group, compares first-soil snapshots
and every unrelated member, and saves the full amended generator. Persistence
guidance now describes repaving owned cells without removing the entire garden.

Creation-54 passed origin/soil/fixture assertions and saved the revision, then
failed in result formatting because getfenv is unavailable in normal CodeBlock
source. Retained its failed handle and replaced that diagnostic lookup with
ordinary scene inspection and computed views. Explicit repair creation-55
completes; repeats recover the saved job instead of making another mutation.
No hidden native authority is required by the revision code. Existing-job native
captures show flush wooden paving, unchanged bench/bath/hedges/flowers and open
approach. Capture hashes and player/main camera stay fixed. Build, skill validator
and diff check pass. Evidence out/rsi/071/revision/latest-job.json (known failure)
and revision-fixed/latest-job.json/report.json/detail.jpg. No exports, world save,
project 530 edits or deployment. Goal active 71/100.

## Round 072 — restore/repaint cycle with first-soil verification

Added a linked floor-restore-cycle example and a scoped MCP revision runner with
persisted request/job recovery. It restores all 49 ground members to their first
native snapshots, repaints the same floor, compares original backups and every
unrelated fixture, and saves the still-valid full generator with its manifest.
Guide explains that removal restores the entire named floor group, so independent
paths/floors should use separate groups. It is explicitly an existing-scene patch.

Creation-56 completed restoration/repainting/assertions and saving, then failed
at camera coordinate generation: strict toWorld rejected an outside-bound eye.
Retained the failure; corrected camera conversion from two valid interior points.
Explicit repair creation-57 completes with all restoration flags true and no
stale members. Fresh captures match the wooden garden; source/member/manifest
hashes and player/main camera stay fixed. Three lazy-guide checks, skill validator
and build pass. Evidence out/rsi/072/cycle/latest-job.json (known failure) and
cycle-fixed/latest-job.json/report.json. No new exports, world save, 530 edits or
deployment. Goal active 72/100.

## Round 073 — read-only outside-footprint camera coordinates

Added Scene:cameraPoint and sceneCameraPoints capability after the round-72
strict-toWorld failure. It validates finite three-component local coordinates,
checks the world session and converts with native block coordinates without
writes. position/toWorld continue to enforce construction bounds. Updated the
engine wiki/indexes and linked a compact read-only saved-scene review example;
older engines retain the two-interior-point conversion fallback.

Fifteen native checks cover fractional/negative/outside coordinates, malformed,
NaN/infinite/oversized vectors, session failure, unchanged strict edit bounds
and an existing scene. Creation-58 generates outside-bound camera coordinates
without source/manifest/block edits. Native captures reproduce both previous
views within 0.00002 engine units; source/member/manifest hashes, player and main
camera remain fixed. Three guide tests, 13 scene regressions, skill validation,
build and diff checks pass. Evidence out/rsi/073/native-check.json,
camera-check.json and review/report.json. No exports, world save, project 530
changes or deployment. Goal active 73/100.

## Round 074 — real floor undo/redo and manual-edit protection

Added a scoped native floor-undo regression and documented the observed manifest
behavior after undo. During active creation-59, one owned wooden path cell is
repainted to stone, capturing the actual native command through an instance-local
World.Commit wrapper. Command Undo restores wood and exposes stale membership;
Redo restores stone and its expected fingerprint. A simulated later edit causes
undo conflict and remains untouched. The test then restores the original wooden
cell through the helper, keeps its first-soil backup, and removes the local hook.
Two native commands remain registered through the ordinary undo manager; this
does not claim a UI keyboard undo test or history reset.

Seven checks pass; fresh capture matches the prior garden. Final source, manifest
and member hashes are exactly identical to the round-73 baseline, with unchanged
player/main camera. Skill and native wiki explain inspection/reconciliation after
undo rather than bypassing stale fingerprints. Three lazy-guide checks, build
and skill validation pass. Evidence out/rsi/074/review/report.json and
undo-check.json. No exports, world save, 530 changes or deployment.
Goal active 74/100.

## Round 075 — batched human poses and standalone embedded clips

Updated mini_character to author seven arm rotations plus idle/wave ID starts in
one keyframes call instead of nine calls; template requires keyframeBatches.
Fresh automatic creation-60 exports a 1.75 m two-bone character and independent
embedded clips. Native track audit verifies seven exact times and ID 0 at 0 ms,
ID 1 at 1000 ms. Seven seek times independently verify native right-arm poses,
dimensions/scale and absence of external bone keys on the reloaded clip actor.

Assembly verification exposed missing blocksize in the human template result,
then a verifier incorrectly expecting rigid rotation framing for a two-bone
skinned asset. Added native unit metadata, fail-fast report validation and the
appropriate conservative rest-sphere framing check. Metadata/source-only
creation-61 repairs the same scene without geometry/export repetition. Eight
isolated PNGs pass margin/repeat checks; inspected rest and peak-wave images
show attached arm and recognizable clothing/face. Hashes and player/main camera
remain stable during capture. Eight guide/template checks, TypeScript and skill
validation pass. Evidence out/rsi/075/track-check.json, metadata/report.json and
assembly-fixed/report.json. No world save, 530 edits or deployment.
Goal active 75/100.

## Round 076 — mixed scenes survive two explicit save/reopen cycles

Added multi-scene persistence and fresh-session review runners. The lifecycle
journal records save/open phases before dispatch and recovers completed reads
without repeating world mutations. First reopening briefly reported a stale
floor member while terrain finished loading; later native reads matched exactly.
Added bounded read-only readiness observations and recovered that first cycle,
then completed the second. Guide distinguishes entered status from ready scene
snapshots and preserves exact comparisons rather than refreshing fingerprints.

Disposable world sessions 8 -> 10 -> 12 retain garden, cat, rabbit and human:
93 members, 19 groups, 49 first-ground backups, two BoneBlocks, four MovieBlocks,
seven actor time-series inventories and seven exported asset files. Source/manifest/member,
soil/track/asset hashes and fixed origins/dimensions match after both cycles.
Fresh-session read-only jobs reopen native movies; 22 seek times verify native
poses/scales/joints and independent human animation IDs. Twenty-four isolated
PNGs pass decoded margin/stability checks; inspected cat tail, rabbit and wave
frames. Old session-8 creation and capture requests reject without writes/images.
Re-running the completed lifecycle performs only observations. Eight guide/template
checks, skill validation and bundled build pass. Evidence out/rsi/076/persistence,
old-identity-check.json and garden/cat/rabbit/character reports and assembly folders.
Explicit local world saves occurred; no new exports, project 530 edits, login,
publishing or deployment. Goal active 76/100.

Coverage limit: the garden review result does not list its two reused prop files,
so this audit proves their native carrier XML survived, but does not compare their
binary hashes. Next audit should discover model dependencies from native members
rather than relying only on result metadata. Older HTTP daemon still needs current
gateway/template acceptance; no full 100-round completion claimed.

## Round 077 — native reused-model references and complete asset persistence

Added creationModelReferences and inspect().models with actual native filenames,
absolute carriers, scale/facing, local-meter offsets, readiness/availability and
stale state, ordered deterministically. Empty inspection now checks its world
session. It performs no writes or asset waiting; unavailable members stay explicit.
Seven native checks verify two ready scale-1 props, 0.25 m bench offset, stable
ordering, copied positions, missing entities and expired-session rejection.

Persistence audit now discovers model files from native BlockModel entities
rather than relying on result metadata. Two further explicit local save/reopen
cycles, sessions 12 -> 14 -> 16, preserve all 93 members/19 groups/49 backups,
bone/movie tracks and now all nine asset hashes, including the previously omitted
bench and birdbath. Fresh-session garden review returns both references and fresh
captures with unchanged source/member/manifest hashes and player/main camera.
Updated engine wiki/indexes and lazy persistence guide. Three guide checks,
13 scene regressions, build, skill validation and diff checks pass. Evidence
out/rsi/077/model-reference-check.json, persistence/report.json,
model-assets-check.json and garden/report.json. No new exports, project 530
changes or deployment. Goal active 77/100.

## Round 078 — live HTTP gateway and build-age diagnosis

Added read-only live Streamable HTTP MCP acceptance and connection guidance for
HTTP/stdio gateways with different build ages. Against the existing 8089 daemon,
verified one Paracraft gateway, one root resource, a 470-byte gateway schema,
single-file on-demand skill reads reflecting current model-reference guidance,
current native capabilities/world identity, and a fresh native JPEG with timestamp,
camera/session/chat/pet metadata. Image bytes are saved separately and excluded
from report/log output. Player and main camera remain unchanged.

The old HTTP daemon rejects sitting_cat as unknown_template, while the fresh
stdio catalog supports it. Guidance distinguishes gateway template availability
from native engine capabilities and describes reviewed run_code/current stdio
as usable paths until the installed service refreshes. This is an explicit
remaining limitation, not a claim that updated HTTP templates are accepted.
Inspected the HTTP garden JPEG. Three lazy-guide checks, build, skill validation
and diff check pass. Evidence out/rsi/078/http/report.json/http-detail.jpg.
No scene mutations, saves, exports, project 530 changes or deployment.
Goal active 78/100.

## Round 079 — session-pet references and live dual-transport isolation

Added desktop scenePetReferences and scene:petReference() to ensure and inspect
the current chat's pet without changing its fixed scene origin. Updated native
wiki/indexes and the lazy connection guide; a small resumed-scene example creates
no blocks, saves or exports. Real HTTP and stdio clients share the same hub and
world session 16, with separate jobs creation-67/68 and separate pets.

Verified both jobs running concurrently, same-chat creation_busy, duplicate-ID
recovery and cross-chat cancellation rejection. Seven native visibility checks
cover capture leasing, activity during a lease, overlapping capture refusal,
latest-active restoration, unchanged pet positions and ordinary entity visibility.
Fresh MCP JPEGs reviewed: each shows only its own pet. Recovered the same completed
handles for further capture checks without repeating jobs. Source/manifest/member
hashes, player and main camera remain unchanged; all groups have zero stale cells.
Three guide checks, skill validation and build pass. Evidence
out/rsi/079/two-chat/{jobs.json,report.json,a.jpg,b.jpg}. No world saves, exports,
project 530 changes or deployment. Goal active 79/100.

## Round 080 — preserve unrelated native tasks on an existing pet

Reproduced a controller-ownership bug using a real native Copilot waiting task:
PetPosition checked only the chat-owned controller and then replaced the existing
entity's different controller attachment. The native regression restores its own
test task/controller even when the assertion fails. Added a check of the actual
entity.copilot before any controller replacement; a running task now yields
pet_busy, retaining its attachment, running task and position.

Five native checks pass after the fix; before.json records the original failure.
Eight standalone world adapter checks cover routes, unknown terrain, swept
clearance, cancellation, drag release and water fingerprints. Recovered the same
round-79 jobs for live HTTP/stdio visibility and unchanged-scene/player/camera
checks after native World reload. Three guide checks, skill validation, build and
focused diff checks pass; tail_log captured through the CLI. Updated the engine
wiki and lazy connection guide. Evidence out/rsi/080/{before.json,after.json,
tail-log.json} and refreshed out/rsi/079/two-chat/report.json. No world saves,
exports, project 530 changes or deployment. Goal active 80/100.

## Round 081 — stop navigation when a native task takes over mid-route

Reproduced a second ownership race: a real native waiting task starts after the
first checked movement step, but navigation previously continues to its endpoint.
Added CheckPetBusy throughout travel and dragging pauses, sharing the existing
initial controller check. A takeover now stops scouting with pet_busy at exactly
the takeover position and leaves the other native task/controller intact.

Four native checks prove current position equals the takeover position, differs
from destination, and task/controller survive. This route rises four blocks;
it stops after the first 0.2-block step. Test restores only its own fixture position
and stops only its own waiting task. Original failure and corrected coordinates
are in out/rsi/081/{before.json,after.json}. The initial five-check busy regression
also passes. Eight world adapter regressions, three guide checks, skill validation,
build and focused diff checks pass. Recovered live HTTP/stdio round-79 handles
still verify single-pet fresh captures and unchanged scene/player/main camera.
Updated wiki/CODEMAP and lazy placement guide. No world saves, exports, project
530 changes or deployment. Goal active 81/100.

## Round 082 — compact native flower border with flush soil and sparse clumps

Added lazy flower_border template/example: 4 x 4 m, a one-meter gravel approach,
an irregular five-cell bare-earth bed, two rose cells, one dandelion cell and one
grass cell. Native model textures supply the silhouettes/colors; no handmade
voxel petals or exported files. Updated vegetation routing and plant guidance:
one native cell may render multiple stems, so density follows visible clumps.
The default template saves nothing; this disposable-world test explicitly saves
its generator/manifest only, not the world.

Real stdio MCP automatically selects a site and completes creation-69 in session
16, with duplicate-request recovery. Native inspection confirms 13 unchanged
members in four groups, nine original-grass backups, exact named native IDs,
flush floor at origin Y-1 and supporting ground beneath every plant. Initial
views contained the temporary site overlay; recovered the same completed job
after its normal ten-second expiration and reviewed clean MCP/native overview
and detail views. Flowers remain readable with a deliberate soil gap; no raised
road. Capture source/manifest/member hashes, player/facing and main camera match.
Eight guide/template checks, skill validation and build pass. Evidence
out/rsi/082/border/{request.json,report.json,native-material-check.json,
mcp-report.json,mcp-overview.jpg,mcp-detail.jpg}. No exports, world save,
project 530 changes or deployment. Goal active 82/100.

## Round 083 — clean fresh captures while a temporary site preview is live

Creation-owned overlays now register their lifetime and participate in the
existing authoring capture lease. Captures hide their bounds without changing
selection; cleanup restores original visibility only for live current-world
overlays. New previews created mid-capture stay hidden until completion. Destroy
is idempotent, and expired/deleted previews or old-world callbacks cannot revive
overlays. Preview visibility survives development method reloads.

Real MCP images of the same native flower border show the previous cyan site box
and the corrected clean frame: cyan pixels 9933 -> 0. The live preview returns
after capture; an invalid camera request also releases the lease and restores it.
Native checks preserve user selection, player and main camera. Standalone lifecycle
checks cover initially hidden previews, new previews, expiry/double cleanup and
world switching. Authoring regressions and recovered HTTP/stdio dual-chat capture
checks pass. Three guide checks, skill validation, build and focused diff checks
pass; CLI tail_log retained. Updated wiki/CODEMAP and lazy visual-review guidance.
Evidence out/rsi/083/preview/{report.json,pixel-check.json,before.jpg,after.jpg}.
No scene writes, saves, exports, project 530 changes or deployment. Goal active 83/100.

## Round 084 — native textile/glazing reading corner and fixed model directions

Added lazy reading_corner: a 4 x 4 m open cutaway with 3 m cream walls, one native
glass pane, flush wood floor and thin two-tone native White_Carpet rug. Two asset
slots reuse the existing color-only 1.5 m bench and 0.875 m planter at scale 1;
no exports. First native run creation-70 failed during bench placement: native
camera-derived facing expanded its bounds into nearby carpet cells. Inspected
the failed scene/asset, retained the failed handle and its 43 completed members,
and fixed explicit facing plus a 0.125 m local bench offset.

Saved the valid partial manifest for an explicit same-origin repair, creation-71.
Only two models are added; all 43 previous member fingerprints remain unchanged.
Saved the complete corrected generator, not merely a repair patch. Fresh full
auto-scouted creation-72 then succeeds and recovers duplicate requests. Both
scenes have 45 members/six groups, 16 first-ground backups, six correctly
supported carpet cells, one native window and two ready models at measured
design sizes. Reviewed overview/detail captures: readable glazing, thin floor
textiles and grounded bench/plant; source/member/manifest and player/main camera
remain stable during captures. Eight guide/template checks, skill validation,
build and diff checks pass. Guidance now calls for explicit model directions and
small gaps at occupied cells. Evidence out/rsi/084/corner, repair, fresh and
native-material-check.json. Explicit local generator/manifest saves only;
no world saves, exports, project 530 changes or deployment. Goal active 84/100.

## Round 085 — camera-independent default model direction

Scene:model now sets omitted facing to zero radians instead of inheriting native
camera placement direction. modelDefaultFacing advertises the change; explicit
facing/pitch/roll remain supported and finite-angle checks precede carrier writes.
Existing models are not refreshed/reoriented. Updated official wiki/topic index
and lazy composition/persistence guidance, with a two-instance direction example.

Native automatic creation-73 completes in the cluttered disposable world after
checked travel, placing two ready scale-1 benches with native facing 0 and pi.
Fresh overview/detail views inspected; 26 members/three groups remain current,
and source/manifest/member hashes plus player/main camera match during captures.
Ten instance-only angle/preflight checks and seven existing offset checks pass.
Read-only native checks confirm both previous reading corners' material/layout,
scale and explicit directions remain intact. Live HTTP MCP fresh capture still
works via the single gateway/root; its older template catalog remains an explicit
limitation. Three guide checks, skill validation, build and focused diff checks
pass. Evidence out/rsi/085/{direction/report.json,angle-check.json,offset-check.json,
existing-models-check.json,http/report.json}. Test explicitly saves source/manifest;
no world saves, exports, project 530 changes or deployment. Goal active 85/100.

## Round 086 — meter-scale trotting dog and cold-asset readiness

Lazy trotting_dog builds a 0.55 m long, 0.44 m tall floppy-eared dog from
color-only geometry, with three reusable ParaX meshes and six MovieBlock actors.
Thirteen explicit keys per actor provide idle and an in-place diagonal rigid-leg
trot with tail motion. Legs use design-meter bone translations; the gait has no
knee IK, forward travel or embedded clip IDs. Conservative toe lift leaves small
stance gaps, disclosed in the animal guide. Generator and native parts remain editable.

Initial creation-74 failed on an older hot-loaded keyframe adapter's missing B
binding; repair-75 exposed cold requireModels polling without starting asset loading.
Fixed runtime adapter binding and production requireModels with native LoadAsset,
valid-handle preflight and cooperative readiness checks. Terminal failures remain
in out/rsi/086/{dog,repair}; creation-76 repairs only the movie at the original
origin, reusing all existing meshes and construction groups. Full corrected source
is saved, rather than the repair wrapper. Fresh automatic creation-77 also passes.

Actual assembly captures found frame drift during root translation. Single-root
framing now includes the linear translation key range alongside its rotation
envelope. Native seven framing checks and 18 assembly checks pass. This does not
claim fixed framing for actor travel, animated scaling or multi-bone deformation.
Nine dependency checks cover cold-start invocation, invalid handles, full-path
preflight and duplicate files. A unique never-rendered native model starts unloaded,
then becomes renderable through a helper-only job (creation-78); its temporary
probe file is removed after verification, with no scene saves/writes.

Eleven fresh isolated MCP PNGs cover rest, intermediate and extreme poses. Native
dimensions, scale-1 joints and 13 rotation keys are verified; actual captured
translations and rotated foot corners prove meter-based lift, planted rest feet,
diagonal synchronization and no floor penetration, including time 1.125 between
keys. PNGs are nonempty/unclipped, repeated fixed poses match, and auto camera,
source/manifest/member fingerprints plus player/main camera remain stable.
Rest and mid-trot images reviewed. Eight guide/template checks, skill validation,
build and focused diff checks pass. Evidence out/rsi/086/{repair-cold/report.json,
fresh/report.json,fresh-assembly/report.json,fresh-assembly/foot-check.json,
fresh-assembly/image-check.json,dependency-check.json,cold-preflight,framing-check.json}.
Explicit local source/manifest saves and three asset exports per full dog fixture;
no world saves, project 530 changes or deployment. Goal active 86/100.

## Round 087 — stable root-scale animation feedback

Native creation-79 reuses the existing color-only plant asset in an automatically
scouted 4x3x4 site, with one editable MovieBlock and five root-scale keys. Instance
scale stays 1; the deliberate squash/stretch peaks at [1.15,1.5,1.15]. No assets
are re-exported and no terrain is modified. Before the fix, actual isolated seeks
changed automatic camera distance from 6.82081 m to 8.36876 m; the acceptance
script rejected drift after capturing all frames (out/rsi/087/before PNGs).

AssemblyCapture now reads native root scaling tracks and Framing uses each axis's
maximum absolute key scale for its conservative sphere. Combined rotation,
translation and linear root scaling have stable framing; actor travel/scaling and
multi-bone deformations retain their documented limits. Nine native geometry checks
include anisotropic scale extrema and scale-only envelope selection. Native and
MCP captures prove eight actual scale poses match intended keys at instance scale
1, with constant camera parameters, unclipped opaque PNGs and repeated-pose pixel
identity. Peak plant pose inspected. Source/manifest/member hashes, player and main
camera remain unchanged during capture. Three guide checks, skill validation,
build and focused diff checks pass. Updated native wiki/CODEMAP and lazy animation
guidance. Evidence out/rsi/087/{pulse/report.json,after/report.json,after/image-check.json,
scale-check.json,framing-check.json,tail-log.json}. Source/manifest save explicit in
native fixture; no world saves, new exports, project 530 changes or deployment.
Goal active 87/100.

## Round 088 — retain failed capture evidence without false approval

Assembly acceptance now atomically checkpoints each PNG's world/session,
timestamp, camera and native pose metadata before comparing expected poses.
Progress uses a unique review ID and records partial pose verification separately
from overall review success. Failures retain their images and bounded error,
with verified=false. Pixel validation rejects incomplete reviews and completed
reports whose review ID differs from the current progress record, so an earlier
green report cannot conceal a failed rerun. Image bytes stay in PNGs/native MCP
image content, not textual progress or logs. Lazy visual-review guidance teaches
these distinctions and fresh recapture without scene rebuilds.

Actual native fault injection changes only a local expected anchor, then requests
a fresh MCP frame: Wrong pose anchor rejects it, but its decodable PNG and metadata
remain present with poseVerified=false. A previous valid report deliberately left
in that directory is rejected as unverified. A separately mismatched review ID is
also rejected. Eight fresh correct frames pass all native/PNG checks and are marked
completed/verified. Failure and success member/source/manifest hashes and player
and main-camera baselines match; native checks confirm all nine temporary capture
controls/UI objects are removed and no capture remains pending. Three guide checks,
skill validation and focused diff checks pass. Evidence out/rsi/088/{failure,
success/report.json,success/capture-progress.json,evidence-check.json,cleanup-check.json,
tail-log.json}. Read-only captures of creation-79; no new jobs, source/world saves,
exports, project 530 changes or deployment. Goal active 88/100.

## Round 089 — compact native flush-water garden

Lazy pocket_pond adds a 4x4 m world garden without miniature geometry or exports:
2x2 m native Still_Water at local y=-1, four StoneBrick bed cells at y=-2,
horizontal LilyPad data 2, Fern/TallGrass/Yellow_Flower on grass banks and a
one-meter flush gravel path. It preserves 12 first-ground backups and requires
terrainEditing plus named-block/camera support. The ground-water guide routes
to this selected compact design rather than generating the larger bench garden.
Template tests cover native names/orientation, bounds/terrain capability,
automatic placement and no default save/export. Native wiki and indexes updated.

Automatic creation-80 completes via fresh stdio MCP, duplicate request recovers
the same job, and native/stdio overview/detail captures are reviewed. Native
read-only acceptance confirms 16 current members/four groups, four water cells,
four solid bed cells, eight closed bank faces and no escaped water in the
footprint after native updates. All 12 backups are original grass (eight) or dirt
(four), path cells have no raised floor above, pad lies horizontally over actual
water and bank plants have solid support. Capture source/manifest/member hashes
and player/main camera remain stable. Eight guide/template checks, skill validation,
build and focused diff checks pass. Evidence out/rsi/089/{pond/report.json,
pond/full-job.json,pond/mcp-report.json,pond-check.json,tail-log.json}. Source/manifest
save explicit in fixture; no world saves, asset exports, project 530 changes or
deployment. Native water depth is one design meter. Goal active 89/100.

## Round 090 — same-site pond reshape with verified soil restoration

Ground-water guidance now gives the owned-pond revision order: resume at its
fixed origin, remove aquatic decorations before the basin, restore omitted soil
cells, preserve unrelated groups and save the complete revised generator. The
native revision harness applies this to creation-80's square pond without new
scouting or relocation. Creation-81 first checks all nine removed aquatic/basin
members against their original native snapshot fingerprints, then rebuilds a
three-cell L-shaped water surface and solid bed. Seven existing path/planting
members keep their fingerprints. The unused corner returns to original Grass
and Dirt; the remaining pond has 14 current members and ten ground backups.

Extended read-only native pond acceptance verifies the notched shape, three
water/bed cells, eight closed bank faces, horizontal pad, flush path and restored
unused soil. Fresh overview/detail images inspected; source/member/manifest
hashes and player/main camera remain stable during capture. A save-only correction
(creation-82) fixes a harness metadata substitution that initially landed in the
embedded generator rather than the result; exact saved source bytes now match
the complete canonical L-pond generator, followed by fresh readonly recapture of
the original completed revision job. No geometry is repeated for this correction.
Eight guide/template checks, skill validation, script syntax and focused diff
checks pass. Evidence out/rsi/090/{revision/report.json,revision/request.json,
revision/latest-job.json,pond-check.json,source-fix,source-check.json,tail-log.json}.
Explicit source/manifest saves only; no world saves, exports, project 530 changes
or deployment. Goal active 90/100.

## Round 091 — native compound doors with two-cell undo

Scene:door adds supported native wooden assemblies: closed 232/108 or open
233/109, integral local position, vertical orientation 1..4, solid ground,
occupied-target refusal and explicit replacement. Both cells fit/check before
writing and enter one native undo command. Ordinary shapes and doors share the
same first-write site revalidation, preserving automatic replacement before
construction and fixed origin thereafter. doorAssemblies and the geometry list
advertise it without adding MCP tools. Lazy doorway demonstrates two 1x2 m doors,
native timber frames, a tinted pane and a flush wood floor; skill/wiki/indexes
document native directions, native-pair fallback and the helper.

Initial creation-83 stops at a fixture-only pcall unavailable in normal CodeBlock
globals, after placing timber/floor. Removed test logic from the public generator
and moved rejection checks into native regression. Twelve rejected-input/support/
upper-occupancy cases leave every member and the empty lower target unchanged.
Partial source/manifest saved explicitly; creation-84 adds only the missing doors
at the existing origin. It completes, but its recorded result reports one pane
stale: native GlassPane template changes selector 0 to 2 as adjacent door geometry
appears. Verified template selectors 0..11 and extended existing derived-state
normalization to panes while retaining tint/ID and unknown selector changes as
conflicts. 85 native color/selector checks pass. Historical job results stay
unchanged; read-only review creation-85 verifies current scene and fresh images.

Native opening/replacement test proves one command with two changes, two-cell
undo/redo, final closed restoration and current neighboring pane. Fresh automatic
creation-86 has 31 current members/three groups; first-edit-door creation-87 also
passes. Repaired and fresh native views inspected. Capture hashes plus player/
main camera remain stable, and saved complete generator bytes match canonical.
18 native name checks, 13 scene regressions, eight guide/template checks, skill
validation, build and diff checks pass. Evidence out/rsi/091/{doorway,repair,review,
fresh/report.json,first/report.json,preflight-check.json,undo-check.json,color-check.json,
names-check.json,tail-log.json}. Explicit source/manifest saves; no world saves,
exports, project 530 changes or deployment. Goal active 91/100.

## Round 092 — compact native timber cottage with flush circulation

Added lazy timber_cottage: a 5x5 m unfurnished shell, 3 m walls, 3x3 m clear
interior, 5.5 m ridge and 1x2 m native entrance. Native timber, tinted wool,
glass panes, colored stairs/slabs, carpet and flowers give recognizable form
with 122 members in nine groups. Floor/path replace 27 original grass cells
with retained backups. No miniature exports or implicit persistence. Scene
composition routes to this example without expanding the root/tool catalog.

Creation-88 builds at an automatically scouted fixed origin. Read-only native
acceptance verifies all fingerprints/materials, twelve timber post cells, clear
interior/approach, native passable two-cell entrance, 28 roof stair directions and
seven lower-slab ridge cells. Initial entrance camera was half a block off center;
creation-89 corrects views at the same origin without rebuilding. Overview/detail/
side screenshots reviewed; door collision permits passage, but broadside door
appearance is not claimed to be a visually verified swing direction. The review
fixture accidentally saved its repair wrapper after saving canonical source;
save-only correction removes that second save. Exact saved source bytes now match
the complete corrected generator, with fresh readonly recapture afterwards.

Nine guide/template checks, skill validation, build and focused diff checks pass.
Native capture hashes and player/main camera remain unchanged. Wiki/indexes link
the native cottage acceptance. Evidence out/rsi/092/{cottage/full-job.json,
cottage/mcp-report.json,review/report.json,cottage-check.json,source-fix,
source-check.json,tail-log.json}. Explicit source/manifest saves only; no world
saves, exports, project 530 changes or deployment. Goal active 92/100.

## Round 093 — retain explicit full generators through later scene saves

Scene:save now promotes a supplied generator to the same object's default source
only after source and manifest writes succeed. This prevents a later no-argument
save from overwriting complete generators with short repair wrappers. New resumed
objects still require explicit complete source. Persistence guidance and native
wiki explain that scope and partial file effects; indexes link the regression.

Four native fake-writer checks verify explicit/implicit retention, optimistic
file preconditions, source-write rejection, manifest-write partial effects and
successful recovery without replacing the retained default on failure. A real
save-only CodeBlock job repeats the formerly failing cottage sequence: complete
generator saved explicitly then save() again. Exact native saved source bytes
match canonical; 122 members and fixed origin match round 092. Fresh readonly
captures retain source/member/manifest hashes and player/main camera. Thirteen
scene lifecycle checks, three lazy-guide checks, skill validation and focused
diff checks pass. Evidence out/rsi/093/{source-regression.json,source.lua,
native/report.json,native/latest-job.json,source-check.json}. Explicit source/
manifest writes only; no geometry changes, asset exports, world saves, project
530 changes or deployment. Goal active 93/100.

## Round 094 — door approach axes verified in native views

Resolved round 092's crosswise opened panel: native DoorWood closed data 3/4
spans Z and is intended for passage along X, while the cottage approaches along
Z. Data 1/2 instead closes across X and opens along Z. Updated cottage/doorway
examples to data 1, and lazy voxel guidance plus engine wiki document both pairs,
opposite opened offsets and preservation of direction while toggling. Eight
native template checks validate matching upper/lower models, facing and all
opened offsets without editing the world.

Same-origin cottage revision changes only its two entrance cells; 120 other
members preserve fingerprints, original soil backups remain, complete saved
generator bytes match canonical and read-only cottage acceptance passes all
122 members. Fresh entrance screenshot now shows the edge-on side panel and
clear interior. Fresh automatic doorway construction through the one stdio MCP
tool demonstrates closed panel across the opening and open panel at its side;
detail images reviewed. Native capture hashes and player/main camera remain
unchanged. Nine guide/template checks, skill validation, build and focused diff
checks pass. Evidence out/rsi/094/{direction-check.json,cottage-check.json,
revision-check.json,revision/report.json,doorway/full-job.json,doorway/report.json}.
Explicit source/manifest saves; no exports, world saves, project 530 changes or
deployment. Goal active 94/100.

## Round 095 — persistence includes restored, no-longer-owned terrain

Mixed-scene persistence harness accepts at most 200 integral local probe cells,
checks loaded terrain and manifest bounds, and compares their exact native
fingerprints across save/reopen. This covers restored cells omitted from current
membership. Lazy persistence guidance explains why owned members alone cannot
prove removed pond corners were restored. Snapshot schema stays unchanged for
older journals without probes; completed journals can perform current-session
read-only comparison without repeated save/open operations.

Seven scenes complete two explicit save/reopen cycles, sessions 16->18->20:
cottage, L-pond, native flower border, reading corner, dog, scaled plant animation
and two-bone human. Exact comparison covers 213 members, 33 groups, 62 first-ground
backups, two bones, four movies, nine actor inventories/tracks, two reused model
carriers, seven assets and two restored pond-corner layers. Reopened native
cottage/pond checks pass; fresh views and seven human clip-time frames pass.

A negative harness test inadvertently repeats two cottage save/reopen cycles:
duplicate scene names overwrote probe configuration, hiding an out-of-bounds
probe. Preserve that failed evidence; add upfront duplicate-name refusal.
Four corrected fractional/count/bounds/duplicate tests reject before save/open
checkpoints. Session is now 24. Read-only recheck of the complete seven-scene
baseline passes in that current session, followed by fresh cottage/pond/human
reviews with new identities. Current pond screenshot confirms restored notch,
flush path and containment; source/member/manifest hashes and player/main camera
stay unchanged during capture. Three guide checks, skill validation, script syntax
and focused diff checks pass. Evidence out/rsi/095/{persistence/report.json,
persistence/readonly-recheck.json,summary.json,probe-rejection-check.json,
reopened-native-check.json,current-cottage,current-pond,current-character,tail-log.json}.
Explicit disposable-world saves only; no rebuilding, exports, project 530 changes
or deployment. Goal active 95/100.

## Round 096 — reject nonexistent independent asset animation IDs

Isolated AssetCapture inspects the loaded native strAnimIds before posing. It
rejects missing requested IDs instead of allowing an engine fallback pose, and
reports verified animation ID metadata with a sorted list capped at 32, total
count and truncation flag. Unavailable native inspection explicitly reports an
unsupported capability; malformed/bounded metadata is rejected. This uses the
existing camera_capture action and native metadata without adding MCP tools or
requiring FFI. Visual guidance and engine wiki/indexes document the contract.

26 native capture checks pass, including unique/sorted IDs, bounded output,
requested IDs beyond the returned page, missing IDs, unavailable metadata and
malformed values. After round 095's world reopen, the exported 1.75 m human .x
loads independently at scale 1 through stdio MCP; 11 neutral PNG captures cover
both native idle/wave IDs, seven clip times, two extra yaw angles and repeated
fixed poses. Final bone rotations match source keys; pixel checks prove nonempty
opaque images, margins and identical repeated frames. Raised-arm image inspected.
ID 999 fails with no image. Source/member/manifest/player/camera remain unchanged;
all eleven controls plus failed-capture resources are cleaned, pending false.
Three guide checks, skill validation, script syntax and focused diff checks pass.
Evidence out/rsi/096/{asset-regression.json,asset/report.json,asset/image-check.json,
asset/missing-animation.json,cleanup-check.json,tail-log.json}. No edits, exports,
world saves, project 530 changes or deployment. Goal active 96/100.

## Round 097 — cheap metadata-only template discovery inside the existing tool

template_info supports a named lookup or a small discovery page: six curated
categories, case-insensitive AND query words, stable name ordering, default five/
maximum ten entries and offset/nextOffset. Discovery reads no source or directory
and returns neither hashes nor file paths; selected named lookup preserves the
existing source/hash behavior. Root/connection guidance and Keepwork documentation
route to this without new actions, tools, resources or skill files. Reuse roles,
asset writes and required capabilities remain visible before choosing a design.

Ten guide/template checks pass, including complete unique category coverage,
zero filesystem reads/scans, pagination, filters/empty results, prototype names,
invalid pages, mixed named/search refusal and no native jobs during discovery.
Build and skill validation pass. Real fresh stdio MCP verifies one Paracraft tool,
one root resource, three categories' pages, cat search, selected source hash and
native world session 24. Seven-scene read-only baseline remains exact.

Directly invoked Codex's actual installed paracraft_cli for clients/capabilities
and isolated exported wave capture: native image arrives inline, verified IDs
0/1 and height 1.75 m. Its persistent gateway still has the older named-only
template_info schema; new discovery is verified on the current built stdio
runtime, and guidance gives named lookup/reconnect fallback. No daemon restart
or bypass of the previous approval block. Evidence out/rsi/097/{discovery-report.json,
codex-direct-metadata.json,codex-direct.png}, plus 095/persistence/readonly-recheck.json.
Focused diff checks pass. No creation, exports, world saves, project 530 changes
or deployment. Goal active 97/100.

## Round 098 — asset review failures retain fresh evidence

Independent asset acceptance now atomically checkpoints a unique review ID,
world identity, current state and frame metadata. PNGs plus requested/native pose
information are saved before pose assertions, then each frame is marked verified
only after checks pass. Errors keep partial frames unverified with bounded text;
final reports bind to the review ID. No image bytes enter text/progress logs.
The pixel checker also matches frame counts, verified status, filenames and
native capture IDs against the current completed progress record. Lazy visual
guidance explains why an older successful report cannot approve a new failure.

Wrong expected idle rotation is injected only in a local test report. The native
world/model are untouched; one failed PNG and its metadata remain, marked false.
A previous eleven-frame success copied into that directory is rejected as
unverified. Fresh correct eleven-frame review then passes native idle/wave poses,
scale, ID checks, cleanup, pixel margins/background and repeated-pose stability;
side wave image inspected. Four additional proof tests reject frame-count,
verification, filename and capture-ID mismatches. Earlier eight-frame assembly
evidence remains compatible. Source/member/manifest/player/camera stay stable;
seven-scene read-only baseline passes and pending/asset control count is zero.
Three guide checks, skill validation, script syntax and diff checks pass.
Evidence out/rsi/098/{failure/capture-progress.json,failure-check.json,
success/report.json,success/capture-progress.json,success/image-check.json,
evidence-check.json,cleanup-check.json}. No mutations, exports, world saves,
project 530 changes or deployment. Goal active 98/100.

## Round 099 — exact bundled skills without obsolete subfiles

Shared creation-skill build plugin synchronizes its generated subtree exactly
instead of overlay-copying and retaining removed guides. Before recursive removal,
physical build root and target confinement are checked; linked parents/targets
and canonical-source overlap are refused. Failed compile results retain the last
successful skill copy, and unrelated build files remain untouched. Keepwork
documentation records the behavior and test command.

Four packaging tests pass: exact content/obsolete-file removal, failed-build
preservation, source-overlap refusal and linked-directory protection. Current
extension and Local Helper builds succeed; both contain exactly the canonical
65 skill files with matching SHA-256 values. A temporary CLI/skill copy outside
the checkout serves root, animal guidance, cottage source and template metadata
through real stdio MCP, with one Paracraft tool and one root resource. Development
NODE_PATH supplies external dependencies for this skill-relocation check; it does
not claim installer/native-dependency acceptance. Temporary artifacts removed.

Native audit checks fourteen creation-module dependencies, official creation/
scene-inspection registry pages and compiled-path/wiki coverage in three redist
manifests. This verifies rules, not release compilation or deployment. Evidence
out/rsi/099/{package-report.json,native-package-coverage.json}; tests and focused
diff checks pass. No client edits, exports, world saves, project 530 changes,
version bumps, daemon restarts or deployment. Goal active 99/100.

## Round 100 — asset readiness before animation inspection

Independent asset capture now waits for loading, validates renderable model
bounds, then inspects animation IDs. A loaded empty export reports
asset_geometry_empty instead of a misleading animation-inspection failure.
The lazy visual guide and authoritative native scene-inspection wiki explain the
repair path. Native capture regression adds unloaded, empty and flat nonempty
cases; all 29 checks pass. Empty bounds never trigger animation inspection.

Fresh real stdio MCP feedback verifies both exported idle/wave IDs in eleven
frames, exact requested poses, a 1.75 m character at scale 1, repeated-pose
stability and unclipped neutral-background pixels. Wave image inspected: readable
human silhouette and raised arm, still a simple two-bone example rather than a
complete walking rig. Source, manifest, members, player and main camera remain
unchanged; capture controls clean up and pending is false in world session 24.

Final broad checks exposed two old test loaders that did not load the launch
module imported by the shared client hub. Updated those test loaders to handle
their TypeScript dependencies; production imports are unchanged. The original
failed run is retained. All 31 Node MCP/CLI/packaging tests now pass, including
authenticated HTTP, stdio, poll images, request recovery, lazy discovery and
one advertised Paracraft tool/root resource. Standalone Lua checks pass: geometry/
scouting 9, scene/terrain/rollback 13 and routes/cancellation/dragging 8.

Both product builds succeed and exactly match all 65 canonical skill files by
SHA-256. Skill validation and both repository diff checks pass. Seven persisted
scenes still match the reopened baseline through a read-only recheck; no repeat
save/open. Evidence out/rsi/100/{asset-regression.json,node-tests-before.tap,
node-tests.tap,asset/report.json,asset/image-check.txt,cleanup-check.json,
package-report.json,tail-log.json} and 095/persistence/readonly-recheck.json.
No new construction, export, world save, project 530 change, version bump,
daemon restart or release deployment.

## Completion audit and practical limits

All 100 numbered rounds contain a maintained improvement and its verification.
The delivered workflow retains one advertised Paracraft CLI tool and one root
skill, with category discovery and guides/templates loaded on demand. Native
material architecture, restored terrain, miniature props, independent BMax/ParaX
assets, characters, animals, moving assemblies and vegetation are covered by the
rounds above. Round 95 supplies the final multi-scene save/reopen evidence;
rounds 96–100 verify independent animation feedback and packaging. Round 97 also
invokes the actual Codex tool and receives native image content.

The persistent running gateway still has the older named-only template_info
schema. Category discovery is verified in the newly built stdio runtime; use
named lookup until reconnecting to an updated runtime. No blocked restart was
bypassed. These are development builds and native acceptance results, not a
Marketplace release or installer acceptance. AIChat/live WASM acceptance remains
outside this first release.

Visual examples demonstrate editable representations, not universal motion
quality. The human wave uses two bones; the dog example has rigid legs without
IK. Fox binding fixtures use enlarged technical construction carriers and a
normalized meter-scale exported asset; do not treat that scaffold as a normal
scene-scale example. These limits remain documented in the relevant lazy guides.
Temporary Minecraft references inform economical construction; external
schematics/images/catalogs are not bundled into this skill.
