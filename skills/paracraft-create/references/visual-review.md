# Visual feedback and correction

When capabilities include `sceneCameraPoints:true`, use
`scene:cameraPoint({x,y,z})` for scene-local camera eyes and targets, including
positions outside the construction footprint. It is a read-only conversion;
`toWorld` remains strict about authoring bounds. On older engines, derive the
conversion from two valid interior `toWorld` points as the existing examples do.
Read [camera-point-review.lua](../examples/camera-point-review.lua) for a compact
read-only review of a saved garden; replace its scene name before execution.

Use fresh `paracraft_cli` action `camera_capture` images for geometry and animation review.
Use `paracraft_cli` action `screenshot` when editor UI itself matters. Both return native MCP
image content. Metadata carries session/camera/time information; an unavailable
fresh image must not be treated as a cached successful capture.
Fresh captures temporarily hide the creation library's site bounds previews and
restore still-live previews afterward. User selection stays intact; there is no
need to wait ten seconds for the preview to expire before reviewing a build.

On Windows, a minimized client can stop world-image rendering. Use
`bring_to_front` once to restore its existing window mode, then retry the capture
with the same world identity; recover the existing job instead of rebuilding.

Choose views to answer concrete questions:

| View | What it establishes |
|---|---|
| reference-matched or main three-quarter | silhouette, proportions, focal hierarchy |
| rear or opposite three-quarter | hidden gaps, back completeness, intersections |
| detail close-up | miniature geometry, joints, color boundaries |
| rest and motion extreme | rig binding, pivots, limb clearance |

Visually inspect the image pixels. Structured scene counts confirm that objects
exist, not that they look right. If the host cannot expose image content to the
model, save the returned image locally and use the host's image-viewing tool;
report the limitation if no visual inspection is possible. Never print base64.

Check realistic scale using numeric bounds and the roughly 1.75 m player as a
reference: one authored block is one real-world meter. Include final exported
asset bounds; do not let camera framing or preview scaling hide oversized objects.

Compare each important feature to the brief/reference. Record a concrete finding
such as "roof is too shallow relative to the columns", the affected group, and
the next edit. Fix the largest mismatch first. Keep camera framing stable for
before/after comparisons. Do not invent numerical likeness scores.

For a standalone character, keep a full-body portrait and an opposite side view
separate from the scene overview. Frame the same camera across idle, clip changes
and motion extremes; leave space for the raised limb. Preview copies, movie
controls and nearby builds can obscure defects or confuse which model moved.
Choose another camera direction first; if clutter persists, report it and use an
isolated model render rather than treating a crowded frame as a clean asset view.
When capabilities report `isolatedAssetCapture`, use the same `camera_capture`
action with `asset:{filename:"blocktemplates/<export>.x",animId:1,timeSeconds:0.5}`
and the current `expectedIdentity`. Time is local to that clip, not the source
movie; do not combine it with `moviePosition`, world `eye/lookat` or pet presets.
It returns a neutral-background PNG, final native bone rotations, scale and meter
bounds without attaching a model to the world.
Verified asset feedback reports available animation IDs (at most 32), their total
count and `animationVerified:true`; a missing ID fails as `asset_animation_missing`
instead of showing a fallback pose. Engines without native animation inspection
return an explicit unsupported capability. Check final bone poses as well as IDs.
`asset_geometry_empty` means the loaded file has no renderable bounds; inspect
or repair its export instead of trying other animation IDs or rebuilding the
surrounding scene. Unloaded assets are awaited before either check.
Optional `yaw`/`elevation` are radians; `distanceMeters` frames the model and
`size` is 128/256/512/1024 (default
512). Confirm facing from the actual image: yaw 0 suits the miniature human,
but other models may use different axes. Keep framing fixed across times and
leave margins for moving parts. Continue using context views for placement;
an isolated image does not establish ground contact or surrounding clearance.
For a moving object assembled from several actors, check `isolatedAssemblyCapture`.
Use the same action with `assembly:{moviePosition:[x,y,z],timeSeconds:1.25}`.
It seeks movie time and freezes up to 16
world-local model actors together on a neutral PNG canvas. Optional `actors`
selects named parts; `yaw`, `elevation`, `distanceMeters` and `size` control framing.
Start by omitting `distanceMeters`: rigid parts use transformed bounds, animated
single-root rotation tracks use a full rotation envelope, and a padded perspective
fit chooses the distance. For compact_car, yaw 0.65, elevation 0.2 and size 512
produce stable centered views across roll/steering extremes without distance
guessing. Inspect `cameraPos.centerMeters`, `automaticDistanceMeters` and each
actor's `framingKind`. `rest_sphere` marks a multi-bone fallback, not measured
deformed mesh bounds; inspect extreme poses and adjust framing when needed.
Use an explicit meter distance for a deliberate close view. Do not combine
assembly with asset or a world camera. Returned actor positions are meters relative
to the first selected actor, whose absolute engine position is `originWorld`;
final bone poses are read back from the temporary clones. Native source timelines
remain editable. Generated color models are verified; attachments and arbitrary
deforming rigs need their own pose/framing checks. Continue world views for siting.
Read native final bone attributes for pose audits. Opening bone-editor variables
can create empty timeline containers; visual inspection must not manufacture
authoring changes. Check native member snapshots before and after repeated
captures, along with saved source/manifest, when validating this invariant.

For a multi-frame review, retain each image with its world-session identity,
capture timestamp, camera and pose metadata as soon as it arrives. Keep partial
captures marked unverified if a later check fails; saved images alone do not
prove the review passed. Recheck the original job rather than rebuilding the art,
and request fresh captures when retrying verification. Keep image bytes in image
files/MCP image content, not textual logs or progress records.
Give each fresh review its own ID and match the final report to that ID and
its verified frames. A previous successful report in the same output directory
does not validate the current partial or failed capture sequence.

Suggested stopping rule: after two revisions that do not improve the same feature,
reconsider the representation or reference rather than repeating cosmetic edits.
Scale review effort to the user's requested quality. A technical fixture can pass
transport/rig checks while remaining visually crude; label it accordingly.
