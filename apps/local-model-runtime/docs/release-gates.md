# Release Gates

## Current Results

| Gate | Current result |
| --- | --- |
| TypeScript build and type check | Pass on macOS arm64 |
| Signed manifest, size, and SHA-256 | Pass |
| Native 512-d finite normalized embedding | Pass |
| Same-speaker score above different-speaker score | Pass (`0.5978 > 0.1387`) |
| 1.5 s inference p95 below 500 ms | Pass (`20.49 ms`, 50 iterations) |
| macOS arm64 base service production size | 36.4 MB / 34.7 MiB installed |
| macOS arm64 native runtime package | 34.2 MB / 32.6 MiB (not the earlier 13 MB WASM estimate) |
| macOS arm64 service plus model | 76.0 MB / 72.5 MiB before installer compression |
| Python/ONNX graph vs PyTorch cosine >= 0.99 | Pass (approximately `1.0`) |
| Node sherpa same-WAV vs Python cosine >= 0.99 | **Fail** (`0.8703-0.8910`) |
| 30-minute memory/queue soak | Not run while parity gate is failing |
| macOS x64 native run | Pending CI/artifact publication |
| Windows x64 native run | Pending CI/artifact publication |

The repository now defines an `internal / unsigned` Windows x64 distribution
through the unified KP Local Helper installer. This is a controlled-testing
mechanism, not evidence that the broad-release gates below have passed. The
GitHub Actions runner must smoke-test the staged runtime and the silently
installed Helper, including both loopback services and one real embedding.

The parity failure is isolated to the sherpa Node audio frontend: the exported
ONNX graph produces the same embeddings as PyTorch when both receive the same
Kaldi FBank features. It is not acceptable to reinterpret the passing graph
test as the required same-WAV end-to-end gate.

## Required Before Broad Release

1. Resolve the sherpa Node frontend mismatch or explicitly revise the parity
   acceptance rule with measured justification.
2. Publish the exact signed artifact at a stable URL.
3. Obtain a successful unified Windows x64 Local Helper build and installed-app
   smoke test; add native platform gates before claiming support for them.
4. Complete a 30-minute soak on each supported architecture and inspect RSS and
   queue depth for sustained growth.
5. Replace the development signing key with the production release key.

AIChat may use the service for default-off experimental enrollment, calibration,
and live voice filtering while these gates remain open. It must not treat the
current macOS arm64 result or unsigned installers as a cross-platform formal
release claim. Ordinary chat and Live Voice with speaker filtering disabled do
not depend on local-model.
