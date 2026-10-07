# Villages, towns and city roads

Use for 村落、村庄、城镇、城市马路 and street networks. Read
[terrain-biomes.md](terrain-biomes.md) when relief/habitat is part of the request,
and [scene-composition.md](scene-composition.md) for architectural composition.
Build the requested scope: a road request need not become a whole city, and a
village need not include simulated residents, traffic or quests.

## Layout before details

Inspect world instructions, structures, ground and existing access routes. Plan
in meters with named districts/plots and a connected circulation graph: entrances,
road junctions, paths, central square and any river crossings. Set road elevations
and building floor levels from the same terrain field or inspected heights. A
mountain village uses shelves, contour-following paths and deliberate stairs;
a desert settlement groups shaded courtyards around its available water; a snow
village needs readable cleared approaches. Do not flatten the entire habitat to
fit a rectangular building grid unless that is the requested design.

Use practical starting dimensions, adapted to references: footpath 1–2 m, village
lane 3–5 m, a compact two-way street about 6–8 m plus 1–2 m sidewalks on each side,
small cottage about 6–10 m across, doors near 1 x 2 m, storey height about 3 m.
These are design anchors, not regulatory specifications. Choose building count
and plot area from the requested extent; keep village homes at human scale instead
of enlarging them to occupy a city-sized site. Leave entrances, corners and
crossings clear of trees, furniture and invisible model carriers.

## Roads and crossings

Define polylines/junctions in a common absolute frame; rasterize connected widths
and merge intersection footprints before painting. Avoid disconnected diagonal
cells, double curbs across intersections, abrupt dead ends and markings running
through pedestrian crossings. Roads should reach each intended entrance, bridge
and boundary connection. Use bridges across water rather than silently filling
a stream; include abutments, walkable deck, clearance and rails where appropriate.

For a flat scene, local y=0 is air and `surface` replaces supporting ground at
y=-1. Use it for flush road/floor material, with declared `terrainDepth`, following
[placement.md](placement.md). On hills, derive each segment from actual surface
height and the fixed scene origin; `surface` is not a terrain-following API.
Use bounded `terrain` for cuts and native blocks for embankments within the
declared volume. Reject uninspected/occupied cells rather than clearing controls.
Keep vehicle routes gradual; use native stairs for deliberately stepped footpaths
and avoid one-meter vertical steps in an ordinary vehicle lane.

Use native Gravel for village paths, StoneBrick for paved squares, and verified
paintable/textured world materials for modern pavement and curbs. Use limited
contrast for center/edge lines and crossing stripes. Make markings flush with or
thin above the road: full cubes create barriers. For miniature details, account
for whole-cell carrier ownership; they cannot share a native pavement cell with
another group. If a shape cannot represent a flush line, choose a compatible
native patterned block or omit that detail and report the approximation. Never
trade a walkable surface for a decorative but colliding carrier.

Build and review one representative junction/house access before repeating it.
Check continuity at tile boundaries, curb breaks, sidewalk connections, doorway
height and bridge contact. Use player-scale street captures as well as an overview.
Static cars and lights do not establish working traffic; implement behavior only
when requested, then document its CodeBlock/movie entry and verify it separately.

## Buildings and staged expansion

Block out roads, plots and major building masses first. Reuse a few structural
types with varied orientation, roofline, setback and courtyard shape; avoid an
identical house grid unless intended. Use textured native walls, stairs/slabs for
roofs, supported windows and working native doors. Read the relevant palettes
and current engine `creation.md` before selecting IDs/direction data. Packaged
architecture templates are candidates via `template_info`, not assumed available
village/city generators. Export only separate color-only props when useful.

For a closed gabled house, include the front/rear wall infill between the top of
the rectangular wall and the roof slopes. A stair roof and a three-meter wall
alone can leave large triangular openings. Inspect one house at entrance height
and from the opposite side before repeating its shell; leave those openings only
when the design intentionally calls for ventilation or a review cutaway.

Keep regional scene names and stable origins, e.g. village-east and road-north.
Budget construction volume including foundations, roof, trees and controls against
the current engine limits; for larger work see the terrain guide's tiling rules.
Assign shared junction cells to one region/group so adjacent road passes do not
overwrite each other. Coordinate road and building revisions through dependencies:
inspect/remove dependent decoration before changing support, check stale members,
then rebuild only affected named components. Keep unrelated houses and terrain.

## World-local continuation

Follow [world-memory.md](world-memory.md). Document layout directly in
`docs/settlements.md` and `docs/roads.md` when their detail warrants separate pages;
link from docs/README.md and existing terrain/code documentation. Record absolute
bounds/origins, plot and junction names, entrance/road elevations, width/grade
parameters, shared-cell ownership, source/manifest paths, deterministic variation
seed, inspected routes and remaining work. Keep generators in `creation/<name>/`
and reusable exports in `blocktemplates/`; no nested docs/paracraft directory.
Update docs/changes.md with the original request/job ID and separate runtime,
document and native save states. Saving source/native world remains explicit.
