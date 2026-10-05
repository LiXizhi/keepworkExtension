# Wires and powered outputs / 导线与输出

Read [mechanisms.md](mechanisms.md) plus the chosen input subguide.

| Native registry name | ID | Role |
|---|---|---|
| `Wire` | 189 | Signal path; data is current strength 0–15 |
| `Lamp` / `Lamp_On` | 199 / 207 | Native unpowered/powered light |
| `Repeater` / `Repeater_On` | 197 / 198 | Directional signal regeneration/delay |

## Route and construct

Start with a short straight, same-level circuit: input at local (1,0,1), wires at
(2,0,1), (3,0,1), (4,0,1), and Lamp at (5,0,1), with solid supporting cells at y=-1.
This is a layout to verify, not a claim of a previously runtime-tested template.
Create supports and output, then these wires, and finally the idle input:

```lua
-- Inside an already bound scene; solid support and Lamp placed separately.
scene:box({position={2,0,1},dimensions={3,1,1},blockId="Wire",data=0});
```

Use face-connected runs rather than diagonal gaps. Native wire requires solid
support. Corners and branches should be intentional: adjacent wires can merge
circuits, and nearby powered solid blocks may carry indirect power. Do not assume
crossing paths are insulated. Inspect stepped routing and clearance above each
step; current Wire logic can consider neighboring wires one cell up/down depending
on normal-cube support and overhead obstruction. Verify vertical transitions
individually before concealing them inside architecture.

Wire strength attenuates along the path. Read data at the source, branch points
and far end instead of promising an unlimited connection or guessing a maximum
length from a different game. Add a native repeater before the received signal is
lost when the requested route needs it, oriented from upstream input to output.
Current repeater data uses low two bits for direction and bits 2–3 for four delay
settings (2, 4, 6, 8 simulation ticks). Resolve orientation through the engine's
`BlockLogic`/`Direction` mapping; it is not the button/lever mount table. Side input
can lock a repeater, so inspect side connections when diagnosing a stuck signal.

## Verify the output, not just wire appearance

Create Lamp in its off form; native power should change ID 199 → 207 → 199 during
an on/off test. Do not place Lamp_On as a substitute for a working connection.
With a door output, use the engine's native door assembly API and verify both
panels plus actual passage when powered/unpowered. Add pistons, trapdoors, command
blocks or other outputs only when relevant, after discovering their native
placement and activation rules; the lamp example does not validate every output.

If propagation fails, inspect in order: input native state, mounting support,
first wire strength, continuity/solid support, far-end strength, repeater direction
and side lock, then output neighbor power. Let normal native notifications and
scheduled updates run; assigning wire data 15 paints a state without proving a
signal source. Check both energizing and de-energizing after changes, particularly
at junctions. Keep a compact state trace alongside captures and record any
remaining unverified interaction in the world's mechanism notes.
