# Half-block geometry and stair direction

Use for stairs, steps, seats, roof edges and half-height native surfaces. Paracraft
already supports 1/2 color voxels; engines with `nativeHalfBlocks:true` also
translate half-grid occupancy into native full blocks, slabs and stair variants.
Read current engine `creation.md`. This is world scenery, not BMax geometry.

The player-facing VoxelModelBlock tool (289, also called VoxelBlockModel) supports
the same native shape conversion at toolbar size 1/2. Users can sculpt supported
native stairs/slabs or fill their empty half-cells; each completed gesture compiles
matching geometry to native block IDs/data with ordinary undo/redo. Picking and
miniature copying use actual occupied halves. Existing material is preserved;
new air cells use colored blocks. Finer/multicolor/unmatched shapes remain voxel
models. Consult engine `voxel-model-tool.md` for controls and supported families.
This includes native transparent color and metal stairs/slabs. Fine edits decode
the original stair/slab shape before converting it to voxels; their empty halves
remain empty. Native 1/2 results retain the source material family and color data.
Voxel fallback represents colors without transparent or metallic shading.

## Describe solid geometry instead of native data

```lua
scene:group("entry_steps")
scene:halfBlocks({blockId="StoneBrick",boxes={
    {position={1,0,1},dimensions={3,0.5,1}}, -- continuous low tread
    {position={1,0.5,1.5},dimensions={3,0.5,0.5}}, -- high half at +Z
}})
```

This produces three native StoneBrick_Stairs rising toward +Z. Give the batch a
base material and optional `color="#RRGGBB"`; omit `data`. Coordinates are local,
Y-up, and positions/dimensions align to multiples of 0.5. Every half sample is a
0.5 x 0.5 x 0.5 cube; straight stairs use six samples, outer corners five and
inner corners seven. Inverted and sideways variants use corresponding rotated
occupancy. The converter recognizes every built-in stair/slab data variant.
A single half sample is not itself a stair. `boxes` contains 1..512 geometry-only
boxes; the total scan is limited to 65,536 samples. Geometry `rotation` is still
a quarter-turn about the given local anchor; rotating the occupancy now derives
the destination block's direction as well.

| Desired solid shape in one carrier | Half-grid description | Native result |
|---|---|---|
| Lower half | Full X/Z footprint, y=0..0.5 | Lower slab |
| Upper half | Full X/Z footprint, y=0.5..1 | Upper slab |
| Straight stair rising +X | Lower half plus upper x=0.5..1 | Stair data 1 |
| Straight stair rising -X | Lower half plus upper x=0..0.5 | Stair data 2 |
| Straight stair rising +Z | Lower half plus upper z=0.5..1 | Stair data 3 |
| Straight stair rising -Z | Lower half plus upper z=0..0.5 | Stair data 4 |
| Corner rising +X/+Z | Lower half plus upper x=0.5..1, z=0.5..1 | Stair data 5 |
| Side half | Full Y footprint, positive/negative X or Z half | Side slab |
| Complete cube | All eight half samples | Base full block |

The table is for interpreting readback, not numbers the AI has to guess. For an
entrance, put the high half toward the doorway/landing. For a seat, the high half
is the backrest, so put it away from the seating approach. Opposite benches need
opposite high halves. For a pitched roof, both slopes rise toward the ridge.
Do not use camera-relative "left/right" to encode world geometry.

Supported material families are ColorBlock, TransparentColorBlock, MetalBlock,
StoneBrick, Cobblestone, Sandstone
and Oak/Spruce/Birch/Jungle_Wood_Planks with their corresponding slabs/stairs.
Pass the full material or an ID/name from its family; do not map unrelated Stone,
logs, leaves or flowers into a different texture. For paintable native shapes,
the native 8-bit palette may approximate RGB; inspect the result.

For a simple supported textured box, `scene:box({size=0.5,...})` uses the same
conversion automatically. Lower slab then an adjacent upper half can be added
sequentially within the same named group. For a complete complex shape, prefer
one halfBlocks batch: each carrier is classified after all its samples are known.
Default overlap fails; `replace=true` permits repeated solid samples, but does
not erase omitted geometry. To change a stair's direction, inspect/remove its
owned group then rebuild the intended shape. Foreign occupied carriers, other
groups, stale edits, unsupported materials and out-of-bounds writes remain errors.

Exact native full/slab/stair shapes include corners, inner corners, upside-down
and sideways stairs, covering 35 distinct masks across stair data 0..29 and slab
data 0..5. Native 0 aliases stair 1; native 9 is a cube and uses the full block.
A single half-grid mini cube and patterns outside this catalog remain color
microvoxel carriers when the batch uses ColorBlock; unsupported masks for other
materials fail before any write.
There is no silent conversion to a larger stair or different material. `halfBlocks`
returns nativeShapes counts (full/slab/stairs/voxel) to distinguish the outcomes.
Fallback microvoxel carriers still collide as whole carrier cells; use exact
native stair/slab conversion when walking clearance must follow the visible shape.

## Keep exportable color voxels distinct

`size=1/2` ColorBlock geometry and `voxelBoxes` keep their existing microvoxel
representation by default, including eight differently colored halves. BMax/ParaX
visible geometry continues to use ColorBlock/microvoxels only. For world color
shapes, opt into conversion with `halfBlocks({color=...,boxes=...})`, or a single
shape's `nativeShapes=true,size=0.5`. Do not enable it in an exportable character
or prop group. Fine or differently colored voxel carriers cannot merge into a
single uniform native stair and are rejected by the conversion helper.

## Review the functional shape

Check native ID/data and a fresh low/side view: the approach must meet the low
tread, the high half must contact the landing/backrest/ridge, and paired benches
must face their usable space. Confirm player-scale walkability at entrance steps.
An overhead image may hide an incorrectly facing riser. Preserve the main player
and camera; use independent captures. Existing wrong-direction groups are revised
in place, not moved/recreated elsewhere. Record the generator/group coordinates
and actual verification using [world-memory.md](world-memory.md).

Older engines without nativeHalfBlocks still support explicit native block data
and ordinary ColorBlock `size=1/2`; report the missing conversion capability and
use the verified table for a chosen native straight stair, not an invented helper.
