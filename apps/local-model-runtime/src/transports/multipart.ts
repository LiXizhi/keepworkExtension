import type { IncomingMessage } from 'node:http';
import Busboy from 'busboy';
import { LocalModelError } from '../core/errors.js';

const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;

export interface MultipartInferenceRequest {
  audio: Buffer;
  metadata: Record<string, unknown>;
}

export function parseInferenceMultipart(request: IncomingMessage): Promise<MultipartInferenceRequest> {
  const contentType = String(request.headers['content-type'] || '');
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    throw new LocalModelError('CONTENT_TYPE_INVALID', 'Expected multipart/form-data', { status: 415 });
  }
  return new Promise((resolve, reject) => {
    let parser: ReturnType<typeof Busboy>;
    try {
      parser = Busboy({
        headers: request.headers,
        limits: { files: 1, fields: 1, fileSize: MAX_AUDIO_BYTES, fieldSize: MAX_METADATA_BYTES, parts: 3 },
      });
    } catch (error) {
      reject(new LocalModelError('MULTIPART_INVALID', error instanceof Error ? error.message : String(error), { status: 400 }));
      return;
    }
    const chunks: Buffer[] = [];
    let metadataSource = '';
    let audioSeen = false;
    let audioTruncated = false;
    let settled = false;

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    parser.on('file', (name, stream) => {
      if (name !== 'audio' || audioSeen) {
        stream.resume();
        fail(new LocalModelError('MULTIPART_INVALID', 'Exactly one audio part is required', { status: 400 }));
        return;
      }
      audioSeen = true;
      stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      stream.on('limit', () => { audioTruncated = true; });
      stream.on('error', fail);
    });
    parser.on('field', (name, value, info) => {
      if (name !== 'metadata' || metadataSource || info.valueTruncated) {
        fail(new LocalModelError('MULTIPART_INVALID', 'Exactly one complete metadata field is required', { status: 400 }));
        return;
      }
      metadataSource = value;
    });
    parser.on('partsLimit', () => fail(new LocalModelError('MULTIPART_INVALID', 'Too many multipart parts', { status: 400 })));
    parser.on('filesLimit', () => fail(new LocalModelError('MULTIPART_INVALID', 'Too many audio files', { status: 400 })));
    parser.on('fieldsLimit', () => fail(new LocalModelError('MULTIPART_INVALID', 'Too many metadata fields', { status: 400 })));
    parser.on('error', fail);
    parser.on('close', () => {
      if (settled) return;
      if (!audioSeen || !chunks.length) {
        fail(new LocalModelError('AUDIO_MISSING', 'The audio multipart part is required', { status: 400 }));
        return;
      }
      if (audioTruncated) {
        fail(new LocalModelError('AUDIO_TOO_LARGE', `Audio exceeds ${MAX_AUDIO_BYTES} bytes`, { status: 413 }));
        return;
      }
      let metadata: unknown;
      try {
        metadata = JSON.parse(metadataSource || '{}');
      } catch {
        fail(new LocalModelError('METADATA_INVALID', 'metadata must be valid JSON', { status: 400 }));
        return;
      }
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        fail(new LocalModelError('METADATA_INVALID', 'metadata must be a JSON object', { status: 400 }));
        return;
      }
      settled = true;
      resolve({ audio: Buffer.concat(chunks), metadata: metadata as Record<string, unknown> });
    });
    request.pipe(parser);
  });
}
