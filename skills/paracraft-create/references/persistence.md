# Editable delivery and export

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

For revisions use `createScene({name=...,resume=true})`, inspect members, and
`openMovie` when reopening a timeline. Stale fingerprints mean someone changed
native content: inspect the discrepancy rather than overwriting it. Save a full
updated generator if a short patch script would no longer reproduce the asset.

For save/reopen acceptance, record the world identity and source/asset paths,
save via the native explicit world operation, reopen, rediscover the new session
identity, inspect groups/rig/movie and capture the reopened asset. Never do this
to an unrelated user's world merely to test the skill. Use a disposable world.

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
