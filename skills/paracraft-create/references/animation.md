# Animation authoring

Create a MovieBlock inside the scene's reserved control area. Add an actor from a
verified BMax with a separate preview position and scale. Helper times are seconds;
the native timeline stores milliseconds. Key values must use the documented native
tracks. Bone rotations are normalized quaternions in XYZW order, not Euler angles.

For dense motion, prefer `scene:keyframes(movie,actor,frames)` when capabilities
advertise it. Each frame is `{seconds=t,values={position=...,bones=...}}`; use
increasing integer-millisecond times, at most 512 frames and 4,096 track keys per
batch. One actor batch serializes the MovieBlock once and produces one native
undo command. Validate poses after writing; batching improves authoring cost,
not animation quality by itself. On older engines use individual `keyframe`
calls in sequence. Do not resend a mutation to recover a transport timeout.

For idle, establish a rest key and restrained intentional motion. For a wave,
stage anticipation, raised arm, oscillation and recovery. Keep the body readable
and avoid limb penetration. Use explicit keys; no adaptive motion preset is
implied. Animation-ID keys define exported clip segments. Inspect the resulting
timeline instead of assuming separate movie names automatically create clip IDs.

Use independent `camera_capture` with `moviePosition` (absolute block coordinates)
and `timeSeconds` to seek, wait for assets/pose and capture a verification frame.
Read movie position from `scene:position`; use `scene:toWorld` for eye/lookat.
Inspect clip start, strongest pose, transition and end when relevant. A still frame
cannot verify timing: sample additional times or play the clip when motion quality
matters. Stop helper playback when finished; persistent timers keep a job active.

Creation seeks and pose captures rebind authoritative external bone tracks before
evaluating them. This avoids cached previous poses when a track reverses direction;
query the native final rotation and review the captured frame, especially for
alternating wing motion. Do not replace a failed pose check with timestamps alone.
Exact seeks reset native animation blending so a clip boundary does not retain
the previous capture's pose; ordinary playback still uses its native transitions.

## Embedded miniature-character clips

Use `exportVoxelX(file,{"body","right_arm"},{rig="controls",pivot={x,y,z},
animation={movie="wave",actor="character",loops={[0]=true,[1]=false}}})`.
The owned source actor needs unique integer animation IDs beginning at time zero
and explicit bone `rot`, `trans` or `scale` keys matching the exported skeleton.
Root movement belongs in root-bone keys; animated actor position, orientation,
scale or asset changes are rejected rather than silently omitted. Native bone
range controls must stay enabled. Every clip receives interpolated boundary
poses; the preceding ID ends one millisecond before the next begins. ID 0 loops
by default; override other IDs in `loops` as needed.

Reload the exported file in a new actor with only animation-ID keys. Inspect
idle, the ID transition, peak wave and recovery, and confirm there are no external
bone tracks masking a bad export. The [mini-character template](../examples/mini-character.lua)
provides that independent verification actor at scale 1 and a three-second clip.
For model-only feedback, `camera_capture` with `asset` loads the exported file
directly. Its nested `timeSeconds` starts at zero for the selected `animId`; e.g.
ID 1 at local 0.5 s samples the source's wave at 1.5 s. It does not seek or edit
the source MovieBlock. Read [visual-review.md](visual-review.md) for framing.

The [idle-wave example](../examples/idle-wave.lua) exports IDs 0 and 1 from a
three-second timeline. Review each clip independently after export and reload.
Native `.x` export requires the installed ParaX exporter; discover availability
before promising it. If missing, retain the editable rig/movie and report the
specific unavailable export capability.
