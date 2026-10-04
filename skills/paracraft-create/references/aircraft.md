# Light aircraft and propellers

Load for compact airplanes and propeller assemblies. Set intended real dimensions
before building: the `light_aircraft` example is a stylized single-seat plane with
a roughly 6.2 m fuselage and 8 m wing span, rather than an airliner enlarged for cube detail.
Use `template_info` and `run_template` for its eight RGB roles and three exports:
airframe, propeller and one wheel reused at three landing-gear positions.

Use thin color voxels for exportable parts. Read the silhouette from several
angles: long tapered fuselage, narrow glazed cabin, high wing with shortened tips,
horizontal stabilizer and vertical fin. Leave open space below wings; slim struts
suggest structure more effectively than solid triangular walls. Compress each
constant cross-section into a box. Keep source parts separate from preview actors.

The example faces negative Z. Its propeller pivots on the longitudinal Z axis;
use XYZW `{0,0,sin(angle/2),cos(angle/2)}`. Quarter-turn keys avoid shortest-path
quaternion interpolation accidentally skipping a full revolution. An asymmetric
color/shape marker and intermediate captures reveal actual rotation. Inspect
native final bone rotations, not just stored keys. Model scale stays at 1.

Measure the sweep of actual voxel corners, which may exceed nominal blade radius.
Keep the rotor's axial thickness clear of the cowling and its lowest rotating
corner above supporting terrain. Do not confuse source bounds with assembled
bounds: each actor uses the airframe's fixed frame plus its attachment offset.
Land gear/wheels must touch the ground in a world capture; isolated captures only
prove silhouette and relative attachment. Read [visual-review.md](visual-review.md).

This template is a parked propeller demonstration. It does not supply flight,
taxiing, steering, aerodynamic forces or independently embedded aircraft clips.
For flight, explicitly author body position and orientation, transform every
attachment by that orientation, then verify multiple poses and obstacle clearance.
Use [animation.md](animation.md) for tracks and [moving-objects.md](moving-objects.md)
for reusable rigid parts. A spinning propeller alone is not flying acceptance.

For a looped airborne motion demonstration, load `banking_aircraft` instead. It
shares the same geometry source and palette, but reserves eight meters of height
and authors 129 explicit position/orientation keys per part over two seconds.
The body yaws ±0.25 rad and banks ±20 degrees while following a short elevated
path. This is an illustrative animation, not an aerodynamic trajectory solver.

Rotate attachment offsets by the body's XYZW quaternion before adding its world
position. Compose the propeller as `bodyRotation * localPropellerRotation`;
giving it only the body's position leaves the rotor in the wrong plane. Wheels
use the same body rotation. Each asset's exported pivot is its attachment origin.
Use integer milliseconds for both key poses and returned audit metadata. Sparse
position tracks interpolate linearly while rotations slerp, so attachment error
can appear between keys even if every key is correct. This example uses dense
keys and requires attachment error below 1 mm, including an in-between capture;
it does not claim exact parent constraints at all continuous times. Verify loop
return and extrema with native final rotations and isolated assembly screenshots.
The full body rotation envelope makes automatic captures deliberately loose.
For this bounded bank demonstration, try `distanceMeters:18,yaw:0.65,elevation:0.2,
size:512` and inspect all extrema for clipping before using a closer view.
