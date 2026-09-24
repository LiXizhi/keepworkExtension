import type { AudioEncoding, ModelConfig } from '../../core/types.js';
import { LocalModelError } from '../../core/errors.js';

export interface AudioMetadata {
  encoding: AudioEncoding;
  sampleRate?: number;
  channels?: number;
}
export interface DecodedAudio {
  samples: Float32Array;
  sampleRate: number;
  channels: number;
}

function readAscii(buffer: Buffer, start: number, length: number): string {
  return buffer.subarray(start, start + length).toString('ascii');
}

function decodeWav(buffer: Buffer): DecodedAudio {
  if (buffer.length < 44 || readAscii(buffer, 0, 4) !== 'RIFF' || readAscii(buffer, 8, 4) !== 'WAVE') {
    throw new LocalModelError('AUDIO_INVALID', 'Invalid WAV header', { status: 400 });
  }
  let offset = 12;
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataSize = 0;
  while (offset + 8 <= buffer.length) {
    const id = readAscii(buffer, offset, 4);
    const size = buffer.readUInt32LE(offset + 4);
    const payload = offset + 8;
    if (payload + size > buffer.length) {
      throw new LocalModelError('AUDIO_INVALID', 'WAV chunk exceeds input length', { status: 400 });
    }
    if (id === 'fmt ') {
      if (size < 16) throw new LocalModelError('AUDIO_INVALID', 'WAV fmt chunk is too short', { status: 400 });
      format = buffer.readUInt16LE(payload);
      channels = buffer.readUInt16LE(payload + 2);
      sampleRate = buffer.readUInt32LE(payload + 4);
      bitsPerSample = buffer.readUInt16LE(payload + 14);
    } else if (id === 'data') {
      dataOffset = payload;
      dataSize = size;
      break;
    }
    offset = payload + size + (size % 2);
  }
  if (dataOffset < 0 || !sampleRate || !channels) {
    throw new LocalModelError('AUDIO_INVALID', 'WAV is missing fmt or data chunks', { status: 400 });
  }
  const bytesPerSample = bitsPerSample / 8;
  if (!Number.isInteger(bytesPerSample) || bytesPerSample <= 0 || dataSize % bytesPerSample !== 0) {
    throw new LocalModelError('AUDIO_INVALID', 'Unsupported WAV sample width', { status: 400 });
  }
  const count = dataSize / bytesPerSample;
  const samples = new Float32Array(count);
  if (format === 1 && bitsPerSample === 16) {
    for (let i = 0; i < count; i += 1) samples[i] = buffer.readInt16LE(dataOffset + i * 2) / 32768;
  } else if (format === 3 && bitsPerSample === 32) {
    for (let i = 0; i < count; i += 1) samples[i] = buffer.readFloatLE(dataOffset + i * 4);
  } else {
    throw new LocalModelError('AUDIO_UNSUPPORTED', `Unsupported WAV format ${format}/${bitsPerSample}`, { status: 415 });
  }
  return { samples, sampleRate, channels };
}

function decodeRaw(buffer: Buffer, metadata: AudioMetadata): DecodedAudio {
  const sampleRate = Number(metadata.sampleRate);
  const channels = Number(metadata.channels);
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
    throw new LocalModelError('AUDIO_METADATA_INVALID', 'Raw PCM sampleRate is invalid', { status: 400 });
  }
  if (!Number.isInteger(channels) || channels < 1 || channels > 8) {
    throw new LocalModelError('AUDIO_METADATA_INVALID', 'Raw PCM channels is invalid', { status: 400 });
  }
  if (metadata.encoding === 'pcm_s16le') {
    if (buffer.length % 2) throw new LocalModelError('AUDIO_INVALID', 'PCM16 byte length must be even', { status: 400 });
    const samples = new Float32Array(buffer.length / 2);
    for (let i = 0; i < samples.length; i += 1) samples[i] = buffer.readInt16LE(i * 2) / 32768;
    return { samples, sampleRate, channels };
  }
  if (metadata.encoding === 'pcm_f32le') {
    if (buffer.length % 4) throw new LocalModelError('AUDIO_INVALID', 'Float32 PCM byte length must be divisible by four', { status: 400 });
    const samples = new Float32Array(buffer.length / 4);
    for (let i = 0; i < samples.length; i += 1) samples[i] = buffer.readFloatLE(i * 4);
    return { samples, sampleRate, channels };
  }
  throw new LocalModelError('AUDIO_UNSUPPORTED', `Unsupported encoding: ${metadata.encoding}`, { status: 415 });
}

function downmix(samples: Float32Array, channels: number): Float32Array {
  if (channels === 1) return samples;
  if (samples.length % channels !== 0) {
    throw new LocalModelError('AUDIO_INVALID', 'Interleaved PCM length does not match channel count', { status: 400 });
  }
  const output = new Float32Array(samples.length / channels);
  for (let frame = 0; frame < output.length; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      sum += samples[frame * channels + channel] ?? 0;
    }
    output[frame] = sum / channels;
  }
  return output;
}

function resampleLinear(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return samples;
  const outputLength = Math.max(1, Math.round(samples.length * toRate / fromRate));
  const output = new Float32Array(outputLength);
  const ratio = fromRate / toRate;
  for (let i = 0; i < outputLength; i += 1) {
    const position = i * ratio;
    const left = Math.min(samples.length - 1, Math.floor(position));
    const right = Math.min(samples.length - 1, left + 1);
    const fraction = position - left;
    output[i] = (samples[left] ?? 0) * (1 - fraction) + (samples[right] ?? 0) * fraction;
  }
  return output;
}

export function decodeAndPrepareAudio(
  buffer: Buffer,
  metadata: AudioMetadata,
  config: ModelConfig,
): { samples: Float32Array; sampleRate: number; durationMs: number } {
  if (!config.input.encodings.includes(metadata.encoding)) {
    throw new LocalModelError('AUDIO_UNSUPPORTED', `Encoding ${metadata.encoding} is not allowed for this model`, { status: 415 });
  }
  const decoded = metadata.encoding === 'wav' ? decodeWav(buffer) : decodeRaw(buffer, metadata);
  for (const sample of decoded.samples) {
    if (!Number.isFinite(sample) || sample < -1.01 || sample > 1.01) {
      throw new LocalModelError('AUDIO_RANGE_INVALID', 'Audio samples must be finite values in [-1, 1]', { status: 400 });
    }
  }
  const mono = downmix(decoded.samples, decoded.channels);
  const samples = resampleLinear(mono, decoded.sampleRate, config.input.sampleRate);
  const durationMs = samples.length * 1000 / config.input.sampleRate;
  if (durationMs < config.input.minDurationMs || durationMs > config.input.maxDurationMs) {
    throw new LocalModelError(
      'AUDIO_DURATION_INVALID',
      `Audio duration ${Math.round(durationMs)}ms is outside ${config.input.minDurationMs}-${config.input.maxDurationMs}ms`,
      { status: 400 },
    );
  }
  return { samples, sampleRate: config.input.sampleRate, durationMs };
}

export function float32ToBuffer(values: Float32Array): Buffer {
  const buffer = Buffer.allocUnsafe(values.length * 4);
  for (let i = 0; i < values.length; i += 1) buffer.writeFloatLE(values[i] ?? 0, i * 4);
  return buffer;
}
