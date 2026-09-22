# Keepwork MCP NodeRuntime

Standalone Keepwork MCP with a bundled Node.js executable and production dependencies.
Each ZIP includes `runtime.json`, `LICENSE-node.txt`, `app/cli.cjs`,
`app/package.json`, `app/node_modules`, and either `node.exe` (Windows) or `bin/node`
(macOS). The adjacent platform JSON is the independent download/package manifest;
`runtime.json` inside the ZIP describes how a host launches the daemon.

External consumers: see the [CDN download contract](../../docs/node-runtime-cdn.md)
for the six fixed URLs, JSON fields, update detection and verification steps.

## Automatic CDN release

`.github/workflows/mcp-node-runtime.yml` runs on every push to `main`, including PR
merges, without requiring a version bump. It also supports **Run workflow** on
`main`; manual runs on other branches are skipped. This is independent of the
Local Helper installer release.

| Target | Native GitHub runner | CDN files |
| --- | --- | --- |
| Windows x64 | `windows-latest` | `windows-x64.zip`, `windows-x64.json` |
| macOS Apple Silicon | `macos-15` | `macos-arm64.zip`, `macos-arm64.json` |
| macOS Intel | `macos-15-intel` | `macos-x64.zip`, `macos-x64.json` |

Node.js is pinned by `KP_RUNTIME_NODE_VERSION` in the workflow (currently
`22.23.2`). Every build installs locked dependencies on the target OS, stages the
runtime, creates a ZIP, extracts it, and starts the extracted daemon on a temporary
loopback port. The smoke test checks health and creates a native PTY session. ZIPs
preserve macOS executable permissions and include native `node-pty` files. All three
builds must succeed before publication. The workflow retains each ZIP/JSON pair as
an Actions artifact.

Configure these repository Actions secrets, reusing the Local Helper credentials:

- `KP_QINIU_ACCESS_KEY`
- `KP_QINIU_SECRET_KEY`

They must be able to upload to bucket `haqi` and refresh `cdn.keepwork.com`.
The workflow uses the existing upload host `https://up-z2.qiniup.com` and object
prefix `keepwork/mcp-runtime/`. Credentials are provided only to the publish step.
No Git push, tag, version mutation, or GitHub Release is performed.

Every successful publication overwrites exactly these six objects:

```text
https://cdn.keepwork.com/keepwork/mcp-runtime/
  windows-x64.zip
  windows-x64.json
  macos-arm64.zip
  macos-arm64.json
  macos-x64.zip
  macos-x64.json
```

There are no version directories, timestamp/hash suffixes, or aggregate
`latest.json` uploads. Existing old directories and the earlier TXT test object are
not deleted. Each JSON contains the app `version`, source `commit`, `builtAt` UTC
time, Node version, platform/architecture, ZIP URL, byte size and SHA-256.

The publisher validates all three ZIP/JSON pairs before any remote write, including
source commit, app/Node versions, target identity, URL, timestamp, size and hash.
It overwrites the three ZIPs, refreshes and verifies their exact CDN URLs, then
overwrites, refreshes and verifies the three JSON files. Transport is shared in
`scripts/lib/qiniu-release.cjs`; product-specific schemas remain app-local.

Publish jobs are serialized. The publisher checks current remote `main` before
starting and skips superseded builds. Once replacement begins, it finishes that
publication even if `main` advances, to complete matching ZIP/JSON pairs. Newer
publications then run under the same lock. GitHub may replace pending publish jobs
with newer ones.

Six independent object replacements are not atomic: while a publication is running,
or if it fails partway, a JSON and ZIP can temporarily differ. Consumers must verify
the ZIP against JSON and retry both downloads if mismatched, retaining their working
installation until verification succeeds. An unsuccessful job should be rerun on
current `main` to complete replacement; this workflow does not preserve a CDN history
or provide automatic rollback.

## Local build and validation

From the repository root:

```bash
npm ci
npm ci --prefix apps/mcp-runtime
npm run stage --prefix apps/mcp-runtime -- --platform darwin --arch arm64
npm run smoke --prefix apps/mcp-runtime
npm run test:release --prefix apps/mcp-runtime
```

Use `--platform darwin --arch x64` on Intel macOS or `--platform win32 --arch x64`
on Windows. Without target flags, staging prepares all three targets, but a
release must be smoke tested on its native OS/architecture. Windows packaging uses
PowerShell 7 (`pwsh`); macOS uses system `zip`. Both are available on their runners.

Package the current native staging directory and smoke test the extracted ZIP:

```bash
npm run package --prefix apps/mcp-runtime -- --commit "$(git rev-parse HEAD)"
```

The output pair is written to `apps/mcp-runtime/release`. Optional `--prefix` and
`--domain` arguments select a different CDN base URL in the package JSON.

For an offline publication check, collect all three ZIP/JSON pairs in that directory:

```bash
node apps/mcp-runtime/scripts/release.cjs \
  --release-dir apps/mcp-runtime/release \
  --version 0.1.0 --commit "$(git rev-parse HEAD)" \
  --prefix keepwork/mcp-runtime/ --domain https://cdn.keepwork.com --dry-run
```

Use the version and commit that built those ZIPs. Dry-run validates and prints the
three independent manifests without writing any extra file, requiring credentials,
or accessing a remote service.
