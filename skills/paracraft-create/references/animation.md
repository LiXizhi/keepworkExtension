# Animation authoring

Create a MovieBlock inside the scene's reserved control area. Add an actor from a
verified BMax with a separate preview position and scale. Helper times are seconds;
the native timeline stores milliseconds. Key values must use the documented native
tracks. Bone rotations are normalized quaternions in XYZW order, not Euler angles.

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

The [idle-wave example](../examples/idle-wave.lua) exports IDs 0 and 1 from a
three-second timeline. Review each clip independently after export and reload.
Native `.x` export requires the installed ParaX exporter; discover availability
before promising it. If missing, retain the editable rig/movie and report the
specific unavailable export capability.
