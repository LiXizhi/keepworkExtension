# Paracraft CLI hub + WASM NPL code wiki

The Keepwork MCP daemon on `http://127.0.0.1:8089` is more than MCP tools. It is also the **loopback hub** for desktop Paracraft and the **HTTP front** for the NPL code wiki inside web-paracraft (WASM).

Engine side (identity, `http_request`, `site_url`): `c:/lxzsrc/ParaEngine/paraworld` → `docs/aries/paracraft-cli.md`.  
AIChat UI: `tools/Paracraft/ParacraftTool.html` + `docs/local-mcp.md`.

Bind **127.0.0.1 only**. Never expose `:8089` on the LAN.

## Desktop clients

Desktop Paracraft registers on start (`POST /paracraft/register`). While this daemon is up it also scans `127.0.0.1:8099-8115` and pings `/ajax/paracraft_cli?action=health`.

- If `nplPort` pings, the hub returns `useNpl: true` and dispatches to that NPL HTTP port (no long-poll).
- Otherwise the client long-polls `POST /paracraft/:id/jobs/poll` (and heartbeats) until the hub goes down.
- `GET /paracraft/clients` lists **desktop** clients only. WASM (`platform=wasm`) is omitted so AIChat does not duplicate the web iframe as a desktop tile.

Public actions: `health`, `world_status`, `run_command`, `screenshot`, `open_world`, `exit`, `bring_to_front`. Do not put `http_request` on this allowlist or on the timeline.

## WASM NPL code wiki

Web-paracraft (typically `:8088`) cannot bind a TCP port, so it cannot run desktop’s `:8099` wiki. This daemon is the listener; the WASM iframe is the origin of every response (ParaIO + NPL `.page` / `ajax/console` / `ajax/debugger`).

Saved NPL server root (`WebServer:site_url()` inside WASM):

`http://127.0.0.1:<port>/webserver/<instance>/`

Wiki paths on that root: `console`, `debugger`, `ajax/debugger`, `ajax/console`, `/wp-includes/…`.

### Handshake

1. WASM `GET /health`. Require `name === "keepwork-mcp"` and `webserverBase` (loopback origin, not a hardcoded 8089 if `keepwork.mcp.port` changed).
2. `POST /paracraft/register` with `platform: "wasm"`. The hub **assigns** `webparacraft1`, `webparacraft2`, … (reclaims the client’s previous slug if still free). Response includes `webserverInstance` and `webserverRoot` (trailing slash). WASM must save both; it must not invent a date/hex slug. Duplicate live desktop instance names are still rejected. Hub mapping is in-memory: F11 / `/webserver` always re-registers. WASM retries register after a hub restart.
3. WASM stores that string as `WebServer.site_host_url`. F11 / `/open npl://…` then open Keepwork wiki URLs **inside the WASM tab** (iframe docked to the right by default; 3D canvas shrinks so they do not overlap; URL copied to clipboard). Do not `window.open` — Chrome may suspend the host.
4. WASM: browser `fetch()` long-polls jobs (JS `KeepworkHub`, not NPL `GetUrl`). After wiki jobs, NPL handles files on the game thread; network stays off that thread. Idle `waitMs` may stay up to 10s.

If `/health` fails, WASM must **not** claim the wiki started.

### Proxy

| Piece | Behavior |
|-------|----------|
| `ALL /webserver/:instance/*` | Strip prefix, enqueue `http_request` `{ method, path, headers, bodyBase64 }`, wait, write status/headers/body |
| Cookie `Keepwork-WebServer=<instance>` | Set on the first `/webserver/:instance/…` response. Routes root-absolute `/wp-includes`, `/ajax`, `*.page` that omit the prefix (wiki HTML uses `/wp-includes/js/NPL.js`) |
| Coalesce ~10ms | Parallel CSS/JS become one `flushJobs()` poll payload |
| `POST /paracraft/:id/jobs/results` | `{ results: [{ jobId, result }] }` — one HTTP call for many file bodies |
| Timeout | `http_request` slightly above the 15s CLI timeout (page compile); body cap 16MB; binary as base64 |

Wiki bytes come from WASM, not `GET /fs/file`.

## Code

| Path | Role |
|------|------|
| `src/core/paracraftClients.ts` | Register, job queue, coalesce, `listClients` (hide wasm), `webserverRoot` |
| `src/core/webserverProxy.ts` | `/webserver/:instance/*` + cookie fallback |
| `src/mcp/http.ts` | `GET /health` `webserverBase`; route wiki after `/paracraft/*` |

## Try it

1. Restart Keepwork MCP so `/health` includes `webserverBase` (`npm run compile:only` then restart the daemon / F5 the extension).
2. Open web-paracraft with Keepwork MCP running.
3. F11 or `/webserver` in the iframe.
4. Open `http://127.0.0.1:8089/webserver/webparacraft1/console` (or the ParacraftTool **Code Wiki** button). `GET /health` lists live `webservers`.
