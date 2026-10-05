# Create, load and save a named local world

Use for 新建指定世界、本地世界、不登录创作、加载世界、重新打开、保存世界.
Start/select the corresponding client using [client-startup.md](client-startup.md).
Read the installed engine's `world-management.md` using `read_official_wiki`.
`manage_world` is not an action: all structured local operations below use
`run_command`, with the operation inside `params.world`. Retain clientId/chat ID.

## Read current status

```json
{"action":"run_command","clientId":"<client>","params":{"world":{"operation":"status"}}}
```

Retain actual worldPath/worldEntered. The returned path, not a guessed working
directory, pins subsequent open/save operations. Native results may be wrapped
in the gateway's result envelope: inspect inner ok/status/completed as well as
transport success. Status works before world entry. An entered unrelated world
may contain unsaved work; preserve it rather than silently discarding prompts.

## Create by name

```json
{"action":"run_command","clientId":"<client>","params":{"world":{"operation":"create","name":"雪山村庄"}}}
```

Use the requested name. Names can contain spaces/Unicode but are simple folder
names, not absolute paths; separators, control characters, traversal and unsafe
filename characters are rejected. Native creation uses the client's current
default local save root (which can be affected by account/configuration filters).
It returns worldPath: retain that path. Do not assume the extension cwd, always
hard-code worlds/MyWorlds, or create an empty directory instead of native metadata.

Creation makes a superflat local world with its metadata; it does not open it,
log in, upload or overwrite an existing world. `status:"exists"` means the named
world already exists, not a newly created blank world. Inspect before editing or
reusing it; do not delete/recreate it to satisfy a "new" request. An existing
directory without tag.xml is an error. A mountain/biome name labels the world;
landscape generation is a subsequent [terrain-biomes.md](terrain-biomes.md) task.

## Open or reopen

When the user requests creating and working in a world, opening that new world is
part of the request. Pass the actual prior worldPath (empty string only when status
returned no path), and acknowledge the switch with the required argument:

```json
{"action":"run_command","clientId":"<client>","params":{"world":{"operation":"open","name":"雪山村庄","expectedWorldPath":"<prior status worldPath>","confirmSwitch":true}}}
```

`open_requested` and `completed:false` acknowledge asynchronous loading. Poll
status on this same client until worldEntered is true and worldPath agrees with
the creation result. If pending stops progressing, inspect the same client/logs
and native prompts; do not repeatedly open or edit the old world. Changed-current-
world errors require rereading status and reassessing the intended switch.

Named open resolves under the current default save root. To load a user-specified
existing world outside it, inspect its actual path/metadata and use the engine's
`open_world` with `params.path` after establishing the intended switch and unsaved
state. Native paths are plain strings with spaces/Unicode, without shell quotes.
This raw-path route does not have the structured expectedWorldPath guard; verify
status immediately before dispatch and poll actual entry afterward. Never move a
world into the default root merely to make named open work.

After any open/reopen, refetch capabilities and exact creation identity. Discard
old session IDs/object handles even if the path is unchanged. Read world AGENTS.md
and its docs; initialize world_docs before the first edit if needed. Continue with
[world-memory.md](world-memory.md) and the relevant art guide.

## Save native world data

On a user request to save (including a prior instruction to create and save),
finish intended edits, retain source/manifests when appropriate, then read current
status and call:

```json
{"action":"run_command","clientId":"<client>","params":{"world":{"operation":"save","expectedWorldPath":"<current status worldPath>"}}}
```

Require inner `ok:true`, `status:"saved"`, `completed:true`, `localOnly:true` and
the expected path before reporting local saving. This saves current native world
data through normal SaveAll permissions; it never forces a read-only/remote save.
Denied saves and disk errors are failures, not reasons to weaken native checks.
If the response is lost, verify status/disk state before claiming completion;
do not replay construction. When reopen verification is in scope, verify entered
path, a fresh session and the actual changed objects after reopening.

Creation metadata, world_docs writes, `scene:save()` source/manifest persistence,
exports and native world saving are distinct. Do not report one as another. Keep
source in creation/<name>/, exports in blocktemplates/ and documentation directly
in docs/. Update docs/changes.md with actual verified save state.

## Anonymous or signed in

Local create/open/save uses the same route in either state; there is no mandatory
account login in this workflow. Preserve the active account and its selected local
root. Anonymous local use does not mean cloud sync, publishing or private project
access succeeds. If the user wants login, use [login.md](login.md); afterward
refresh status, default-root expectations and world identity rather than assuming
the name still resolves to the same local path. Do not log out an existing user
just because the task mentions that login is optional.
