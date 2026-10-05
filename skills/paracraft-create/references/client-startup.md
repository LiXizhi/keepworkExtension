# Start or reuse a Paracraft client

Use for 启动客户端、打开 Paracraft and preparing a local-world workspace. Read
[connection.md](connection.md) for the single gateway and chat identity. This is
an on-demand subguide of paracraft-create, loaded via `skill` with this path.

First call `clients`. Match the user's client/project/world context, not the first
row or a browser tab label. Reuse an appropriate existing desktop; never close
other clients or replace their current worlds just to obtain documentation.
For a selected client read bundled `world-management.md` via `read_official_wiki`
before world entry. Engine docs need a connected client, not a loaded world.

## Local startup without an online project

If no suitable client exists:

```json
{"action":"launch","params":{"waitSeconds":15}}
```

Omitting `projectId` uses the installed Windows protocol
`paracraft://protocol="paracraft" debug="main"`. It reuses an idle desktop
with `worldEntered:false`, or starts a client without selecting an online project.
It supplies no login token and does not force login/logout. A `target:"client"`
launch becomes `ready` on desktop registration; a world need not have entered.
Read its status before continuing with [local-worlds.md](local-worlds.md).
An old gateway requiring projectId cannot do this route: report that the gateway
needs rebuilding/updating, rather than opening an unrelated online project.

## Online project startup

```json
{"action":"launch","params":{"projectId":530,"waitSeconds":15}}
```

Substitute the actual requested positive integer ID; 530 is only an example.
This uses `paracraft://cmd/loadworld <id> debug="main"`. Reuse requires matching
project, desktop platform and worldEntered. `target:"project"` becomes ready
only when that project has entered, not just when its process registers. Public
project access and private/account requirements depend on the native client;
do not equate supplying an ID with successful authentication.

## Pending launch and handoff

Both modes return `launchId`; poll:

```json
{"action":"launch_status","params":{"launchId":"<returned launchId>","waitSeconds":15}}
```

Retain target/clientId and the original launch ID. Concurrent pending launches of
the same mode/project share one launch. A transport timeout is not a reason to
open another process: poll the known launch, or discover clients and recover the
same pending target if the initial response was lost. Registration has a 60-second
deadline. On failure inspect clients/service/installed protocol before a deliberate
new attempt. Unsupported platform or missing handler requires that installation
to be corrected; do not run guessed engine executables or kill existing worlds.

For a registered client, `health` and `run_command` world status distinguish main
menu, loading and entered state. For a new client without a project, verify the
returned client before changing its world: simultaneous unrelated desktop starts
can also register during the waiting interval. Use `bring_to_front` if the user
needs the native window. After entry fetch fresh creation identity and read the
world's AGENTS.md. Startup alone creates/saves no world and claims no login state.

Repository development uses its approved launcher/CLI tests, not a production
fallback to a direct executable. Keep the singleton MCP hub and terminal approval
rules unchanged. See [login.md](login.md) only when sign-in is relevant.
