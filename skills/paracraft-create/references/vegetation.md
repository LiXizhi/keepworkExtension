# Trees, flowers and grass

Use this guide for world vegetation. For an exported plant prop, use only color
voxels; native log/leaves blocks belong in the surrounding world, not its BMax.

## Shape and palette

Design in meters: garden broadleaf trees 4–7 m tall, canopy 3–5 m wide;
flowers 0.25–0.75 m, grass 0.125–0.5 m. Larger forest species are intentional
exceptions. Prefer native grass/flower models for ordinary world vegetation; see
[plants.md](materials/plants.md) for appearance, IDs and habitats. Use
miniature voxels for custom/exportable plants; do not inflate flowers to full cubes.

Give trees a readable trunk, stepped crown and asymmetric branch/crown accents.
Chamfer crown corners rather than building a rectangular green box. Leave small
holes near branch ends; avoid a perfect ball or a stack of equal-width layers.
Native Oak_Wood 98 and Oak_Leaves 86 give world trees texture. For color-only
exported foliage use three neighboring green tones: dark interior, mid body,
light selected upper edges. Deterministic coordinate variation avoids random
changes during rebuilding; keep highlights clustered rather than noisy.

Place vegetation in clusters separated by clear ground, not a uniform grid.
Keep paths, doors and views unobstructed. A small flower bed needs two flower
colors and scattered grass, not a different color for every plant. Vary heights
and spacing; leave some ground visible. Use `surface` for a flush path.

## Fast starting point

For water-side planting, query packaged `pond_garden`: a 12 × 11 m garden with
an irregular ~5 m pond, native reeds/lily pads and sparse native grass/flowers.
The gravel approach and stone bank are flush surface replacements; the bed,
water and bank share a backed-up `pond` group. Remove aquatic plants before
restoring that group. Keep an open view across water rather than evenly filling
the shore with every plant ID. A 1.5 m color-only slatted bench exports at scale
1 and is reused independently; native scenery is excluded from the asset.
Load [pond-garden.lua](../examples/pond-garden.lua) only for geometry changes.
Inspect the pool edge, native liquid containment, bench seat height (~0.5 m)
and readable plant gaps. Saving source/world remains explicit.

[vegetation-garden.lua](../examples/vegetation-garden.lua) builds a 10 × 7 × 8 m
garden with a 6 m tree, flush path, quarter-meter flowers and grass. It scouts
automatically and returns compact group counts and independent camera vectors.
It does not save or export. Adapt its local functions/palette for repeated plants;
put each tree in one named group so revisions need only remove/rebuild that tree.
Keep miniature parts sharing a world cell in the same group: group ownership is
per carrier cell, even when the visible parts do not touch.

After writes, yield for native chunk meshing before capturing; if freshly written
parts are absent, wait briefly and recapture the same view before changing geometry.
Capture the tree silhouette and a near flower view. Check that the crown reads as
foliage, flower stems reach the ground, petals remain visible and the path is flush.
Revise the failed component once, then compare fresh images from the same view.
Return counts/bounds/stale totals normally; request detailed members only for
an actual conflict. Never confuse runtime success with visual acceptance.

Frame the full crown with air above it. Independent cameras may be outside the
construction footprint: derive native units from two valid `scene:toWorld` points
and offset the camera; do not enlarge the build bounds for a camera position.
Use an overview for silhouette and a separate near view for flower/grass detail.
Grass tufts need slender unequal blades reaching the ground; 1/8 m voxels preserve
this silhouette better than stacked quarter-meter cubes.

## Choose a tree silhouette, not just a leaf color

[conifer-garden.lua](../examples/conifer-garden.lua), packaged as `conifer_garden`,
uses a 7 m pointed crown with shrinking spruce-leaf rings and a 0.5 m trunk.
Native Spruce_Leaves 91, Fern 114 and Brown_Mushroom 141 form a shaded woodland
palette; sparse grass leaves open ground. The two-meter stone path replaces the
floor rather than sitting above it. Bark/light-bark RGB roles are adjustable;
native leaf textures retain their actual material appearance.

[cherry-garden.lua](../examples/cherry-garden.lua), packaged as `cherry_garden`,
uses a 6 m forked trunk and an asymmetric umbrella crown with native
Cherry_Blossoms 92. Native roses/grass and sparse 1/8 m fallen petals give the
base a different habitat. Build miniature branches first, then exclude their
whole carrier cells from native foliage placement: leaves cannot share those
cells or overwrite a branch. Keep all connected wood/foliage in one tree group.
Inspect both the entire crown and the forks below it; a material close-up alone
does not prove that the silhouette is intact.

Use `template_info` for only the chosen design and `run_template` for automatic
scouting without copying source. These world gardens export no models. Saving
the generator/manifest is opt-in; world saving remains separate. For a BMax plant,
rebuild visible geometry with color voxels instead of exporting native foliage.

For a reusable patio or indoor plant, choose `terracotta_planter`: 0.5 m wide and
0.875 m high, with a tapered hollow pot, thick rim, visible soil, exposed stem and
two broad leaf colors. All exported geometry is ColorBlock miniature voxels;
native world plants are still preferable for ordinary garden ground cover.
Inspect an elevated view to distinguish the rim and soil from the foliage.
Use `template_info`/`run_template` for this selected asset; change its six RGB
roles when adapting it to a room or terrace, and reuse the exported scale-1 model.
