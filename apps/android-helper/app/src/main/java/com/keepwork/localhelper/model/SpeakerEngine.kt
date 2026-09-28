package com.keepwork.localhelper.model

import android.content.Context
import com.k2fsa.sherpa.onnx.SpeakerEmbeddingExtractor
import com.k2fsa.sherpa.onnx.SpeakerEmbeddingExtractorConfig
import com.keepwork.localhelper.AppConstants
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

class SpeakerEngine(private val context: Context, val verified: VerifiedModel) : AutoCloseable {
    private val executor = Executors.newSingleThreadExecutor()
    private val idleExecutor = Executors.newSingleThreadScheduledExecutor()
    @Volatile private var extractor: SpeakerEmbeddingExtractor? = null
    @Volatile private var state = "unloaded"
    private var idleTask: ScheduledFuture<*>? = null

    fun state() = state

    fun loadModel(): String = executor.submit<String> { load(); state }.get(10, TimeUnit.SECONDS)
    fun unloadModel(): String = executor.submit<String> { unloadInternal(); state }.get(10, TimeUnit.SECONDS)

    fun embedding(samples: FloatArray, sampleRate: Int): FloatArray = executor.submit<FloatArray> {
        val prepared = resample(validate(samples), sampleRate, 16_000)
        val durationMs = prepared.size * 1000.0 / 16_000
        require(durationMs in 300.0..15_000.0) { "Audio duration must be between 300 and 15000 ms" }
        val model = load()
        val stream = model.createStream()
        try {
            stream.acceptWaveform(prepared, 16_000)
            stream.inputFinished()
            require(model.isReady(stream)) { "Audio is too short for speaker embedding extraction" }
            normalize(model.compute(stream))
        } finally {
            stream.release()
            scheduleIdleUnload()
        }
    }.get(10, TimeUnit.SECONDS)

    fun compare(samples: FloatArray, sampleRate: Int, template: FloatArray): Float {
        require(template.size == AppConstants.MODEL_DIMENSION) { "Template dimension must be ${AppConstants.MODEL_DIMENSION}" }
        val left = embedding(samples, sampleRate)
        val right = normalize(template)
        return left.indices.sumOf { (left[it] * right[it]).toDouble() }.toFloat().coerceIn(-1f, 1f)
    }

    @Synchronized
    private fun load(): SpeakerEmbeddingExtractor {
        extractor?.let { return it }
        state = "loading"
        return try {
            SpeakerEmbeddingExtractor(
                context.assets,
                SpeakerEmbeddingExtractorConfig(verified.assetPath, numThreads = 1, debug = false, provider = "cpu"),
            ).also {
                require(it.dim() == verified.dimension) { "Model dimension ${it.dim()} does not match ${verified.dimension}" }
                extractor = it
                state = "ready"
            }
        } catch (error: Throwable) {
            state = "error"
            throw error
        }
    }

    @Synchronized
    private fun unloadInternal() {
        idleTask?.cancel(false)
        idleTask = null
        extractor?.release()
        extractor = null
        state = "unloaded"
    }

    @Synchronized
    private fun scheduleIdleUnload() {
        idleTask?.cancel(false)
        idleTask = idleExecutor.schedule({ executor.execute(::unloadInternal) }, 10, TimeUnit.MINUTES)
    }

    override fun close() {
        idleExecutor.shutdownNow()
        runCatching { executor.submit { unloadInternal() }.get(2, TimeUnit.SECONDS) }
        executor.shutdownNow()
    }

    private fun validate(input: FloatArray): FloatArray {
        require(input.isNotEmpty()) { "Audio samples are empty" }
        require(input.all { it.isFinite() && it in -1.01f..1.01f }) { "Audio samples must be finite values in [-1, 1]" }
        return input
    }

    private fun resample(input: FloatArray, from: Int, to: Int): FloatArray {
        require(from in 8000..192000) { "Invalid sample rate" }
        if (from == to) return input
        val output = FloatArray(max(1, (input.size.toDouble() * to / from).toInt()))
        val ratio = from.toDouble() / to
        for (index in output.indices) {
            val position = index * ratio
            val left = min(input.lastIndex, floor(position).toInt())
            val right = min(input.lastIndex, left + 1)
            val fraction = (position - left).toFloat()
            output[index] = input[left] * (1 - fraction) + input[right] * fraction
        }
        return output
    }

    private fun normalize(values: FloatArray): FloatArray {
        require(values.size == verified.dimension) { "Model returned ${values.size} values instead of ${verified.dimension}" }
        var squared = 0.0
        for (value in values) {
            require(value.isFinite()) { "Model returned a non-finite embedding" }
            squared += value * value
        }
        val norm = sqrt(squared).toFloat()
        require(norm > 0) { "Model returned a zero embedding" }
        return FloatArray(values.size) { values[it] / norm }
    }
}
