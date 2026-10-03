# Reading a reference or brief

For a reference image, inspect it before coding. Record only what will guide the
build: overall width/height/depth ratios, major masses, empty spaces, repeated
motifs, material/color regions, moving parts, and a few identity-defining details.
Mark occluded surfaces as inferred. A front image does not establish back geometry.
For a text-only request, make deliberate design choices and label them as such;
do not demand a reference image the user did not offer.

Use a small component table when complexity warrants it:

| Component | Local bounds | Representation | Distinctive feature | Evidence |
|---|---|---|---|---|
| roof | planned bounds | hollow cone + trim | steep turquoise silhouette | observed |
| columns | planned bounds | repeated cylinders | regular spacing | observed |
| back entrance | planned bounds | blocks | clearance to interior | inferred |

Attach important details to real groups or geometry operations. Avoid promising
details only in prose. Prioritize silhouette and negative space before surface
decoration. Use a limited palette with recognizable large regions; native color
blocks do not expose Three.js PBR roughness, normal maps or texture projection.

For characters, establish body proportions, face direction, left/right from the
character's viewpoint, rest pose, pivot locations and the silhouette at motion
extremes. Decide which parts must move rigidly before assigning voxel colors and
bones. Favor an expressive readable voxel style over claiming exact likeness from
insufficient views.

Retain a compact local design/review record for long tasks: component names,
dimensions, palette, source files, job IDs, fixed scene origin, captures and
unresolved differences. A record supports resuming; it is not visual evidence.
