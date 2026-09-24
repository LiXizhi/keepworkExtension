# Keepwork local-model

`local-model` is a loopback-only model service for Keepwork desktop products. It
keeps model artifacts, declarative model configuration, runtime adapters, and
client transports separate. The first capability is 3D-Speaker ERes2Net Base
speaker embedding and comparison.

The service returns embeddings and cosine scores. It never applies a business
threshold and never returns `matched`; callers such as AIChat own that policy.

## Current Gate Status

The service, signed model package, CLI, HTTP API, Worker Thread runtime, bounded
queue, KP Local Helper supervisor, and native inference are implemented. AIChat now has an
experimental, default-off integration for enrollment and live speaker
filtering. The Node sherpa audio frontend still produces `0.87-0.89` cosine
against the existing Python/TorchAudio embeddings for the same WAV files, below
the original `0.99` parity target. This blocks broad release, not local
calibration and opt-in integration. See [release-gates.md](docs/release-gates.md).

## Layout

```text
configs/models/     schema-validated model behavior
models/             versioned model packages (including ONNX artifacts)
schemas/            JSON Schema for model YAML
src/core/           registry, lifecycle, integrity, errors, logging
src/runtimes/       registered runtime adapters
src/capabilities/   capability-specific input processing
src/transports/     HTTP and multipart transports
src/workers/        per-model Worker Thread implementation
scripts/            download, signing, parity, performance, and size tools
tests/              unit, HTTP, and native integration tests
```

## Install And Run

Requirement: Node.js 20 or newer. `npm` installs only the sherpa native package
for the current platform.

```bash
npm ci
npm run check
npm test
npm run build
npm start
```

Model artifacts are stored as ordinary Git blobs and versioned with the
repository. Their exact byte counts and SHA-256 values remain pinned in model
YAML files and signed manifests. `npm run model:download` remains available as
a recovery path when a trusted artifact mirror is configured with
`LOCAL_MODEL_ARTIFACT_URL`.

The server binds only to `127.0.0.1:18089`. Override allowed browser origins
with a comma-separated `LOCAL_MODEL_ALLOWED_ORIGINS`; this does not change the
loopback binding.

## CLI

```text
local-model serve [--port 18089]
local-model status
local-model models list
local-model models inspect <id>
local-model models verify <id>
local-model models load <id>
local-model models unload <id>
local-model speaker embedding --input <wav> [--model <id>]
local-model speaker compare --input <wav> --template <json> [--model <id>]
```

## Verification

```bash
npm run check
npm test
npm audit --audit-level=moderate
npm run benchmark -- --iterations 50 --soak-minutes 30
npm run parity
npm run size
```

`npm run parity` is a hard release gate and currently exits non-zero by design.
Reports are written under the ignored `reports/` directory.

## NodeRuntime package

`local-model` is staged as an Electron-managed Windows x64 NodeRuntime and
bundled only by `apps/local-helper` under `resources/local-model-runtime`.

```bash
npm run runtime:stage -- --platform win32 --arch x64
npm run runtime:smoke -- runtime-staging/windows-x64
```

The staged runtime contains its own Node.js executable, production
dependencies, compiled `dist/`, model configuration, manifests, and public
keys. Electron starts it with:

```text
app/dist/src/cli.js serve --port 18089
LOCAL_MODEL_ROOT=<runtime>/app
```

## Distribution boundary

This application has no Electron shell, independent installer, CI publisher or
CDN manifest. The Windows x64 KP Local Helper workflow stages it, runs all
tests and a real embedding, includes the complete runtime as `extraResources`,
then repeats health, trust and embedding checks after silently installing the
Helper. Any local-model change must increase the Local Helper SemVer.

The current unified installer is `internal / unsigned`. SmartScreen warnings
are expected. macOS and Linux downloads are not offered in the first release.
Model updates are delivered only through a complete Local Helper update.

## Model Signing

Maintainers sign a finalized model/config pair with an Ed25519 private key:

```bash
LOCAL_MODEL_SIGNING_KEY=/secure/path/private.pem npm run model:sign
```

`npm run model:sign -- --generate-dev-key` is only for local development. It
creates an ignored private key under `.keys/`; a production package must use a
release key managed outside the repository.

See [api.md](docs/api.md) and [architecture.md](docs/architecture.md) for the
protocol and ownership boundaries.
