# Native ground and water

World terrain materials; Paracraft registry IDs, not Minecraft numbers.

| Registry name / label | ID | Visible material and placement |
|---|---:|---|
| Grass | 62 | Green top over brown dirt sides; lawn/meadow supporting ground |
| Dirt | 55 | Brown earth on all faces; bare soil and pool bed |
| Sand | 51 | Pale sandy grain; beach/desert patches |
| Gravel | 12 | Gray mottled aggregate; gravel paths and banks |
| StoneBrick | 68 | Gray rectangular masonry pattern; paved paths |
| Sandstone | 4 | Pale sandy stone; warm stone structures |
| Snow | 52 | Snowy white top over dirt sides; snowfield supporting surface |
| Snow_Block | 5 | Snow texture on all faces; snow banks and mountain caps |
| Ice | 17 | Transparent slippery solid ice; frozen surfaces, not water |
| Still_Water | 76 | Transparent blue animated water; pool/puddle source, native liquid simulation |
| Water | 75 | Flowing counterpart; ID can change as liquid updates, inspect containment |
| SoilCarpet | 279 | Thin dry farmland-textured cover; surface decoration, not deep soil |

Use `surface` to replace supporting ground for paths/material patches/water;
opt in to `terrainDepth`. Use bounded `terrain` for deeper pools and retain
original-ground backups. Pools need a solid bed and banks: water may spread if
open sides/holes exist. Never scatter water into air like flowers. Irregular
connected patches read as puddles; independent random blue cells look noisy.
Water IDs 75/76 are actual liquid; decorative blue/green ripple stone IDs 77/78
are solid textured blocks, not substitutes for a swimmable pool.
SoilCarpet is placed above a support surface; do not replace the supporting soil
with a thin carpet and leave a hole. See [placement.md](../placement.md).

For a compact example, lazy `pocket_pond` creates a 4 x 4 m garden with a 2 x 2 m
water surface. It replaces four ground cells with native water over a solid bed,
retains the existing banks, and puts a horizontal lily pad above the water.
Twelve original ground snapshots cover bed, water and flush gravel path. Inspect
containment after native liquid updates; when removing it, remove plants before
restoring the basin. Use `template_info`/`run_template` for the selected design;
read [pocket-pond.lua](../../examples/pocket-pond.lua) only to change its geometry.

To reshape an owned pond, resume its saved scene at the same origin. Remove its
aquatic group before the basin group; the basin's bed and water restore their
original ground. Rebuild only that basin and its aquatic decoration, leaving
unrelated path/plant groups intact. A smaller footprint must leave omitted cells
restored, including soil below the former water. Save the complete revised
generator and manifest when requested, rather than replacing the generator with
only a one-time removal patch. If any member is stale, resolve that conflict
before removing it; do not relocate a partially built scene.

