# Optional native sign-in

Use when the user asks to 登录 Paracraft or an intended online operation requires
an account. Anonymous local creation/loading/saving is supported by
[local-worlds.md](local-worlds.md); do not insert login as a prerequisite there.
No username/password/token parameters are accepted by the client launcher.

Select/start the intended client with [client-startup.md](client-startup.md).
For an entered world, the existing native `/signin` command opens the client's
normal sign-in flow if needed:

```json
{"action":"run_command","clientId":"<client>","params":{"command":"/signin"}}
{"action":"bring_to_front","clientId":"<client>","params":{}}
```

Command dispatch is not proof of completed login. Let the user complete the native
credentials/verification flow. At the main menu use the native sign-in control;
if the installed CLI cannot run commands there, explain that UI step rather than
fabricating a login action or opening an unrelated world. Do not ask for passwords
or tokens in chat, copy another tool's credentials, or put them in URLs/source/docs.

Retain the current world and unsaved work across sign-in. Refresh client/world
status and capabilities after the user completes the flow. Report account state
only from an actual supported native observation, user confirmation or success of
the requested account-dependent operation; worldEntered/client registration alone
establish neither login nor cloud rights. A signed-in user can still lack access
to a private world. Do not repeatedly prompt for sign-in after cancellation.

Proceed with the originally requested local/online work. Login itself does not
authorize uploading, syncing or publishing local worlds, and it need not be
performed for ordinary local scene creation. Account-dependent save roots may
change; keep the actual returned worldPath and recheck before named world open.
