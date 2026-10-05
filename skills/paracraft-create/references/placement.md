# Autonomous siting

Plan the scene at one block per real-world meter, using the 1.75 m player as the
scale reference. Choose realistic object dimensions before scouting; reserve only
the workspace needed for those objects and their controls/previews. Do not inflate
a building to fill an available site.

Budget the full rectangular footprint and height before scouting: main art,
overhangs, expanded model bounds, skeleton construction, movie controls, and
separate animated preview space. The two-block clearance margin is additional
to the requested construction volume. Reserve room for revisions.

The usual route is `createScene({name="...",dimensions={x,y,z}})`. With no origin,
the existing virtual pet scouts loaded terrain within 128 blocks of its starting
position. It checks level supporting ground, the full volume and entities, then
travels using checked walking/flying routes. It does not flatten, clear or load
terrain. The player stays put.

When composition benefits from a site review first, call `paracraft_cli` action `find_build_site`
with dimensions and identity, poll its job, inspect evidence/rejections/bounds,
and capture `nearPet:true`. Pass its returned `siteId` as `site` to `createScene`
with matching dimensions. Use exclusions to seek an alternative, not pet movement
as a way to shift an existing scene's origin.

`no_site` reports searched coverage and rejection reasons. Inspect those reasons:
reduce a genuinely oversized design, request a different authorized location, or
explain that the loaded neighborhood cannot accommodate it. Do not silently clear
occupied ground. Unknown terrain is not empty terrain.

Dragging pauses the pet; release causes route revalidation. Cancellation stops
where it is rather than snapping to the destination. If the pet is busy with an
unrelated task, wait. A task that starts during travel or a drag pause also stops
scouting with `pet_busy` at the current position; inspect the job and wait for that
task without cancelling it. Site validity is checked again before helper writes. Before
construction it may be replaced automatically; once construction has begun,
conflicts must be inspected in place. Resumed scenes retain their saved frame.

## Flush floors, roads and pools

For large relief or non-level ground, read [terrain-biomes.md](terrain-biomes.md).
The flat-site scout does not reshape hills, and `surface` always targets the
fixed ground plane; neither is a terrain-following road generator. Village and
street layout guidance is in [settlements-roads.md](settlements-roads.md).

The fixed scene origin is the first empty cell above the selected terrain. Thus
local y=0 is air, and local y=-1 is the existing supporting floor. Putting a road
or building floor at y=0 adds a raised block. For a flush surface, replace that
floor through `surface`. First opt in with `terrainDepth` (0 by default, maximum
16); it reserves the permitted depth below the original ground plane while normal
scouting still selects a level, empty site above ground.

```lua
local scene=createScene({name="courtyard",dimensions={8,5,8},terrainDepth=2})
scene:group("road")
scene:surface({position={1,0,1},dimensions={6,1,2},blockId=81})
scene:group("pool")
-- Surface water occupies the former ground cell, flush with the surrounding grass.
scene:terrain({position={2,-1,4},dimensions={3,1,3},blockId=76})
-- Optional deeper water stays within the explicit two-layer terrain allowance.
scene:terrain({position={2,-2,4},dimensions={3,1,3},blockId=76})
```

Native `Still_Water` is ID 76; flowing `Water` is 75. Plan a contained basin with
solid walls and a liner; keep liquids inside it and verify native behavior. Use
`blockId=0` with `terrain` to excavate a cell. Use the same uniform `color="#RRGGBB"`
for paintable terrain replacements. These helpers use whole blocks; use miniature
geometry above the ground for sub-meter trim rather than replacing part of a soil cell.

Terrain edits check loaded cells, edit permissions, entities and group ownership.
Unowned occupied cells must be solid supporting ground, without block entities;
unknown terrain or buried controls are rejected. Declare only the footprint and
depth actually needed. This is explicit terrain replacement, not automatic terrain
clearing during scouting. Local origin and original ground height remain fixed.

The first original snapshot of each modified cell is retained across further
replacements. `scene:remove("road")` restores the original terrain for that group;
then rebuild the group with `surface` or `terrain`. `save()` persists backups and
terrain depth in the world-local manifest, so `resume=true` can restore after a
reopen. Saving the world is still separate. If a generated member was manually
edited, removal/restoration refuses to overwrite it: inspect and resolve the
conflict first. Failed helper writes roll back their own partial changes, and
successful replacements/restorations participate in native undo. Older manifests
without original snapshots cannot recover pre-existing terrain retroactively.
