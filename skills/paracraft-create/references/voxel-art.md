# World blocks and exportable voxel props

Use native whole blocks for large world-scene masses. Boxes, lines, ellipsoids, spheres, cylinders
and cones can form architecture and stylized organic shapes. Plan overlaps
explicitly: destinations are occupied by default, and cells belong to named
groups. Build trim and body in separate non-overlapping regions where possible.

A block represents one real-world meter for authoring; `size=0.25` means a
25 cm voxel and `size=1/16` means a 6.25 cm voxel. Keep realistic object dimensions
and refine the voxel grid to fit details, rather than making the object larger.

Choose a grid according to the smallest important feature visible at the delivery
camera. Quarter or eighth blocks often carry more useful detail than a much finer
grid. The native colored-voxel representation supports powers of two through
1/512; that is precision, not a recommendation to fill entire buildings at that
resolution. Helpers cap expanded operations at the advertised voxel limit.
Estimate `(width/size)*(height/size)*(depth/size)` before dense operations.

Fractional geometry uses colors, not arbitrary ordinary block IDs. Adjacent
fractional cells share a whole-block carrier; keep such a carrier within one
editable group. Negative absolute coordinates are valid, but all local geometry
must remain inside the scene's fixed bounds. Grid rotation is in quarter turns
around Y; native model instances support continuous facing/pitch/roll and scale.

For BMax props and character bodies, use only ID 10 color blocks and miniature
color voxels. Keep BoneBlocks as rig controls and MovieBlocks as animation controls.
Do not export a mixed-material building group as the reusable prop.
Give repeated color-block props one construction group, export a world-local `.bmax`, and
place instances with `model`. Wait for readiness and inspect their actual bounds;
the carrier block's position is not the entire model's extent. Reserve lateral
room for centered/rotated props. Check both close and final-distance captures:
details that disappear at delivery scale should not consume most of the budget.

For a revision, inspect stale members, choose the affected group, and use explicit
replacement or removal. Avoid replacing an entire scene to change one trim color.
See [revision.lua](../examples/revision.lua). Export a new asset filename when
revising an exported prop; existing output files are not silently overwritten.

## Choose a world-scene palette

Start with a few native blocks that match the scene's construction, then use
color cubes for custom masses and miniature accents where they add value.
Native shapes provide thinner rails, usable steps, sloping roof edges and glass
without building every feature as a full cube. These are verified registry names
and IDs; check the installed engine's `block_types.names` and `block_types.get`
before using them. This is a starter palette, not the complete block catalog.

| World feature | Registry name / ID | Placement notes |
|---|---|---|
| Custom cube masses | `ColorBlock` / 10 | Use `color`; also the only geometry for BMax/characters |
| Colored railings | `ColorFence` / 267 | Use `color`; inspect native joins |
| Colored low walls | `ColorWall` / 268 | Use `color`; inspect joins with adjacent blocks |
| Colored steps | `ColorBlock_Stairs` / 280 | Use `color`; select orientation/corner variant |
| Half-height trim | `ColorBlock_Slab` / 281 | Use `color`; select upper/lower placement |
| Sloped roof edges/ramps | `ColorBlock_Slope` / 282 | Use `color`; select direction/shape |
| Textured wooden floors | `Oak_Wood_Planks` / 81 | Native texture; do not attach arbitrary color data |
| Tree trunks/posts | `Oak_Wood` / 98 | Native wood texture; inspect axis/orientation |
| Foliage | `Oak_Leaves` / 86 | Native textured/alpha-tested leaves, not a solid green cube |
| Textured masonry | `StoneBrick` / 68 | Native stone-brick texture |
| Glass panes / glazing | `GlassPane` / 102; `Glass` / 95 | Pane accepts `color`; glass cube uses its native texture |
| Wooden window/shutter | `Trapdoor` / 108, open 109 | Native WindowWood model; orientation, support and open state |
| Wooden door | closed lower 232 + upper 108; open lower 233 + upper 109 | Two-cell vertical assembly; matching orientation data |

Prefer a coherent palette: for example wooden plank decking, timber posts,
colored railings/stairs, sloped trim, glass openings and native leaves. Use
material contrast deliberately; avoid mixing many unrelated textures. Other
wood species, masonry, plants and decorative blocks exist: resolve their exact
registry names/IDs from the installed engine instead of guessing Minecraft IDs.

## One color format

Use `color="#RRGGBB"` consistently for every paintable block, including plain
color cubes, fences, walls, stairs, slabs, slopes and tinted panes. The creation
library converts RGB to each block's native representation. You do not need to
pack colors or know storage widths. A native palette may approximate the requested
RGB, so confirm the visible result. Textured wood, leaves and masonry use their
own material; omit `color` when the selected block does not support painting.

```lua
scene:group("railings")
scene:line({from={2,1,1},to={10,1,1},blockId=267,color="#aa7744"})
scene:group("entrySteps")
scene:line({from={5,0,0},to={8,0,0},blockId=280,color="#aa7744",data=0})
scene:group("roofTrim")
scene:block({position={1,7,1},blockId=282,color="#338899",data=0})
```

`data` chooses the native orientation/shape variant where needed; `color` sets
its tint while preserving that variant. Omit both for a textured block's default
appearance. Advanced scripts may still supply native packed `data` without a
`color` override. `rotation` rotates a helper's geometry coordinates; it does not
automatically orient each native stair, slope, door or log. Choose orientation
using the block's native class and inspect from the approach direction. Use
`block:RotateBlockData(data,angle,"y")` to obtain a rotated existing variant;
then pass it along with the same uniform `color`. Do not assume every block
class uses the same direction numbers or shape variants.

Creation helpers write explicit blocks rather than using the inventory item's
placement UI. Assemble multi-cell objects deliberately: a closed wooden door has
lower ID 232 and upper ID 108 directly above it, both with the same vertical
orientation data (native values 1..4). Reserve both cells and check their support.
A raw lower-door placement does not automatically reproduce `ItemDoor:TryCreate`'s
upper-window placement. Verify support-dependent windows, doors, foliage and
fence joins after all neighboring blocks are present. Use named groups and helper
replacement/removal so revisions retain bounds, stale checks and undo behavior.
