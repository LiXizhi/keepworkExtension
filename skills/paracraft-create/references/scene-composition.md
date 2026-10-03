# Scene composition

Design a clear focal object and circulation/negative spaces first. Allocate the
local frame into groups such as foundation, supports, roof, trim, furnishings and
props. Keep repeated geometry in parameterized loops with named dimensions so a
proportion change is one source edit.

Select native scene materials and structural shapes using the starter palette in
[voxel-art.md](voxel-art.md): fences for rails, stairs/slopes for steps and roof
transitions, textured wood/stone for surfaces, leaves for trees, and glass/windows/
doors for openings. Keep exportable BMax props in separate color-block groups.
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
