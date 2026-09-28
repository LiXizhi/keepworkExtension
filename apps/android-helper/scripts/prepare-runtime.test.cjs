const assert = require('node:assert/strict');
const test = require('node:test');
const { assertSafeArchiveEntry, canonicalize, selectNativeEntries } = require('./prepare-runtime.cjs');

test('canonical JSON is deterministic for signed model metadata', () => {
  assert.equal(canonicalize({ z: 1, a: { y: true, x: [2, 'v'] } }), '{"a":{"x":[2,"v"],"y":true},"z":1}');
});

test('archive extraction rejects traversal and absolute paths', () => {
  for (const unsafe of ['../outside', 'root/../../outside', '/tmp/file', 'C:/temp/file']) {
    assert.throws(() => assertSafeArchiveEntry(unsafe), /Unsafe sherpa archive entry/);
  }
  assert.equal(assertSafeArchiveEntry('./sherpa/arm64-v8a/lib/lib.so'), 'sherpa/arm64-v8a/lib/lib.so');
});

test('native library selection is arm64-only and unambiguous', () => {
  assert.deepEqual(selectNativeEntries([
    'sherpa/jni/arm64-v8a/libsherpa-onnx-jni.so',
    'sherpa/jni/arm64-v8a/libonnxruntime.so',
    'sherpa/jni/x86_64/libsherpa-onnx-jni.so',
    'sherpa/jni/x86_64/libonnxruntime.so',
  ]), {
    'libsherpa-onnx-jni.so': 'sherpa/jni/arm64-v8a/libsherpa-onnx-jni.so',
    'libonnxruntime.so': 'sherpa/jni/arm64-v8a/libonnxruntime.so',
  });
  assert.equal(selectNativeEntries([
    'sherpa/jni/x86_64/libsherpa-onnx-jni.so',
    'sherpa/jni/x86_64/libonnxruntime.so',
  ], 'x86_64')['libonnxruntime.so'], 'sherpa/jni/x86_64/libonnxruntime.so');
});
