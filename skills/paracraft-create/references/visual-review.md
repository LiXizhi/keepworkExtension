# Visual feedback and correction

Use fresh `paracraft_cli` action `camera_capture` images for geometry and animation review.
Use `paracraft_cli` action `screenshot` when editor UI itself matters. Both return native MCP
image content. Metadata carries session/camera/time information; an unavailable
fresh image must not be treated as a cached successful capture.

Choose views to answer concrete questions:

| View | What it establishes |
|---|---|
| reference-matched or main three-quarter | silhouette, proportions, focal hierarchy |
| rear or opposite three-quarter | hidden gaps, back completeness, intersections |
| detail close-up | miniature geometry, joints, color boundaries |
| rest and motion extreme | rig binding, pivots, limb clearance |

Visually inspect the image pixels. Structured scene counts confirm that objects
exist, not that they look right. If the host cannot expose image content to the
model, save the returned image locally and use the host's image-viewing tool;
report the limitation if no visual inspection is possible. Never print base64.

Check realistic scale using numeric bounds and the roughly 1.75 m player as a
reference: one authored block is one real-world meter. Include final exported
asset bounds; do not let camera framing or preview scaling hide oversized objects.

Compare each important feature to the brief/reference. Record a concrete finding
such as "roof is too shallow relative to the columns", the affected group, and
the next edit. Fix the largest mismatch first. Keep camera framing stable for
before/after comparisons. Do not invent numerical likeness scores.

Suggested stopping rule: after two revisions that do not improve the same feature,
reconsider the representation or reference rather than repeating cosmetic edits.
Scale review effort to the user's requested quality. A technical fixture can pass
transport/rig checks while remaining visually crude; label it accordingly.
