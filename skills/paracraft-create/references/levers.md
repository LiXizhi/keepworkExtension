# Levers / 拉杆

Read [mechanisms.md](mechanisms.md), the mount-direction table in
[buttons.md](buttons.md), and [wiring.md](wiring.md) for connected outputs.
Use native `Lever` (ID 190) when the user needs a persistent manual on/off switch.

Mount on a solid support, with unpowered data 1–6 selected from that table. Data 5
is floor mounted; its on state is 13. Do not place an already powered lever merely
to make a presentation screenshot: build the idle circuit and activate it so
native neighbor notification establishes the signal path.

Example for an already bound scene with solid support below the local cell:

```lua
scene:box({position={1,0,1},dimensions={1,1,1},blockId="Lever",data=5});
```

`OnActivated` toggles direction ↔ direction+8 and notifies adjacent blocks and the
supporting block. It supplies weak power 15 while on and directional strong power.
`OnToggle` is empty; it is not an alternative activation API. Unlike a button,
the lever schedules no automatic release. Use it for a lamp switch or a manually
held-open door, with a reachable handle and a readable wire route.

Verify off → on, wait for propagation and confirm it stays on, then toggle again
and verify off. Repeat and restore the requested final state. Record both switch
and output states so an inverted/misrouted circuit cannot pass on appearance alone.
A handler-only `OnActivated` probe does not establish that the handle is reachable
by the user. For two controls feeding one output, also test each independently:
another energized branch can keep the output on when this lever is switched off.
