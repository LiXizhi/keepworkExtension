# Small boats and waterside scenes

Load for rowboats, canoes and boat previews. Design in meters: a small two-seat
rowboat can be about 3.5 m long, 1.5 m wide and 0.625 m deep. Use a finer color
voxel grid for its walls, seats and oars rather than a boat sized for whole cubes.
The reusable `rowing_boat` template exposes eight RGB palette roles through
`template_info`/`run_template`; it exports a hull and one shared oar `.x` file.

Build the open hull in cross-sections that taper toward the bow/stern and flare
toward the rim. Compress consecutive equal-width rows into boxes. Use aligned
1/16 m geometry positions; an exported pivot may fall between voxel centers.
Keep air above the sole. Fit every seat row to that row's inner width, not just
the widest beam or the first row: a taper can cause a seat to intersect the wall.
Separate a dark sole, lighter rim/seats and a restrained exterior stripe.

The hull pivot lies at the intended waterline (source y=0.75 in this template).
Its independent scale-1 bounds are 1.5 x 0.625 x 3.5 m, with minY=-0.5 and
maxY=0.125 relative to the pivot. A preview origin 0.25 m above the terrain plane
puts the lower hull below the nominal water surface; verify actual native water
rendering in a world view. The model is not a cube balanced above a blue floor.

The preview uses actual Still_Water ID 76, StoneBrick ID 68 for a closed bed and
banks, WoodPlanks ID 81 for a flush dock and native colored-fence posts. Ground
edits opt into terrainDepth=2, use bounded terrain/surface helpers and preserve
original blocks for restoration. The basin includes the whole oar sweep, not
only the hull. Do not put blade tips into stone banks and call it a water stroke.
See [placement.md](placement.md) and [materials/ground-water.md](materials/ground-water.md).

Oars are separate actors reused from one asset, at scale 1. Their origins sit
at fixed oarlocks and move with the hull. Mirror the left oar with a Y half-turn;
combine yaw sweep with local Z dipping/lifting using XYZW quaternions. The
template has a two-second loopable bob and illustrative stroke/recovery motion.
It supplies no rower, propulsion, buoyancy/collision solver or hydrodynamics.
Those must be authored explicitly if requested; keys alone do not provide them.

Inspect 0, 0.5 and 1.5 s: open cockpit, seat fit, hull immersion, blade entry/lift,
matching oarlocks and loop return. Use world views for the waterline, then clean
assembly captures to inspect silhouette and motion. Yaw 0.65, elevation 0.2,
distanceMeters 10 and size 512 are a starting view; long oars' full rotation
envelopes can make automatic framing loose. Query actual loaded model bounds,
native bone poses and editable member fingerprints before claiming readiness.
