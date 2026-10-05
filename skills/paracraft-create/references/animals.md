# Animated small animals

Load this guide for bees/birds, rabbits, cats/dogs and other small creatures;
read [rigging.md](rigging.md) only when a part needs articulation and
[animation.md](animation.md) for native MovieBlock tracks. World plant/material
palettes do not apply to animal BMax/character geometry: use color voxels only.

## Silhouette first, at animal scale

Write intended body length/height/wingspan in meters. Real insects are measured
in centimeters: use fine voxels and a close camera, not a meter-wide insect.
The large hover-bee example is a stylized toy, not the default species scale.
A small bird is commonly 0.2–0.5 m long,
and a rabbit roughly 0.3–0.6 m body length, depending on the requested species.
Use miniature voxels, not several whole meters per limb. Recognizable features
matter before voxel count: bee stripes/paired wings, bird beak/tail, rabbit ears/
haunches. Use 3–5 coordinated color regions and a readable neutral pose.

## Choose and verify movement

- Rigid motion: hover/bob, glide or toy-like hopping can use actor position/roll
  keys on a verified standalone model. Describe it as whole-animal motion;
  it does not demonstrate flapping wings, walking legs or a deforming spine.
- Articulated motion: wings, legs, ears/tail need named bones and verified native
  hierarchy/binding. Check each joint alone before combining a gait. Left/right
  wing motion mirrors angles, not necessarily quaternion components: check poses.
- Separate rigid wings can use color-only meshes with `exportVoxelX` local pivots
  and a `root` bone on each actor. Place joint origins against the body's bounds;
  mirror angles and query both final rotations. This does not create a skinned
  multi-bone asset or embed animation IDs; retain the editable MovieBlock.
- Timing: use a restrained idle, an obvious action, and matching loop endpoints.
  Inspect rest, strongest pose, transition and end from the same camera.

Do not declare animation from a successful job or a different timestamp alone.
Compare actor positions/bone transforms and visible poses at multiple times.
For a hop, check grounded start/end and the apex; for a bird, check both wings
at extremes and that the body remains attached. Stop persistent playback when
verification ends so the chat can edit sequentially.

## Standalone asset gate

Lazy `trotting_dog` is a small floppy-eared dog, about 0.55 m nose-to-rump and
0.44 m tall, with cream muzzle/paws and a colored collar. Three color-only assets
are reused by the body, four rigid legs and a tail. Its MovieBlock has a one-second
idle and two-second trot in place, with diagonal leg phases and conservative
toe clearance between keys. Stance feet lift slightly; this is a stylized gait.
Verify rest, intermediate and extreme foot corners as well as
hip/tail contact. It has no knees, forward travel, terrain IK or embedded clip IDs.
Read [trotting-dog.lua](../examples/trotting-dog.lua) only for geometry changes.

Lazy `sitting_cat` is a small seated tabby with pointed pink-centered ears,
pale front legs/paws, muzzle, green eyes, side stripes and a curved dark-tipped
tail. It is about 0.59 m including the tail and 0.45 m to ear tips. Two rigid
color-only assets and a two-second tail-yaw idle retain editable MovieBlock keys;
the body stays grounded. This is not a walking/skinned cat or one embedded clip.
Verify both tail extremes and joint contact from side/rear views. Read
[sitting-cat.lua](../examples/sitting-cat.lua) only when changing geometry.

Lazy `hopping_rabbit` is about 0.45 m nose-to-tail and 0.47 m to ear tips.
Four cream paws, rounded head/haunches, small tail, pink muzzle and separate
upright ears establish its silhouette. Three color-only meshes retain editable
MovieBlock keys: idle spans 0–2 seconds and a toy-like rigid hop spans 2–4 seconds,
with a 0.125 m apex at 2.5 seconds. Ears tilt independently; the legs do not bend.
Its three actor batches retain 33 poses while using three `keyframes` calls,
avoiding a MovieBlock snapshot/undo command for each individual frame.
This is not a skinned gait or one file with embedded clip IDs. Verify grounded
start/end, hop apex and unchanged ear joint offsets. Load
[hopping-rabbit.lua](../examples/hopping-rabbit.lua) only for geometry changes.

Packaged `idle_fox` uses 1/64 m color voxels for a stylized young fox, approximately
0.75 m from nose to tail and 0.44 m to ear tips. Pointed ears, cream muzzle/chest,
four separated dark paws and a cream-tipped bushy tail define its silhouette.
Query `template_info` for four RGB roles, then `run_template` to avoid copying Lua.
Its two scale-1 meshes and editable MovieBlock animate tail yaw ±25° over two
seconds; legs remain planted. This is a rigid tail idle, not walking or a single
skinned animal with embedded clips. Read [idle-fox.lua](../examples/idle-fox.lua)
only to customize geometry. Verify joint attachment, both sway extremes, loop
closure and an independent close capture before describing the animation.

Use packaged `skinned_fox` when one independently animated file is needed.
It retains six BoneBlocks and explicit whole-carrier bindings for body, four legs
and tail. A 32x technical construction is baked by 1/32 into a ~0.78 m long,
0.44 m high `.x`; independently reload at scale 1. Source and verification movies
remain editable. Embedded ID 0 is tail idle; ID 1 is a looped diagonal-pair trot
in place with compensated toe clearance and swing-foot lift. This is a stylized
rigid-limb cycle, without articulated knees, forward travel or terrain-adaptive
foot IK. Inspect both IDs, the four leg extremes, actual native pivots/parents
and foot corners before revising it. [skinned-fox.lua](../examples/skinned-fox.lua)
preflights all controls against planned geometry and assigns each carrier once,
including intersecting haunch voxels, so a carrier cannot have multiple owners.
For dense animal blueprints, merge neighboring color rows into rectangles only
when their color and carrier owner match; this reduces helper calls without
crossing skin bindings. Compare the complete voxel/color/owner map before and
after compression, then verify exported poses. The shared fox source uses this
method; do not replace it with thousands of separate voxel writes.
The technical source needs a 30 × 16 × 30 m clear site; prefer `idle_fox` when
only a small tail idle is needed. Do not enlarge the delivered animal to simplify
native BoneBlock placement. Four palette roles are discovered lazily.

Packaged `curious_fox` shares that source but adds a seventh, explicitly bound
`head` bone. Idle ID 0 turns muzzle, eyes and ears together by ±25° while body,
paws and neck base stay rooted; stepping ID 1 keeps the head forward. Native
captures verify head parent/pivot/quaternion and the unchanged leg-clearance
checks. Review both turn extremes for neck gaps and accidentally moving shoulder
or chest carriers. Use `template_info` for the selected variant's hash: switching
variants changes source identity. Load the shared example only when changing
geometry; no additional root skill or advertised MCP tool is required.

Check geometry after an independent reload at scale 1. A positive loaded flag is
insufficient: require finite, nonempty model bounds and a visible silhouette.
Record actual bounds in meters and distinguish source construction extent from
final asset extent. A preview scale does not normalize the exported file.

The current generic BMax block-template route can represent miniature carriers
as nested BlockModel references. Such a world template may restore components
but load with **empty geometry as a MovieBlock actor**. Do not use that template
as proof of an animated small animal. The helpers report `asset_geometry_empty`
and pose captures report `pose_geometry_empty` for this case. Keep the editable
source and choose a verified single-mesh export route; do not enlarge the animal
or silently drop fine geometry to make the test pass. Articulated animated ParaX
must also be independently loaded and checked for geometry, scale and clip IDs.

For rigid miniature animals, use `scene:exportVoxelX(filename,group)` to produce
a single renderable color mesh with intrinsic meter-scale dimensions. It supports
whole ColorBlocks and identity miniature carriers, rejects other materials/bones,
and preflights the uniform-grid expansion against the cell limit. It preserves
editable source; it does not embed articulated clips.

[hover-bee.lua](../examples/hover-bee.lua) exports a 0.75 × 0.5 × 1 m color-only
mesh, reloads it at scale 1, and authors a two-second whole-animal hover in a
MovieBlock. It explicitly writes a uniquely named `.x`; saving the world/source
is separate. Inspect five times with a fixed camera, actual positions and model
bounds. This is a stylized large bee, not a realistic insect or wing-flapping rig.

[flapping-butterfly.lua](../examples/flapping-butterfly.lua) uses 1/128 m colored
voxels for a ~12.5 cm wingspan and 6.25 cm body. Three independent scale-1 meshes
form a patterned body and two wings; each wing rotates around its inner edge with
mirrored 20° → 70° → 20° → −10° → 20° keys over one second. Sample the transition
as well as extremes. Check both joint positions, exact part dimensions, matching
loop rotations and native final quaternions; a saved key is insufficient.
Use a close overhead/oblique view to see small animals. Prefer exported local
pivots over enlarging the animal just to expose articulation. For rigid parts,
read [moving-objects.md](moving-objects.md).

[flapping-bird.lua](../examples/flapping-bird.lua) builds a ~31 cm long garden
bird with a round torso, contrasting head/breast, beak, dark eyes and small feet.
Two tapered wings have dark feather tips; a separate tail pitches gently as the
wings flap. All four actors share the same restrained rise/fall so their origins
stay attached. Verify relative joint offsets in meters against the body as well
as each part's final rotation and scale. A correct rotation does not prove a
connected rig. This example keeps four rigid assets and the editable movie;
it does not export one skinned character or embedded clips.

For small airborne subjects, choose a close downward oblique independent camera
so ground fills the background and neighboring fixtures do not compete with the
silhouette. Keep enough side view to read the beak, eyes and wing thickness;
do not move the player or clear existing art to obtain a clean review frame.

Packaged `bird` and `butterfly` designs accept named RGB palette overrides through
`run_template`; query `template_info` for supported roles. For a blue garden bird,
use cool body/feather colors, a light warm breast and dark feather tips, retaining
dark eyes and a contrasting beak. This changes color regions without copying or
rewriting geometry. Review the new palette at rest and wing extremes; do not spend
fine-voxel detail on distinctions that disappear at the final view distance.
