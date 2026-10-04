# Rigid moving objects

Use for fans, wheels, propellers and other separately rotating parts. Keep the
stationary housing and moving geometry in named groups. Model visible BMax/ParaX
geometry only with color blocks or miniature color voxels; use native materials
for surrounding world architecture. Design in meters before building.

Export each rigid part with `scene:exportVoxelX(filename,group,{pivot={x,y,z}})`.
The pivot is a point in the source scene's fixed local coordinates. It becomes
the asset origin and the named `root` bone pivot. Place the actor origin at the
desired assembled joint, at scale 1. Measure the independently loaded bounds;
moving the origin must not enlarge or shrink the part.

Author MovieBlock `bones.root.rotation` keys as XYZW quaternions. For a full turn
around Z, use `{0,0,sin(angle/2),cos(angle/2)}` at angles 0, π/2, π, 3π/2 and 2π.
An identity key at each endpoint alone cannot describe a full revolution.
The mesh exporter seeds an identity root track and writes the native animBones
header, both required for external MovieBlock keys to affect this color mesh.
This is a rigid-part technique, not a replacement for multi-bone skin binding.

[desk-fan.lua](../examples/desk-fan.lua) builds a ~0.78 m tall desktop fan with a
~0.44 m curved three-blade rotor, hub, motor and sparse protective grille, writes
two unique world-local `.x` files, and makes a one-second rotation. Use 1/32 m
voxels for this scale; preserve open space through the grille so the blades remain
readable. Explicitly replace intentional joins between the stem and motor.
Inspect the assembled silhouette and clearances before adding detail. Compare
0, 0.125 and 0.25 seconds with a fixed independent camera and query the native
bone's final rotation; a persisted key alone does not prove visible motion.
Keep source, movie and exports distinct; world saving remains explicit.

The packaged `desk_fan` template exposes base/frame/guard/blade/bladeTip/hub/switch
palette roles through `template_info` and `run_template`. Prefer a restrained
housing palette and a contrasting rotor; keep guard wires readable without
obscuring motion. Use uniform `#RRGGBB` inputs rather than native packed data.

The packaged `compact_car` template creates a 3.75 m long hatchback with a
1.875 m mirror span and a 1.5 m assembled height. Read its `template_info` only
when building a car. Ten `#RRGGBB` palette roles let you change body, roof, glass,
lights and trim without copying the generator into chat. A 1/16 m voxel grid
preserves the angled windshield, wheel openings, mirrors and lights at this size.
The body uses stepped, narrower ends, door seams, short handles and open wheel
arches. Leave negative space around moving parts before adding trim. Compress
adjacent occupied voxel runs into boxes to reduce helper calls. Keep the thin
chassis inside the tire span rather than hiding it in a full-width side panel.
It exports one body and one tire asset; reuse that tire for all four wheel actors
at scale 1. Keep the source parts away from the assembled preview and movie controls.

Reserve clearance for the tire's actual voxel corners throughout a turn, not
just its nominal radius. The 0.3125 m tire in this example sweeps about 0.35356 m
because of square voxel corners. The current larger arches retain at least
0.05188 m of body clearance under a conservative envelope covering every wheel
spin and front-wheel steering angle from -20° to +20°. Validate the source
geometry and inspect an assembled side view.

For straight travel, keep wheel centers attached to the body's position track.
Match distance to rotation: `distance = radius * angle` (radians), so a 0.3125 m
radius tire travels about 1.9635 m per revolution. This template moves toward
negative Z and rotates tires around negative X, with quarter-turn quaternion keys
and an asymmetric rim marker. Inspect an intermediate time such as 0.125 s as
well as the endpoints: symmetric spokes can hide a real turn. Check native bone
poses, meter bounds, joint offsets and body displacement. At 1 s the car stops;
the front wheels yaw left at 1.25 s, straighten at 1.5 s, yaw right at 1.75 s and
straighten at 2 s. Yaw quaternions use `{0,sin(angle/2),0,cos(angle/2)}` around Y;
use radians (`π/9` for 20°). Rear wheels hold their completed-spin pose and every
actor stays at the stopped position. Inspect both steering extremes with a fixed
camera, and query native final rotations rather than trusting stored keys alone.

This uses parallel front-wheel yaw for a parked steering demonstration. Moving
along a curved path additionally requires unequal inner/outer steering angles,
body facing, rotated wheel attachment offsets and wheel-specific travel/spin.
Do not claim that adding yaw to straight travel implements a physical turn.
Collision physics and standalone embedded driving clips are not supplied.
World screenshots need visible supporting terrain;
isolated asset captures inspect individual parts. For a clean assembled car view,
use `camera_capture` with `assembly:{moviePosition:<movie block>,timeSeconds:1.25,
yaw:0.65,elevation:0.2,size:512}` when supported. Automatic rigid/envelope framing
keeps the car centered without guessing distance. Compare 0.125,
0.25, 1.25 and 1.75 s without changing framing. See [visual-review.md](visual-review.md).

For vehicles, start with whole-object position/facing tracks and add separate
wheel/propeller parts when needed. Load [boats.md](boats.md) for the open-hull
rowboat and contained water preview. Load [aircraft.md](aircraft.md) for light
airplanes and longitudinal propeller axes. Aircraft and animal wings need explicit
joint placement and clearance at extreme poses. Load [animation.md](animation.md)
for timeline operations or [rigging.md](rigging.md) for an articulated skeleton.
