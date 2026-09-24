# Architecture

## Boundaries

The model package contains only a model artifact, manifest, license, and
checksums. YAML describes the model contract and can only name adapters
registered in TypeScript. Configuration cannot load scripts or arbitrary code.

`ModelRegistry` owns adapter discovery. Each `SpeakerWorkerAdapter` owns one
Worker Thread, one native model instance, a serial bounded queue, load sharing,
request timeouts, and idle unload. A model error changes only that model's
state; it does not terminate the HTTP service.

```text
CLI / HTTP
    -> ModelRegistry
        -> SpeakerWorkerAdapter (lifecycle + queue)
            -> Worker Thread
                -> sherpa-onnx-node
                    -> signed ONNX artifact
```

Audio and embedding buffers cross the Worker boundary as transferables. The
main HTTP thread performs protocol parsing, bounded input validation, channel
mixing, and resampling but never executes native inference.

## Lifecycle

```text
not-installed -> unloaded -> loading -> ready -> unloading -> unloaded
                              |          |
                              +-> error <-+
```

Concurrent load calls wait on one load promise. Inference is serial for the
speaker model. Requests over the configured active-plus-queue capacity receive
`MODEL_QUEUE_FULL`. An active request timeout or cancellation terminates the
Worker because a synchronous native call cannot be interrupted safely; queued
requests fail and a later request can load a fresh Worker.

## Privacy

Structured logs contain request ID, model ID, operation, elapsed time, byte
count, and error code. They do not contain audio, embeddings, templates, or
threshold decisions. The service does not persist request payloads.

The server binds to IPv4 loopback only. Browser origins are allowlisted before
the request body is parsed, and Private Network Access preflights are answered
only for allowed origins. There is no WebSocket transport in version 1.

## Adding A Model

1. Add a versioned package under `models/<id>/<version>/`.
2. Add schema-valid YAML under `configs/models/`.
3. Implement and register a named adapter in source code.
4. Add capability tests and self-test fixtures.
5. Sign the finalized artifact and exact YAML source.
6. Pass platform, integrity, performance, memory, and privacy gates.

Adding a YAML file alone can never introduce executable code.
