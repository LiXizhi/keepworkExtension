# Integrated scenes: layout, execution and acceptance

Use when several features must work together in one place, such as a wooded
settlement with roads, buildings and native controls. Load the relevant domain
guides from SKILL.md, but retain the current capabilities, official creation API
and action schemas through the task. Do not fetch the same reference again for
each tree or house. A world switch requires fresh identity and world instructions;
an engine/gateway change may require refreshing its API contract.

## Shared layout

Write a compact meter-based layout before construction: footprint/height,
entrances, road and courtyard elevations, tree locations, control ports and named
groups. Budget the rectangular volume including terrainDepth. For a compact
scene, scout the combined footprint once, then work in its fixed local frame.
Separately scouted templates do not automatically form a connected composition.
Use an inspected origin/site when integrating an existing design; larger scenes
follow the bounded tiling rules in [terrain-biomes.md](terrain-biomes.md).

Assign cells to components before layering them. Roads and house floors should
meet at the same supporting-ground height; a road must reach the actual doorway,
not just the plot edge. Keep raised relief away from ordinary flat routes unless
the layout supplies a deliberate gradient or steps. Place trees on the final
surface and keep crowns clear of roofs, doors and the intended camera views.
Reserve the circuit's support, connections and reachable inputs together, with
space between unrelated powered components. Miniature geometry owns whole carrier
cells; apparent visual separation does not let groups share a carrier.
Deduplicate repeated planned block cells within a group too: overlapping foliage
rings can raise `occupied target` even when both placements belong to your tree.
Use explicit replacement only for an intentional, inspected overwrite, not as a
blanket response to unknown occupancy. Validate generated positions, materials
and duplicate ownership before removing the existing component.

Use independently revisable names such as `house-west-roof`, `house-east-walls`,
`roads`, `relief-north` and `lighting`. Build support before dependents. Verify
one representative doorway, roof profile and control module before multiplying
them. Combine related writes in a single sequential creation job when practical;
keep failure-prone new mechanisms in a separately attributable stage.

## Less work per revision

Generate repeated geometry from parameters and deterministic fields. Merge
equal-material contiguous cells into box/surface spans where the result and
ownership remain equivalent; use halfBlocks/voxelBoxBatch only when capabilities
and the chosen representation support them. Whole-block bulk terrain should not
be expanded into miniature voxels. Helpers retain their edit checks and cooperative
yields; raw engine writes are not a performance substitute.

Before repainting an entire footprint, inspect whether existing ground already
matches the requested material and height. Leave compliant ground in place and
author only the needed roads, floors and terrain changes when ownership/restoration
requirements permit. Rewriting unchanged ground consumes helper work and expands
the manifest without improving the scene. Keep equivalent workload in performance
pairs; evaluate this sparse-write strategy as a separate comparison.
Budget height from the highest authored carrier, including crowns and roof cells;
camera eyes outside the build use `cameraPoint` and need not enlarge construction
bounds. Retain all terrain depth and clearance checks when reducing empty volume.

Inspect once at a meaningful stage and summarize before returning it. The native
`inspect()` includes every member; Keepwork's job summary primarily shortens
animation keys and does not make arbitrary group member arrays compact. Return
per-group count, bounds and stale total, plus fixed origin, artifact paths,
control ports and useful camera vectors. Keep full members for a diagnosed conflict
or a local evidence file. Do not invent `inspect({summary=true})`.

For example, adapt this return pattern inside a creation job:

```lua
local info=s:inspect() -- s is the current scene; inspect native members once
local groups,total={},0
for name,g in pairs(info.groups) do
    local stale=0
    for _,m in ipairs(g.members) do if m.stale then stale=stale+1 end end
    groups[name]={count=#g.members,stale=stale,bounds=g.bounds}
    total=total+#g.members
end
return {name=info.name,origin=info.origin,groups=groups,total=total,
    artifacts=info.artifacts} -- add requested ports and camera vectors
```

For a local change, inspect the target and its dependents, retain the origin,
then edit only that group. Compare unaffected native cells before/after rather
than claiming preservation from matching counts alone. Circuit simulation can
legitimately change Wire data, Lamp IDs and door states; investigate those stale
members separately instead of clearing fingerprints or rebuilding the whole scene.
If saving is requested, retain the complete updated generator rather than saving
only the repair wrapper; see [persistence.md](persistence.md).

## Partial failure and checkpoints

A failed creation job is not an all-or-nothing scene transaction. A helper rolls
back its own failed write; earlier successful helpers, including group removal,
can remain effective. Inspect the failed job and live native data before retrying.
`resume=true` loads the last saved manifest, which may predate those effective
changes. Stale members at that point are evidence to reconcile, not permission
to erase fingerprints, repeat the generator or force block writes.

When source/manifest saving is in scope, save the full generator and current
manifest at useful component boundaries, before proceeding to an independent
risky component. A checkpoint after a deliberate removal also records that the
component is presently absent; documentation must describe this partial state.
Native world saving remains separate and explicit. Do not assume the CLI exposes
a `resumeJob` or failed-scene save action; discover actual supported operations.

For owned test edits, native undo can restore the earlier state if you can bound
the exact operations being reversed. Check native cells against the saved
manifest, including newly added positions, after undo; do not undo past your edit
or claim that undo updates the manifest. If recovery cannot be established from
available evidence, preserve the failure and report the unresolved component.
Do not reopen an unsaved user world merely to clear the conflict.

## Acceptance and timing

Separate evidence for appearance, geometry, behavior and persistence:

- Fresh overview and player-height entrance/detail images establish appearance
  and visible clearance. Inspect the pixels. Counts do not establish visual quality.
- Check road continuity, doorway dimensions, support and obstructing carriers in
  native data. A clear-looking doorway does not alone prove player traversal.
  For slab approaches, inspect data orientation and actual native collision
  bounds: `solid=false` alone does not rule out support. Check the intended
  half-height top and adjacent elevation changes as well as overhead clearance;
  never accept an arbitrary slab ID as proof of a connected route.
- Native interaction and state observations establish circuitry. For
  `Enable AND (A OR B)`, check all eight combinations, reset and retrigger;
  use [circuits.md](circuits.md) for input handling and timing probes.
- When save/reopen is in scope, check fresh identity, actual blocks, source and
  manifest after reopening. Document/source writes alone do not save native blocks.

Measure preparation, scouting/building, inspection/captures, functional tests and
save/reopen separately. Record footprint, authored cells, helper calls, poll count,
failed calls and elapsed time beside quality findings. For a performance comparison,
hold geometry/materials/identity and readiness constant, verify equivalent native
results and restore owned probe edits. Repeat enough to distinguish startup/meshing
cost from the strategy being measured; report ranges rather than a universal speedup.
Functional wait times are part of the behavior test, not automatically wasted calls.

For creation-job elapsed time, use terminal job `finishedAt-startedAt` from the
same native clock. The creation code sandbox does not expose `ParaGlobal`;
do not insert native global clock calls into a generator to measure it. Transport
and polling elapsed time belongs in a separate metric. A mock must use the
actual creation sandbox surface; injecting engine globals can hide a native failure.

If a capture fails or is black, try the existing client's bring_to_front and a
fresh same-view capture as described in [visual-review.md](visual-review.md).
Recover the existing job; do not rebuild geometry to repair image delivery. Report
unverified appearance if recovery fails. Record actual coverage and unresolved
items in direct world docs, keeping runtime, documentation and native save states
distinct as in [world-memory.md](world-memory.md).
