# HTTP API

Protocol version: `1.0.0`. Default origin: `http://127.0.0.1:18089`.

## Endpoints

```text
GET  /v1/health
GET  /v1/models
GET  /v1/models/:modelId
POST /v1/models/:modelId/load
POST /v1/models/:modelId/unload
POST /v1/speaker/embedding
POST /v1/speaker/compare
```

Speaker operations use `multipart/form-data` with exactly two fields:

- `audio`: binary Float32 PCM, PCM16, or WAV. Base64 is not accepted.
- `metadata`: a JSON string.

Raw PCM metadata requires `encoding`, `sampleRate`, and `channels`. WAV metadata
requires only `encoding: "wav"`. Optional `modelId` selects a configured model.
Compare additionally requires `template`, an array of 512 finite numbers.

```bash
curl -F 'metadata={"encoding":"wav"}' \
  -F 'audio=@sample.wav;type=audio/wav' \
  http://127.0.0.1:18089/v1/speaker/embedding
```

Embedding responses contain `modelId`, `modelVersion`, `dimension`,
`formatVersion`, `normalized`, `durationMs`, `processingMs`, and `embedding`.
Compare responses replace embedding fields with `score`. There is deliberately
no `matched` field and no threshold parameter.

Every response has `X-Request-Id`. A valid caller-provided `X-Request-Id` is
preserved; otherwise the service generates a UUID.

## Errors

Errors use this stable envelope:

```json
{
  "requestId": "...",
  "error": {
    "code": "MODEL_QUEUE_FULL",
    "message": "Model inference queue is full",
    "retryable": true
  }
}
```

Important codes include:

```text
ORIGIN_FORBIDDEN             browser origin is not allowed
MODEL_NOT_FOUND              model ID is unknown
MODEL_NOT_INSTALLED          artifact is absent
MODEL_SIZE_MISMATCH          artifact byte count differs
MODEL_HASH_MISMATCH          artifact SHA-256 differs
MODEL_MANIFEST_MISMATCH      signed manifest and YAML differ
MODEL_SIGNATURE_INVALID      manifest signature is invalid
MODEL_LOAD_FAILED            native model initialization failed
MODEL_LOAD_TIMEOUT           Worker initialization timed out
MODEL_TIMEOUT                inference timed out
MODEL_QUEUE_FULL             bounded queue is full
MODEL_WORKER_CRASHED         Worker exited unexpectedly
REQUEST_ABORTED              caller disconnected or cancelled
AUDIO_INVALID                malformed PCM or WAV
AUDIO_RANGE_INVALID          non-finite or out-of-range samples
AUDIO_DURATION_INVALID       audio duration is outside model limits
TEMPLATE_INVALID             compare template is missing or malformed
```

See [openapi.yaml](../openapi.yaml) for the machine-readable surface.
