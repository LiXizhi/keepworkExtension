# Natural terrain and Biomes

Use for 自然地貌、山脉、沙漠、雪山、雪地、平原 and mixed habitats. This guide
authors editable native block scenery through the existing creation workflow.
A visible desert or snowfield does not establish that the native generator's
biome metadata, weather or spawning rules changed. For native biome/generator
configuration, discover the installed CLI and official wiki support first; do
not invent a `setBiome` action or silently reset/regenerate an existing world.

## Site and scale

Read [placement.md](placement.md), current creation capabilities and engine-owned
`creation.md`. A requested landscape authorizes its planned footprint, not clearing
other structures. Inspect loaded terrain, entities, existing controls and world
instructions before choosing additive relief or replacement. Unknown chunks are
unknown; neither a distant screenshot nor an empty object index proves empty land.

- On a level empty site, build hills, dunes and ridges above the fixed ground with
  native block columns/boxes. `surface` replaces the supporting cell at local y=-1;
  the new ground height must include the added columns.
- On existing relief, inspect actual column heights and materials first. Use an
  explicit origin derived from evidence when automatic flat-site scouting cannot
  fit; it does not bypass loaded-cell, ownership or edit checks. Use `terrain` only
  inside its declared allowance. Do not substitute raw block writes to evade a
  helper refusal. If unsupported, report the concrete limit and choose an in-scope
  smaller/additive treatment or establish a suitable world/site with the user.
- A new local world follows `run_command` with `params.world` and official
  `world-management.md`; see [local-worlds.md](local-worlds.md).
  Creation currently starts superflat; it does not itself supply a mountain biome.
  Preserve the current world's unsaved work and verify entered identity after an
  authorized switch. Never manufacture a world by copying arbitrary region files.

Use 1 block = 1 meter. State horizontal extent, relief, base height and waterline;
a compact mountain scene may represent foothills or a deliberately scaled diorama.
Do not call a small mound a life-size mountain. Use whole native blocks for bulk
terrain; miniature voxels are for selected detail, not millions of ground cells.

The current helper's terrainDepth is 0..16 and its total bounded volume, including
below-ground allowance, is capped at 65,536 cells; installed capabilities/wiki are
authoritative. Budget width * depth * (height + terrainDepth), not just visible
surface cells. A 32 x 32 footprint with 24 m above-ground bounds and depth 2
budgets 26,624 cells. A 64 x 64 x 32 scene already exceeds that limit.
For larger authorized landscapes use separately bounded neighboring scenes with
fixed absolute origins and non-overlapping ownership. Inspect/reserve each area;
do not assume automatic scouting places tiles adjacently. Splitting does not
remove loaded-region or height limits. Run edits sequentially in the same chat.

## Continuous relief

Keep a compact deterministic generator rather than enumerating every block in
the prompt. Plan seed, region bounds and a shared absolute-coordinate function
`height(bx,bz)` before writes. Compute relief, material and plant eligibility from
the same field. A local coordinate restart or fresh random seed per tile creates
visible seams. Preserve shared heights/materials along edges and leave enough
bound height for the highest column, trees and any controls.

Build broad form first: low-frequency rounded hills for plains, elongated ridges
and saddles for ranges, wind-aligned asymmetric dunes for desert. Add smaller
variation only after the main silhouette reads well. Avoid independent random
column heights, identical cones and isolated holes. Clamp heights and neighbor
steps to the intended terrain; reserve cliffs as specific features. A cross-section
should show solid supported columns, a deliberate rock/soil base and surface cap,
not a hollow skin or floating grass. Batch equal-height spans when useful and
yield between bounded passes; inspect job progress without dumping all members.

Check the quantized height field before writing: its nonzero footprint and
adjacent levels must still express the intended relief. For example,
`floor(max(0,1-distance/radius))` collapses a unit-height hill to its center cell;
use an intended meter-height amplitude and review the resulting integer levels.
At shallow relief, half-grid edge treatment or a wider supported terrace can
improve the silhouette; do not increase the whole landscape's scale just to
hide quantization.

Sketch watercourses and settlement corridors before committing the field. Rivers
need a connected downhill/level route, basin, bed and banks; do not add random
water cells after the mountains. Native water IDs 75/76 simulate liquids: complete
containment first and check after native updates. Use terraced channels when an
unsupported continuous slope would leak. Ice is a solid surface material and is
not interchangeable with swimming water. See [ground-water.md](materials/ground-water.md).

## Habitat recipes

These are design defaults, adapted to the user's reference, season and scale.

| Requested habitat | Relief and ground | Vegetation, transitions and recognizable features |
|---|---|---|
| Plains / meadow 平原 | Broad low undulations; Grass over Dirt, exposed soil near paths | Sparse clustered grass/flowers, occasional trees; open sightlines and river meadow |
| Mountains / range 山脉 | Connected ridges, saddles, valleys; exposed rock on steep faces, soil on shelves | Vegetation thins with slope/height; distinguish foreground hills from distant peaks |
| Desert / dunes 沙漠 | Wind-aligned dunes, interdune flats; Sand and exposed Sandstone | Dry sparse planting only from the native palette; oasis only around contained water; gradual dry grass/sand boundary |
| Snowy mountains 雪山 | Rock shoulders and jagged/rounded ridge silhouette; snow cap above an explicit snowline | Patchy lower snow and bare steep faces; conifers below treeline, exposed rock higher up |
| Snowfield / tundra 雪地 | Gentle relief; Snow surface or Snow_Block masses, purposeful ice patches | Sparse hardy plants or conifer clusters; visible trail, frozen pond and snowy transition rather than flat white color cubes |
| Forest / woodland 森林 | Compatible soil and gentle-to-moderate relief | Clustered species, canopy gaps, clearings and readable undergrowth; see [vegetation.md](vegetation.md) |
| Coast / wetland 海岸、湿地 | Connected shore, shallow shelf and contained basin | Sand/gravel banks, reeds on eligible shore cells; keep dry routes and buildings above waterline |

Use native registry names only when `nativeBlockNames` is supported; otherwise
use verified Paracraft IDs. Snow 52 is snowy dirt with a white top, Snow_Block 5
is snow on all faces, Ice 17 is transparent slippery solid ice. Verify installed
names/appearance before extending the palette. Native StoneBrick is masonry;
choose the registry's natural rock for exposed mountains, not a brick-textured
mountain or Minecraft's numerical stone ID. Textured habitat materials remain
world geometry; exclude them from color-only BMax exports.

Represent mixed Biomes with a shared spatial mask and transition band. Blend
patches according to height, slope and moisture; avoid hard rectangular seams
unless the user requests demonstration plots. Snowline and treeline are design
parameters, not claimed engine climate simulation. Plant only after the final
surface is known: respect support, slope, spacing, water, roads and viewpoints.

## Revision, review and world records

Keep names such as `relief-west`, `river-bed`, `snow-cap`, `forest-north`; choose
group granularity that supports regional edits within each scene. Avoid several
groups owning the same cell. If layering rock/soil/snow in one column, keep its
overwrites in one terrain group or partition cells explicitly. Remove dependent
plants/buildings before rebuilding their support; preserve original terrain
snapshots and resolve stale members before restoration. A raised mountain created
with `box` removes to its original empty cells; supporting ground replacements
use terrain backups. Retain complete generator source when saving is requested.

Inspect one overview, a ridge/valley silhouette and ground-level transitions
through independent captures. Check tile seams, floating blocks/trees, shoreline
leaks, route gradients and player-scale traversal. Wait for meshing/liquid updates
before deciding a missing surface is a design defect. Report inspected regions
and unresolved coverage; a successful code job alone proves no visual quality.

Follow [world-memory.md](world-memory.md). Put substantial records directly in
`docs/terrain.md` with links from docs/README.md: absolute tile origins/bounds,
seed and height/mask parameters, authored Biomes, water/snowline, palette, group
dependencies, generator/manifest paths and inspected coverage. Record appearance
separately from any verified native biome configuration. Track runtime edits,
document persistence and explicit native saving as distinct states. Generators
and manifests belong to the established `creation/<name>/` convention; exports
belong to `blocktemplates/`, not docs. Read these records plus live terrain before
resuming; do not rebuild automatically from a past unsaved change note.
