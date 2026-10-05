# Native plants

Native world vegetation; BMax/character geometry remains color voxels only.

These are sparse alpha-cutout grass/crossed-plane plant models, not solid cubes.
Their texture provides the silhouette; the occupied cell is not a full green box.
Place at local y=0 on supporting ground (ground surface is y=-1).
A native flower/grass cell can already show several stems or blades. Plan density
by the rendered clump, not by treating each cell as one literal flower; inspect a
small border before multiplying it across a garden.

| Registry name | ID | Appearance and useful habitat |
|---|---:|---|
| TallGrass | 113 | Green grass tuft; scatter sparsely on meadow ground, leave paths clear |
| Fern | 114 | Leafy fern silhouette; shady woodland and moist edges |
| Yellow_Flower | 116 | Yellow dandelion flower with green stem; sunny meadow clusters |
| Red_Rose | 115 | Red rose flower on green stem; gardens and occasional meadow accents |
| Brown_Mushroom | 141 | Small brown mushroom cap/stalk; shaded forest floor |
| Red_Mushroom | 117 | Red mushroom cap/stalk; woodland accents, not a solid red cube |
| DeadBush | 132 | Dry branching brown bush; sand/dry ground, not lush lawn |
| Reed | 161 | Tall upright green cane/reed texture; water-edge rows, inspect height/stacking |
| LilyPad | 222 | Flat green leaf pad; water surface decoration, not a flowering stem |

`BlockGrass` plants require opaque support; do not suspend them in air or place
on another transparent plant. Lily pads use their own native surface model:
place ID 222 with `data=2` at local y=0 above water at y=-1 for its horizontal
surface orientation. Default data 0 renders it as a vertical plane and can be
nearly invisible from the intended pond view. Inspect placement separately.
Do not use CornerGrass 221 as ordinary
random grass: it is an interactive collision-sensor block with an entity.
Do not use WaterDrop 163 to fill pools: it is a crossed-plane droplet item model.

Match trees to their leaves: Oak_Leaves 86 has bright green leaf cutouts;
Spruce_Leaves 91 is darker green; Birch_Leaves 129 is light green;
Jungle_Leaves 85 is lush green; Cherry_Blossoms 92 is pink foliage.
Their visible leaf patterns differ from a smooth color-block crown.

## Fast, repeatable natural scatter

Use a fixed seed or coordinate hash; rebuilds should not reshuffle every plant.
Apply habitat masks first (soil, shade, wet bank), then density and species mix.
Reserve paths/doorways, leave empty ground between clusters, and never replace
occupied cells. Keep connected puddles and contained water separate from the
plant scatter mask. Start with 2–3 plant types, not every catalog entry.

[native-material-garden.lua](../../examples/native-material-garden.lua) uses native
grass/fern/flowers, a contained irregular water patch, a lily pad, and wool/carpet
swatches. It returns compact group summaries and two camera views, saves nothing,
and preserves the supporting ground through helper backups. Compare screenshots
before changing density: native plant silhouettes often need fewer placements
than full voxel flowers to read naturally.
