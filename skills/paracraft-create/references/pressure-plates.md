# Pressure plates / 压力板

Read [mechanisms.md](mechanisms.md) for shared placement and verification rules;
read [wiring.md](wiring.md) when connecting an output.

| Native registry name | ID | Initial data |
|---|---|---|
| `Stone_Pressure_Plate` | 200 | 0 |
| `Wooden_Pressure_Plate` | 201 | 0 |

Both currently use `BlockPressurePlate`. Choose their visible material; do not
claim Minecraft-style stone-versus-wood trigger filtering. The implementation
queries entities in the cell and their `doesEntityTriggerPressurePlate()` result.
Metadata 0 is released; 1 is pressed and supplies power 15. It supplies weak power
and strong power toward the supporting block below, and notifies both its own
neighbors and those of the block below when the state changes.

Place a plate in the walkable air cell above a solid floor, with approach and exit
clearance. It owns a whole native cell despite its thin appearance. Example inside
an already bound scene with a verified supporting floor at local y=-1:

```lua
scene:box({position={1,0,1},dimensions={1,1,1},
    blockId="Stone_Pressure_Plate",data=0});
```

For a step-on light, run a short same-level wire from the plate to a native Lamp.
For an automatic entrance, route power to the actual native door assembly and
test entry and exit; use the documented two-cell door helper for construction.
Place the plate where the player can reach and leave it without blocking the
door's movement or becoming trapped when power drops.

## Verify collision and release

Observe an empty plate at data 0, move a qualifying entity onto it through native
collision, verify data 1 and output activation, then leave and observe reset.
The plate rechecks occupied state on scheduled updates (`tickRate()` is 20 in the
current source), so release is not necessarily instantaneous. Do not convert this
to a fixed number of seconds without checking simulation timing.

`OnActivated` and `OnToggle` are empty on this class: clicking it or calling those
methods does not simulate stepping on it. Directly assigning data 1 bypasses
collision, neighbor notification and scheduled release. If the plate stays down,
inspect lingering entities and scheduled simulation before replacing it. Test the
intended entity type; visual overlap by a model alone is not pressure activation.
