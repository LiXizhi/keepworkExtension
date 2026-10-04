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

