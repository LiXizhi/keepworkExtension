# Editable multi-scene animated films

Read world instructions and relevant code/movie/module docs first. Read
[animation.md](animation.md) for actors and [world-memory.md](world-memory.md) for
session handoff. Require `movieSequences` and `cameraKeyframes` capabilities.

Plan a short storyboard: purpose, set, actors, action, shot duration and framing.
Use several named sets in the same world, reusable model assets, and one child
MovieBlock per independently editable shot. Reserve control blocks with stable
coordinates. Keep story choices appropriate to the request rather than requiring
a fixed number of shots. Keep related code blocks and third-party module settings
in the plan, especially actor activation and playback entry points.

After scene:movie and actor/keyframes authoring, add native camera tracks:

```lua
scene:cameraKeyframes("opening", {
  {seconds=0, lookat={3,2,3}, distanceMeters=8, yaw=0.7, pitch=0.2},
  {seconds=3, lookat={4,2,3}, distanceMeters=6, yaw=0.5, pitch=0.2},
})
scene:movieSequence("film", {
  {seconds=0, moviePosition=scene:position({1,1,0})},
  {seconds=3, moviePosition=otherScene:position({1,1,0})},
})
```

Camera lookat is local to its scene, distance is meters, angles are radians and
times are seconds. Camera frames replace the authored camera tracks. Sequence
positions are absolute integral block coordinates, obtained from each child
scene. Sequence keys replace the master movieblock track and preserve other
command tracks. Shots must start at zero, increase, and fit each child's duration;
the master duration defines the final shot end. Children must already be loaded.
Missing references or cycles fail before writing. Each child starts at its native
start time; author separate child movies when different edits are needed.

Select the existing owning group, then reopen movies with openMovie at the saved
coordinates before a revision. Change
only the intended camera, actor or child shot and preserve unaffected tracks.
Keep source and native MovieBlocks. Editing documentation does not save the world.

Inspect each child's beginning, strongest pose, transitions and end with independent
camera_capture using its moviePosition/timeSeconds and verified eye/lookat vectors.
Use actual planned camera framing rather than a generic overview. Check adjacent
shots for actor continuity, screen direction, staging and unintended empty frames.

For requested presentation playback use `scene:playMovie("film")`: it uses the
native manager/cameras and refuses to replace another active movie. It keeps the
job alive until completion; stop or cancel through the same job to clean up.
This intentionally uses the presentation camera; ordinary inspection uses independent
captures. Do not substitute scene:play's pose timer for full film playback.
Verify continuous playback and camera restoration as well as sampled stills.

Record the master coordinates and native activation/playback entry, storyboard,
child movies, actor assets, controlling code, module dependencies and verified
times in docs/movies.md or docs/movie-<name>.md. Save/reopen only when requested.
Retain unresolved timing/visual problems; a successful API result is not film QA.
