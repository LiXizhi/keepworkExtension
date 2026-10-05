# Buttons / 按钮

Read [mechanisms.md](mechanisms.md) and, for wired outputs,
[wiring.md](wiring.md). Use native `Stone_Button` (ID 105), a momentary pulse input.
It is not a latch; use [levers.md](levers.md) for persistent manual power.

## Mount and direction

Build the solid support first. These are current native metadata values shared
by Button and Lever; offsets point from the control cell to its support:

| Unpressed data | Support offset |
|---|---|
| 1 | +X |
| 2 | -Z |
| 3 | -X |
| 4 | +Z |
| 5 | -Y (floor mounted) |
| 6 | +Y (ceiling mounted) |

Use a valid direction instead of data 0 or 8. Pressed data is direction + 8.
For a floor-mounted button in a bound scene with support below:

```lua
scene:box({position={1,0,1},dimensions={1,1,1},
    blockId="Stone_Button",data=5});
```

For wall mounting, choose an accessible height near the entrance and the direction
matching the actual support, then inspect the rendered face. Rotating placement
coordinates alone does not rotate native metadata. Preserve the direction when
reading/changing the state; do not replace every pressed value with a constant.

## Pulse and reset

Native `OnActivated` raises the state, notifies neighbors including the supporting
side, and schedules a reset after 20 simulation ticks in the current source.
Already pressed buttons return without extending that schedule. Powered weak
output is 15; strong output depends on the support direction.

Test one press → output on → automatic reset/output off, then a second press after
release. Sample during the pulse; a delayed screenshot may miss it. Do not promise
a particular duration in seconds or hold-to-run behavior. If the requested device
needs a longer pulse or a latch, design and verify that additional circuit rather
than silently replacing the button's native semantics.

An isolated handler probe may call the live block instance's
`OnActivated(x,y,z,entity)` using absolute block coordinates; label it as a handler
test. Real click accessibility still requires interaction verification. Never
prove operation by forcing the button or lamp to its powered metadata/ID.
