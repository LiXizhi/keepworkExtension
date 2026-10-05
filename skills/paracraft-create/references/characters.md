# Meter-scale voxel people

For a human, write the intended height first (normally 1.75 m). Use miniature
color voxels for limbs, face, hair and clothing; whole-meter cubes are too large.
Read [rigging.md](rigging.md) when making a new skeleton, and
[animation.md](animation.md) for MovieBlock keys and clip IDs.

`template_info` / `run_template` with `template:"mini_character"` creates a
1.75 m stylized person with colored clothing, eyes, a mouth, shoes, separate legs
and a waving right arm. Seven named RGB roles change appearance without copying
the generator. This is a two-bone starting character: legs and the other arm are
attached to the root, not independently animated. It exports a rest rig and a
standalone `.x` with embedded idle (ID 0) and wave (ID 1), and retains editable
construction groups, BoneBlocks and the authoring MovieBlock. A second MovieBlock
loads that file with only animation-ID keys, so verification cannot borrow the
source actor's bone keys. Source saving is opt-in and world saving is explicit.

The source actor batches its seven bone poses and two animation-ID starts in
one `keyframes` call; the template requires `keyframeBatches`. Keep ID starts in
the corresponding bone-pose frames so idle/wave intervals remain explicit.

## Small geometry, full-size joints

Keep visible geometry in named component groups and controls in another group.
`bindBone` assigns exact carrier membership; a single carrier cannot belong to
two moving parts. Plan limbs on different carrier cells at the same physical
scale, instead of enlarging the character. BoneBlock pivot offsets can place a
joint at a carrier boundary. For example, a control at `{1,1,1}` with offset
`{0.5,-0.125,0.5}` places the joint at `{2,1.375,2}` in local meters.

`exportVoxelX(file,{"body","right_arm"},{rig="controls",pivot={x,y,z}})`
expands miniature color geometry and persisted explicit membership onto the
native exporter's grid. Its controls stay in the skeleton and are omitted from
the visible mesh; dimensions and pivots are baked at meter scale. It rejects
automatic/missing/conflicting ownership, unbound geometry and parents outside
the rig. The specified pivot becomes the asset's origin, commonly at the feet.
Inspect the engine-owned documentation and capabilities before using it on an
older client. Direct `.bmax` previews still do not prove explicit membership.

To embed authored clips, add `animation={movie="wave",actor="character",
loops={[0]=true,[1]=false}}` to the export options. The source movie must belong
to the scene. See [animation.md](animation.md) for key and interval constraints.

Review rest pose, peak wave and return to rest from an independent camera. Check
the reloaded file at scale 1, native bone names/parents and final poses. A valid
quaternion is not proof of correct skin deformation: inspect the images for
detached arms, moving facial geometry or stray control cubes. Use named-group
revisions for an existing character; a new template request creates another one.
The template returns `portrait` and `side` cameras as well as context views.
Use `portrait` for time comparisons and `side` for shoulder/pivot depth; neither
is an isolated renderer, so inspect surrounding fixtures before accepting the view.
For a clean character image, use the isolated `camera_capture` asset option from
[visual-review.md](visual-review.md), selecting the independently exported clip
file. Sample idle ID 0 and wave ID 1 at local clip times; no source actor is used.
