# Paracraft creation: 50-round integrated native campaign

Completed 2026-10-07. **50/50 rounds passed** the final evidence audit, including
manual review of 100 fresh native images. There are **25 design briefs run with
two write strategies**, not 50 unrelated designs or 50 circuit states.

## Scope and evidence

Five families (woodland village, desert courtyard, snow outpost, riverside bridge
village, stone intersection) each have five geometry/control variants. Every
round uses its own local `CreationAcceptance_Integrated50_20261006_RNN` world.
Each task builds two houses with open doors and filled gables, native half-block
roofs, connected roads, seating, three trees, relief and native controls. The
river family adds a contained water trench and a bridge with half-height approaches.

Each round independently verifies a scoped roof-color revision, unchanged actual
native cells outside the target, the complete revised generator, native save,
reopen with a new session, exact saved/reopened static signatures, route and door
clearance, circuit truth/reset/retrigger, and fresh overview/entrance captures.
Circuit variants include `Enable AND (A OR B)`, OR, AND, delay chains, naturally
releasing buttons, fanout and longer connections. Timing transitions are observed
in the running native simulator; output cells are not forced to expected states.

Final independent audit: 50 actual saved generators, 200 completed creation and
inspection jobs, 25 pairs with exactly equal native static geometry, **486 circuit
assertions**, **30,906 geometry checks**, 112 slab collision-box records, 2,210
outside-water checks, and 100 image byte/hash/session checks. Each image has an
explicit pixel-review record tied to its SHA-256. Total authored membership across
all worlds is 106,438 cells. Archived failures are retained and resolved separately.

The reproducible sources are:

- `scripts/fixtures/paracraft-integrated-catalog.cjs`: deterministic briefs and generators.
- `scripts/paracraft-integrated-50-native.cjs`: native execution, checkpointed recovery and evidence.
- `scripts/paracraft-integrated-50-audit.cjs`: persistence, pair equivalence and explicit visual-review gate.

Local campaign evidence remains at
`C:/Users/Administrator/AppData/Local/Temp/paracraft-integrated-50-20261006/`.
It contains per-round requests, terminal jobs, source, signatures, geometry,
native timing, images, recovery archives, `visual-review.json` and `audit.json`.
The separate independent audit is
`C:/Users/Administrator/AppData/Local/Temp/paracraft-integrated-50-independent-audit.json`.

## Measured efficiency

Matched rounds preserve geometry, materials and authored membership. The baseline
uses single-cell helpers; the alternative merges equal-material contiguous X rows
into spans. Both retain native helper guards and cooperative yielding.
Elapsed time uses each terminal native job's `finishedAt-startedAt`, excluding
HTTP observation time. No unmeasured phase is presented as scouting time.

| Metric | Result |
| --- | --- |
| Median paired native build ratio | 1.463× (31.7% less elapsed time) |
| Paired ratio range | 1.344–1.564× |
| Single-cell native build median | 19.141 s |
| Span native build median | 13.079 s |
| Median helper reduction | 84.8% (6.568× fewer calls) |

The first pair uses 1,966 versus 290 helpers, with 18.812 versus 13.360 s native
elapsed time. Fewer helper calls do not translate directly into an equal total
speed ratio: both strategies retain shared site validation, inspection, saving
and cooperative waits. Circuit waiting is required behavior verification.

A further opportunity is leaving compliant ground untouched: the first pair
rewrites 1,422 grass cells whose original and final ID/data are identical.
Another is bounding construction height to actual authored carriers instead of
empty height above them. Both recommendations now appear in the skill, but their
additional speed benefit was **not measured** in this campaign, and they were not
silently mixed into the span group.

## Corrections retained in the skill and runner

- Creation-code mocks must match the real sandbox. `ParaGlobal` is unavailable
  there; native task timestamps supply elapsed time. R02 failed before its first
  scene creation and was retried only after proving no created scene or files.
- Same-path `open_requested` can initially report the old entered world. Wait for
  the new session on the same client, without dispatching another open. R09 was
  recovered using its already requested reopen.
- Main-camera preservation needs a settled viewport baseline. R01's first-render
  aspect initialization and R31's later eye change remain in recovery archives.
  R31's cause is unknown; its recheck proves the fresh capture interval only.
- Bridge approach support requires actual collision bounds and lower-half data;
  `solid=false` does not disqualify an obstructing native slab. R31's four false
  failures were replaced by collision-box and 0→0.5→1 m route-height checks.
- World document `expectedContent` is the full read text, while replacement
  `content` is only the managed section, without managed markers. Document
  recovery never rebuilds native geometry.

Updated canonical references cover efficient integrated planning, native elapsed
measurement, camera baseline stability, session-aware persistence and collision
support. They are synchronized into the VS Code, local-helper and MCP-runtime
packages. Guide/build regression tests passed 7/7; skill quick validation passed.

## Quality limits

These are sparse technical integrated scenes, not finished environment art.
The desert path has modest contrast, and the river bridge is small in the overview;
native collision/water checks provide stronger geometric evidence than those
pixels alone. Roofs, filled gables, trees, roads and open door approaches were
reviewed in every round. Actual player walking/crossing and screen-coordinate
clicking were not tested. The campaign does not claim coverage of every film,
animation, rig, asset-export or other creation-skill feature.
