---
name: agent-cli-verify
description: Discover, install and verify Keepwork MCP agent CLIs on Windows/macOS. Use for missing CLI setup, model discovery, slow connections and all-provider acceptance, including real tools, continuation and history reads without resubmission.
---

# Keepwork MCP CLI verification

Development upkeep uses repository `.github/skills/agent-cli-maintenance/SKILL.md`
and per-platform references under this same Skill; these are not runtime
catalogue entries or packaged editor chat Skills. Runtime clients read plain
`references/providers/<backend>.md` installation references and the reviewed
[installation catalogue](references/providers.json), synchronized to AIChat and
available as MCP resources. Read only the selected platform's reference.

Keepwork owns the unified `/agents` interface. CLI authentication, models and native tools remain provider owned. WorkBuddy uses the documented CodeBuddy ACP engine (`codebuddy --acp`); this does not automate the WorkBuddy desktop window.

Read [the shared API contract](https://github.com/LiXizhi/keepworkExtension/blob/main/docs/agent-harnesses.md) when changing adapters. Supported providers are discovered through `GET /agents/backends`; unknown or newly supported providers must never disappear silently from an acceptance report.

## Run

From a Keepwork MCP source checkout:

1. `npm run check:shared`
2. `node --test scripts/agent-sessions.test.cjs scripts/agent-backends.test.cjs scripts/agent-cli-discovery.test.cjs scripts/claude-harness.test.cjs`
3. `node scripts/agent-cli-smoke.cjs` starts an isolated loopback service from source and runs every supported backend. It does not replace the user's production daemon.

For an installed daemon, run the adjacent [verification script](scripts/verify.cjs):

```sh
node /path/to/skills/agent-cli-verify/scripts/verify.cjs --url http://127.0.0.1:8089
```

If pairing is required, supply `KEEPWORK_MCP_TOKEN` through the existing local environment; never print it, put it in command arguments or copy it into reports. Only loopback URLs are accepted. Tests create two temporary local workspace folders, ask the provider to read/write known Unicode markers there, continue its session, repeat snapshot reads, and read history after archiving/unarchiving through the same owned HTTP API. They do not restart the daemon or submit a turn after restoration. Temporary work is confined by the prompts; native CLI tool permissions are approved only within this explicitly requested acceptance run. No user repositories are modified.

`--backend <id>` queries only the selected backend; it is not an all-provider acceptance. `--probe-only` distinguishes executable, native account-status, native model-catalog and confirmed protocol-handshake checks, and explicitly records real execution as **not tested**. Unknown optional protocol metadata stays unknown. Configure daemon-side `KEEPWORK_<BACKEND>_PATH` if discovery fails; use native binaries or JS entries on Windows. Common install directories are searched again after a missing-CLI failure without restarting the daemon; restart only for changed daemon environment overrides.

## Install a missing CLI

When the user requests installation or connecting a platform that needs installation, read [installation recipes](references/install.md). MCP clients can read the same guide at `keepwork://skills/agent-cli-verify/references/install.md`. Reuse existing authorization for the selected provider; do not ask again solely because this skill was loaded. In AIChat, use the available Keepwork `run_terminal` tool and its normal confirmation flow. Install only missing prerequisites for the requested provider; desktop applications and standalone Agent CLIs are distinct. Preserve credentials and let the user complete interactive login. Discovery failure by itself does not authorize installing every provider.

## Judge results

The script writes a JSON report under `out/agent-cli-verify/` (or `--report <file>`), prints one result per backend, and returns nonzero if any required backend is unavailable, fails, or is not tested. Deterministic fixtures establish protocol behavior; only an authenticated real turn establishes actual CLI operation. An ACP handshake alone cannot establish authentication.

Do not call skipped, missing, unauthenticated, unsupported resume, or timed-out providers “passed”. Preserve each provider's result and explain the exact prerequisite to rerun it. Do not install unrelated providers, log in as the user, retry ambiguous prompts, change native policies, or publish results.

Real smoke checks explicit provider routing, Unicode output, tools writing both roots, two turns, duplicate-request turn IDs, history reads and cleanup. It accepts native permission requests encountered during the scoped test; it does not independently count native side effects. Owner-isolation failures, permission denials, forced interruption, production Origin/auth/CORS/PNA checks and browser behavior require separate tests.

Reports add `checkDefinitions` and `limitations` without removing legacy check IDs. `snapshot-reconnect` means another GET of the current snapshot, not a disconnected network; `history-resume` means archive/unarchive plus reading existing history, not a daemon restart or a resumed third turn. Do not infer stronger coverage from older reports lacking these definitions. A run establishes evidence only for its recorded OS/architecture and tested local providers; report unavailable and untested cases separately.

## Discovery diagnosis

Inspect `cli.path` and `cli.source` in `/agents/backends` and the verification
report before suggesting PATH edits or reinstalling. Automatic discovery searches
Windows npm/WinGet/Scoop and desktop bundles, and macOS Homebrew/npm/NVM/Volta and
application bundles. A missing CLI is searched again on the next connection.
An explicit invalid path must be corrected; it deliberately does not fall back.
Report discovery, ACP handshake and authenticated execution separately. Desktop
WorkBuddy login is not proof of CLI login; some desktop CLI bundles have no
interactive login module. The standalone official CLI can be needed in that case.

## Provider protocols

Supported IDs live in [the packaged catalogue](references/backends.json). The
runtime test verifies it matches `src/core/agentCliBackends.ts`. An older daemon
missing one of these IDs must report that provider unavailable. Include unexpected
advertised IDs in full verification; do not silently narrow a full run.

Codex uses App Server; Claude uses native bidirectional stream-json; Antigravity
uses native agy NDJSON under the persisted `gemini` backend key. The remaining
providers use native ACP. Claude probe-only checks its executable/version and,
when supported, its read-only native account status; it neither starts a protocol
session nor logs in. Antigravity probe-only reads its native model catalog. An
actual session/turn is required to exercise those providers' execution protocols.
Cursor user questions and plans must wait for explicit answers. Native model and
permission settings remain provider owned. Use [protocol and launch references](https://github.com/LiXizhi/keepworkExtension/blob/main/docs/agent-harnesses.md#provider-launch-contracts)
when diagnosing an incompatible version rather than guessing flags or introducing
an unverified third-party bridge. Never call fixture or browser-mocked tests real
provider acceptance. CLI installs and logins are separate user-authorized actions.
