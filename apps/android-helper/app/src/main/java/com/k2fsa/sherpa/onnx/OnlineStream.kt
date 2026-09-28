// Derived from sherpa-onnx v1.13.8 (Apache-2.0).
package com.k2fsa.sherpa.onnx

class OnlineStream(var ptr: Long = 0) {
    init { require(ptr != 0L) { "Failed to create native OnlineStream" } }

    fun acceptWaveform(samples: FloatArray, sampleRate: Int) = acceptWaveform(ptr, samples, sampleRate)
    fun inputFinished() = inputFinished(ptr)
    fun setOption(key: String, value: String) = setOption(ptr, key, value)
    fun getOption(key: String): String = getOption(ptr, key)
    fun release() {
        if (ptr != 0L) {
            delete(ptr)
            ptr = 0
        }
    }

    private external fun acceptWaveform(ptr: Long, samples: FloatArray, sampleRate: Int)
    private external fun inputFinished(ptr: Long)
    private external fun setOption(ptr: Long, key: String, value: String)
    private external fun getOption(ptr: Long, key: String): String
    private external fun delete(ptr: Long)

    companion object { init { System.loadLibrary("sherpa-onnx-jni") } }
}
