# Scene composition

Design a clear focal object and circulation/negative spaces first. Allocate the
local frame into groups such as foundation, supports, roof, trim, furnishings and
props. Keep repeated geometry in parameterized loops with named dimensions so a
proportion change is one source edit.

Select native scene materials and structural shapes using the starter palette in
[voxel-art.md](voxel-art.md): fences for rails, stairs/slopes for steps and roof
transitions, textured wood/stone for surfaces, leaves for trees, and glass/windows/
doors for openings. Keep exportable BMax props in separate color-block groups.
For a small open garden structure, query `garden_pergola`: approximately 4.25 m
across, 2.5 m visible beneath the beams and 2 m whole-carrier collision headroom,
with flush native paving and native fence
feet. Thin miniature beams and climbing roses share frame carriers; use native
flowers in the surrounding bed. Load [garden-pergola.lua](../examples/garden-pergola.lua)
only to revise geometry. Do not use meter-wide slab footprints as narrow rafters
or enlarge a pergola to compensate. Upper slab `data=1` at floor y=-1 reaches
the same top as the surrounding ground; a lower slab there leaves a depression.
Place large material and color regions before accents. Create depth using real setbacks,
overhangs and openings rather than dense surface noise. Reserve miniature voxels
for silhouette transitions or recognizable details. Keep the construction grid
and architectural rhythm consistent unless the design calls for variation.

After the blockout, capture an elevated three-quarter view and a view that exposes
the interior/back. Check whether supports meet the roof, pathways are open, props
intersect walls, and the scene reads at player scale. A pretty front view cannot
prove that the other side is finished. Keep the main player camera stationary;
use independent cameras for these checks.

The pavilion example demonstrates repetition, a curved hollow roof, miniature
details and a reusable BMax prop. Adapt its dimensions and group layout to the
requested design; it is a technical sample, not a universal architecture style.

## Meter-based proportions

Treat each authored block as one real-world meter; the main player is approximately
1.75 m tall. Unless the brief gives other dimensions, start at ordinary human scale:

| Feature | Useful starting range |
|---|---|
| Adult character | about 1.75 m tall, adjusted for the character |
| Door opening | about 0.8–1.0 m wide and 2.0–2.2 m high |
| Interior ceiling | about 2.4–3.0 m above the floor |
| Chair seat | about 0.45 m above the floor |
| Table / work surface | about 0.7–0.8 m high |
| Guard / hand rail | about 0.9–1.1 m above the walking surface |
| Stair riser / tread | about 0.15–0.2 m high / 0.25–0.3 m deep |
| Small pavilion | roughly 4–6 m across and 3–4 m above its floor |

These are design anchors, not building-code requirements or limits for every
object. Respect the requested building type, reference and explicit dimensions.
Record width/depth/height of major objects before allocating construction bounds.
Separate actual object dimensions from extra workspace for rig controls and previews.
Use a quarter/eighth/sixteenth-block grid when a whole native block would make a
small object or step oversized. Native stairs/slabs are useful for stylized world
architecture, but their one-block footprint is not an ordinary human stair tread.
Never enlarge a house, prop or character merely to avoid fractional geometry.

Review a view with the player or another measured 1.75 m reference, as well as
independent camera views. Check door clearances, seat heights, floor-to-ceiling
height and tree/prop proportions. A close camera or scaled preview can conceal an
oversized asset: also inspect numeric bounds and report intended meter dimensions.

For outdoor furniture, lazy template `picnic_table` has a 1.75 m slatted top,
0.4375 m benches and tapered open A-frame supports. It exports color-only geometry
once and reuses it at scale 1; read [picnic-table.lua](../examples/picnic-table.lua)
only when changing its geometry. Use model instances for furniture placed in a
walkable scene: the editable miniature source uses full-cell collision carriers.

For a patio shade, lazy template `garden_parasol` makes a 2.25 m eight-panel canvas
canopy, thin pole and compact weighted base. Its overall height is 2.375 m; inspect
the independent exported instance at scale 1. Read
[garden-parasol.lua](../examples/garden-parasol.lua) only to alter geometry.

For human-scale seating, lazy `garden_chair` is 0.5 m across, with a 0.4375 m seat
and 0.9375 m back. Open slats and thin splayed legs keep its silhouette readable
without enlarging it. Read [garden-chair.lua](../examples/garden-chair.lua) for
geometry; use scale-1 model instances around tables and retain editable source
elsewhere. The template requires `voxelBoxBatch`.

Pair that chair with lazy `bistro_table`: a 0.75 m round timber top at 0.75 m
height, darker rim and slim pedestal on a cross foot. Read
[bistro-table.lua](../examples/bistro-table.lua) for its row-span disk geometry;
reuse the color-only export at scale 1. It also requires `voxelBoxBatch`.

Inspect thin tabletops from an elevated asset view (for example 0.65 radians) as
well as the side: a low view can hide a disk's shape and wood strips. Increase
`distanceMeters` if the elevated view loses margin, without changing model scale.
Current engines automatically fit the rest-bounds sphere with margin at any view
angle. For image comparisons across engine versions, fix camera distance as well
as yaw/elevation so framing changes are not mistaken for geometry changes.

For small patio details, lazy `patio_lantern` is 0.25 m wide and 0.5 m tall,
including its loop handle. It uses thin open posts around a visible candle,
negative space and a stepped metal cap instead of enlarging the lantern to fit
whole blocks. Read [patio-lantern.lua](../examples/patio-lantern.lua) only for
geometry changes. Its colored flame is decorative: the export emits no light,
and color voxels do not provide transparent glass. Plan actual scene lighting
separately. Reuse the scale-1 asset rather than regenerating each lantern.

When arranging small reused props, engines advertising `modelOffset` accept
`scene:model({position={bx,by,bz},offset={dx,dy,dz},filename=...,scale=1})`.
The carrier stays integral; the visible model moves by local meters. Native limits
are X/Z −0.5 to +0.5 and Y 0 to 1; invalid offsets are rejected before writes.
Offset Y=0.75 raises a bottom-pivot prop by 0.75 m. With `modelContactPlacement`,
known unchanged models in the same scene are checked using their transformed
bounds instead of the new carrier's whole cell. Touching faces are allowed;
overlapping bounds, solid blocks and unloaded volume are rejected with helper
rollback. These are conservative bounding-box checks, not triangle collision.
Older engines can still reject neighboring carriers as `entity_obstruction`.
Use separate empty carrier cells for separate models, check their actual bounds,
and keep offsets in the saved generator. Older engines need another arrangement
or an explicit capability error; do not silently round the model position.
Read [model-offset.lua](../examples/model-offset.lua) for a table/lantern layout;
replace its two filenames with verified existing exports before running it. The
example exports no new asset and does not save source or the world automatically.
Read [model-contact.lua](../examples/model-contact.lua) for a lantern resting on
a 0.75 m table, using distinct carriers and existing bottom-pivot scale-1 exports.
Check both capabilities first and inspect the contact in a fresh side view.
