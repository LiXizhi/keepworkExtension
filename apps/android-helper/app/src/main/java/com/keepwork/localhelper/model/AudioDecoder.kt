package com.keepwork.localhelper.model

import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder

data class DecodedAudio(val samples: FloatArray, val sampleRate: Int)

object AudioDecoder {
    fun decode(audio: ByteArray, metadata: JSONObject): DecodedAudio {
        val encoding = metadata.getString("encoding")
        val decoded = when (encoding) {
            "pcm_f32le" -> rawFloat(audio, metadata.getInt("sampleRate"), metadata.getInt("channels"))
            "pcm_s16le" -> rawInt16(audio, metadata.getInt("sampleRate"), metadata.getInt("channels"))
            "wav" -> wav(audio)
            else -> throw IllegalArgumentException("Unsupported encoding: $encoding")
        }
        require(decoded.samples.all { it.isFinite() && it in -1.01f..1.01f }) { "Audio samples must be finite values in [-1, 1]" }
        return decoded
    }

    private fun rawFloat(bytes: ByteArray, rate: Int, channels: Int): DecodedAudio {
        require(bytes.size % 4 == 0) { "Float32 PCM length must be divisible by four" }
        val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        return DecodedAudio(downmix(FloatArray(bytes.size / 4) { buffer.float }, channels), validRate(rate))
    }

    private fun rawInt16(bytes: ByteArray, rate: Int, channels: Int): DecodedAudio {
        require(bytes.size % 2 == 0) { "PCM16 length must be even" }
        val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        return DecodedAudio(downmix(FloatArray(bytes.size / 2) { buffer.short / 32768f }, channels), validRate(rate))
    }

    private fun wav(bytes: ByteArray): DecodedAudio {
        require(bytes.size >= 44 && ascii(bytes, 0, 4) == "RIFF" && ascii(bytes, 8, 4) == "WAVE") { "Invalid WAV header" }
        val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        var offset = 12
        var format = 0
        var channels = 0
        var sampleRate = 0
        var bits = 0
        var dataOffset = -1
        var dataSize = 0
        while (offset + 8 <= bytes.size) {
            val id = ascii(bytes, offset, 4)
            val size = buffer.getInt(offset + 4)
            val payload = offset + 8
            require(size >= 0 && payload + size <= bytes.size) { "Invalid WAV chunk" }
            if (id == "fmt ") {
                require(size >= 16) { "WAV format chunk is too short" }
                format = buffer.getShort(payload).toInt()
                channels = buffer.getShort(payload + 2).toInt()
                sampleRate = buffer.getInt(payload + 4)
                bits = buffer.getShort(payload + 14).toInt()
            } else if (id == "data") {
                dataOffset = payload
                dataSize = size
                break
            }
            offset = payload + size + (size and 1)
        }
        require(dataOffset >= 0 && channels in 1..8) { "WAV is missing audio data" }
        val samples = when {
            format == 1 && bits == 16 -> FloatArray(dataSize / 2) { buffer.getShort(dataOffset + it * 2) / 32768f }
            format == 3 && bits == 32 -> FloatArray(dataSize / 4) { buffer.getFloat(dataOffset + it * 4) }
            else -> throw IllegalArgumentException("Unsupported WAV format $format/$bits")
        }
        return DecodedAudio(downmix(samples, channels), validRate(sampleRate))
    }

    private fun downmix(samples: FloatArray, channels: Int): FloatArray {
        require(channels in 1..8 && samples.size % channels == 0) { "Invalid channel count" }
        if (channels == 1) return samples
        return FloatArray(samples.size / channels) { frame ->
            var sum = 0f
            repeat(channels) { sum += samples[frame * channels + it] }
            sum / channels
        }
    }

    private fun validRate(rate: Int): Int = rate.also { require(it in 8000..192000) { "Invalid sample rate" } }
    private fun ascii(bytes: ByteArray, offset: Int, size: Int) = String(bytes, offset, size, Charsets.US_ASCII)
}
