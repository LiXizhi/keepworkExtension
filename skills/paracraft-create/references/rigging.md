# Native BoneBlock rigs

Build visible character geometry only from `ColorBlock` (ID 10) and miniature
color voxels. Native fences, stairs, slopes, leaves, glass and doors belong in the
surrounding world scene. BoneBlocks define the rig; MovieBlocks control animation.
Read the engine's current rigging APIs before coding. BoneBlocks encode native
direction and level; parent selection and color binding are resolved by native
rules, not arbitrary scene-graph parenting or generic mesh weights.

1. Lay out the rest-pose voxel character and moving-part regions. Name bones for
   their intended function and keep construction blocks editable.
2. Use `bone` with integral local positions, a direction/level and optional pivot.
   Pivot offsets use local block units, limited to half a block. `parent` is a
   validation request for native resolution; it does not force an impossible tree.
3. Call `rig(group)` and inspect the resolved names, parents, pivots and binding
   information. Reject duplicate names, missing intended parents or cycles.
4. Export the rig group as BMax, wait for its actor to load, then exercise one joint
   at a time. Use native color binding deliberately: identical-looking colors can
   influence ownership, and geometry proximity alone is not a binding guarantee.
5. Inspect rest pose and an extreme pose. If the wrong part moves, fix the native
   binding/parenting before polishing keyframe timing.

Start a complex rig with a small verified chain, then add limbs. A simple two-bone
fixture is provided in [idle-wave.lua](../examples/idle-wave.lua). Its root/arm
layout demonstrates native parenting; it is not a fully modeled humanoid.

When editing a pivot or hierarchy, revalidate the rig and regenerate affected
exported assets under a new filename. Never assume an old `.bmax` or `.x` has
changed because its construction blocks changed.

Default a human character to approximately 1.75 m tall, rather than several whole
blocks per limb. Use miniature color voxels for the body and limbs. Native bones
must occupy integral cells: if a larger construction rig is necessary, record its
source dimensions and normalize the final exported asset to the intended meter
size. A larger technical rig fixture is not a production character. Preserve bone
pivots, root motion, attachment positions and animation translations consistently
when rescaling; verify the standalone `.bmax` and `.x`, not just a scaled preview.
