# Common native mechanisms / 常用机关

Use for interactive switches, pressure triggers, wired lights and door controls.
Follow the root skill's client/world identity, world instructions, placement and
save rules. Load only the components required by the requested mechanism:

| Need | Subguide |
|---|---|
| Step-on trigger; automatic entrance | [pressure-plates.md](pressure-plates.md) |
| Momentary push; timed pulse | [buttons.md](buttons.md) |
| Persistent manual on/off switch | [levers.md](levers.md) |
| Signal path, branches, repeaters and powered outputs | [wiring.md](wiring.md) |

## Build a circuit with an observable result

Describe input → wire path → output and the intended reset behavior before placing
blocks. Use native functional blocks in world scenes, not colored imitations,
miniature voxels or exported BMax models. Keep supports, controls, signal paths and
outputs in named components with explicit cell ownership. Reserve usable player
access and inspect nearby circuits: native updates may affect connected blocks
outside the creation bounds. Isolate a new circuit from existing wiring unless a
connection is requested. Do not attach a test input to an unknown command block.

Check current capabilities and engine-owned `creation.md` through the CLI. Use
`scene:box` for single native cells with `dimensions={1,1,1}`, `blockId` and native
`data`; use exact registry names when `nativeBlockNames` is available. Do not pass
`color` or fractional `size` to electrical blocks. Place supports first, unpowered
outputs and wiring next, and inputs last; then exercise the input through native
behavior so neighbor updates run. A geometry rotation does not automatically
choose a button/lever/repeater's metadata direction.

The subguides' names/IDs and behavior are grounded in the ParaWorld source:
`config/Aries/creator/block_types.xml` and
`script/apps/Aries/Creator/Game/blocks/BlockPressurePlate.lua`, `BlockButton.lua`,
`BlockLever.lua`, `BlockWire.lua`, `BlockLogic.lua`, `BlockRepeater.lua` and
`BlockElectricLight.lua`. Paths identify implementation evidence, not remote MCP
resources. Verify names against the connected engine's `block_types.names` and
`block_types.get`; do not substitute Minecraft IDs or assume all Minecraft rules.
If deeper API details are needed, use the engine wiki or available source rather
than inventing `scene:wire`, a mechanism CLI action or a packaged circuit template.

## Functional acceptance and revision

Inspect the unpowered baseline, activate the intended input, observe wire/output
state, then release or switch off and verify reset. Repeat once to detect a stuck
state. Use native interaction/collision for end-to-end verification. A direct
`OnActivated` call tests the button/lever handler only; assigning powered metadata
tests neither activation nor propagation. For native developer probes use the
documented `run_npl_code` and `tail_log` workflow. Keep developer probes distinct
from creation `run_code` jobs and use each action's actual schema.

Capture readable placement and output views, but also record block IDs/data at
the input, representative wires and output before/during/after activation. Allow
scheduled simulation ticks between observations; tick counts are not guaranteed
wall-clock seconds. If native interaction cannot be exercised, report the exact
untested behavior instead of declaring the mechanism working. Preserve the main
player and camera; restore temporary test entities and test switch states.

Simulation can change metadata and even output IDs after creation. Inspect live
members before group revision/undo; powered lamps, buttons and wires may no longer
match authored fingerprints. Do not force-overwrite stale cells or assume helpers
undo arbitrary native probe calls or all propagation effects. Return the circuit
to its intended idle state and re-inspect before a bounded revision.

Record the input/output coordinates, wire route, support/mount direction, idle
state, timing, external connections and verified behavior in world-local
`docs/mechanisms.md` when useful, linked through the world's existing docs. Follow
[world-memory.md](world-memory.md) for updates and separate native save state.
Do not add scripts or command blocks when a simple native circuit meets the request.
