# Editable delivery and export

Always maintain the world's AGENTS.md and flat docs pages after effective edits;
see [world-memory.md](world-memory.md). Record unsaved native changes explicitly.
This documentation step is separate from source/manifest, asset export and world save.

The scene manifest records named groups, membership fingerprints, fixed origin,
bounds and model/movie references. Native blocks remain authoritative. `save()`
writes source and manifest; saving the world is a separate explicit operation.
Export is separate from both. Publishing is never implied by asset creation.

Before BMax or character export, inspect group membership: visible geometry must
contain only color blocks/miniature color voxels, with BoneBlocks as rig controls.
Keep native world-scene materials in other groups; export only the asset group.
For an exported deliverable, retain the construction groups and rig/movie blocks.
Use world-local `blocktemplates/<name>.bmax` and `.x` outputs. After export, load the
asset independently at a planned preview position and verify its scale, rig and
each requested clip. A successful file write alone is not export acceptance.
`modelDefaultFacing:true` makes omitted model facing zero radians; older clients
may use the main camera's direction. Pass explicit radians when reproducing an
oriented layout across versions. [model-direction-review.lua](../examples/model-direction-review.lua)
compares the default and opposite direction with two ready scale-1 instances.

For revisions use `createScene({name=...,resume=true})`, inspect members, and
`openMovie` when reopening a timeline. Stale fingerprints mean someone changed
native content: inspect the discrepancy rather than overwriting it. Save a full
updated generator if a short patch script would no longer reproduce the asset.
Pass that generator explicitly to `save(fullGeneratorSource)` in a repair script.
Updated clients retain it for later `save()` calls on the same scene object;
on older clients, omit a second no-argument save that could overwrite it with the
repair wrapper. A new resumed scene should again receive the complete generator
explicitly. A failed file save can leave a partial file effect; inspect the
error and current files before retrying, without repeating geometry edits.

For repaving, resume the scene and select the original floor group, then call
`surface` on only the affected owned cells with the new material. Keep fixtures
and plants in their own groups. Repeated painting retains the first soil backup;
do not remove/rebuild the whole garden just to change a path. Check unchanged
neighboring members and save the full generator with the updated material.

`remove(floorGroup)` restores that group's first captured ground, including after
several repaints. It affects the entire group; use separate floor/path groups
when they need independent restoration. Keep native fixtures in other groups,
inspect restored support, then repaint if needed. Read
[floor-restore-cycle.lua](../examples/floor-restore-cycle.lua) for a checked
restore/repaint cycle on the existing 7 x 7 m garden. It is a revision example,
not a new-site generator; replace its scene name and review its fixed footprint.

After native undo, inspect again: the manifest may describe the later state and
report restored cells as stale. Native data remains authoritative. Redo restores
the recorded state; otherwise reconcile the affected design explicitly before
further helper edits. Do not erase stale fingerprints. Undo refuses targets that
were edited after the command, preserving the newer native content.

With `modelContactRemoval:true`, `remove(group)` can clear unchanged owned model
carriers that originally contained air, even beside another unchanged owned model
(such as a tabletop lamp). Foreign or manually changed neighbors remain protected.
Rebuild that group at the fixed origin and save the updated full generator;
do not relocate the remaining scene to work around an obstruction.

For save/reopen acceptance, record the world identity and source/asset paths,
save via the native explicit world operation, reopen, rediscover the new session
identity, inspect groups/rig/movie and capture the reopened asset. Never do this
to an unrelated user's world merely to test the skill. Use a disposable world.

Entered status can precede complete terrain/entity readiness. After reopen,
wait for the relevant loaded members and exact snapshots to stabilize before
calling differences a persistent edit; retry bounded read-only observations,
not save/open/build mutations. For mixed-scene acceptance, compare source,
manifest, first-ground backups, native bone/movie data and asset hashes, then
reopen movies and inspect fresh poses with the new world identity.
When a revision removes terrain members, also check the restored cells that
no longer appear in the manifest. For a reshaped pond, verify the omitted
corner's original grass/soil layers after reopening, together with the remaining
water bed and bank containment. Matching owned-member fingerprints alone does
not prove removed terrain was restored and persisted.

With `creationModelReferences`, read `inspect().models` for reused model filenames,
scale, local-meter offsets and readiness. Include these dependencies in delivery
and reload checks, even if no new asset was exported. An absent `artifacts` entry
does not mean the scene has no model files; missing entities/assets require review.

Check a second save/reopen when validating dense animation: repeated native float
rounding can cause drift that a single reload misses. Updated TimeSeries items
preserve finite track values exactly, but older saved tracks may already have
lost precision. Do not clear stale fingerprints or rerun an entire generator
merely to hide a mismatch; inspect the affected member and revise deliberately.

Delivery should name the scene, exported files, editable source, captures used,
verified clips, and any unresolved visual or runtime limitations. Keep concise
technical evidence separate from claims about aesthetic quality.

Before delivery, verify exported `.bmax` and `.x` dimensions in the same authored
meter scale as the scene (one block = one meter; player about 1.75 m tall). Record
intended and measured width/height/depth. Reload at the documented default scale
and compare with a measured reference. An oversized file is not fixed merely by
showing one instance at a tiny scale: correct the source or normalize the export
so the asset can be reused at the intended size. Verify pivots, root motion and
animation displacement after normalization. Describe an intentional alternate
scale explicitly when the user requested it. Internal engine world/camera units
must still be converted with the native block conversion APIs.

`exportVoxelX` with `scale` and capability `voxelExportScale` bakes an explicit
technical-rig normalization into the file. Its result `bakedScale` differs from
the independent instance scale, which remains 1. Validate native capture bounds,
`bones[].pivotMeters` and `translationMeters` at a moving clip time; checking only
the mesh height can miss unscaled joints or root motion. Bone-key translations
are already authored in local meters by helpers; do not convert them a second
time with `scene:toWorld` or the native block size.

For miniature color props used as standalone MovieBlock actors, prefer
`exportVoxelX("blocktemplates/<unique>.x",group)` over a nested world template.
This writes a single color mesh with intrinsic scale, preserving source blocks.
Without a rig/animation option it exports a static mesh; the surrounding MovieBlock
retains actor motion. With explicit rig membership and `animation`, it embeds
bone clips for independent animation-ID playback; see [animation.md](animation.md).
Uniform-grid expansion
can be larger than the source octree: keep within the advertised cell limit.
