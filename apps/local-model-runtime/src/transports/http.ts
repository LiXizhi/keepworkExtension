import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import type { ModelRegistry } from '../core/registry.js';
import { asLocalModelError, LocalModelError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { decodeAndPrepareAudio } from '../capabilities/speaker/audio.js';
import { parseInferenceMultipart } from './multipart.js';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 18089;
export const PROTOCOL_VERSION = '1.0.0';

const DEFAULT_ALLOWED_ORIGINS = new Set([
  'https://keepwork.com',
  'https://www.keepwork.com',
  'http://127.0.0.1:3000',
  'http://localhost:3000',
  'http://127.0.0.1:3001',
  'http://localhost:3001',
]);

function allowedOrigins(): Set<string> {
  const configured = String(process.env.LOCAL_MODEL_ALLOWED_ORIGINS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  return new Set([...DEFAULT_ALLOWED_ORIGINS, ...configured]);
}

function applyCors(request: IncomingMessage, response: ServerResponse): boolean {
  const origin = String(request.headers.origin || '');
  if (origin && !allowedOrigins().has(origin)) return false;
  if (origin) response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Vary', 'Origin, Access-Control-Request-Private-Network');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Request-Id');
  response.setHeader('Access-Control-Max-Age', '600');
  if (request.headers['access-control-request-private-network'] === 'true') {
    response.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  return true;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(payload);
}

function requestIdFor(request: IncomingMessage): string {
  const candidate = String(request.headers['x-request-id'] || '');
  return /^[A-Za-z0-9._:-]{1,100}$/.test(candidate) ? candidate : randomUUID();
}

function stringMetadata(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' && value ? value : undefined;
}

function numericTemplate(metadata: Record<string, unknown>): Float32Array | undefined {
  const value = metadata.template;
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(item => typeof item !== 'number' || !Number.isFinite(item))) {
    throw new LocalModelError('TEMPLATE_INVALID', 'template must be an array of finite numbers', { status: 400 });
  }
  return Float32Array.from(value as number[]);
}

export interface LocalModelHttpService {
  server: Server;
  origin: string;
  close(): Promise<void>;
}

export async function startHttpService(
  registry: ModelRegistry,
  options: { port?: number; host?: string } = {},
): Promise<LocalModelHttpService> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  if (host !== '127.0.0.1') throw new Error('local-model must bind to 127.0.0.1');

  const server = createServer(async (request, response) => {
    const started = performance.now();
    const requestId = requestIdFor(request);
    response.setHeader('X-Request-Id', requestId);
    if (!applyCors(request, response)) {
      json(response, 403, { requestId, error: { code: 'ORIGIN_FORBIDDEN', message: 'Origin is not allowed', retryable: false } });
      return;
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }
    const url = new URL(request.url || '/', `http://${host}:${port}`);
    let modelId: string | undefined;
    let operation: 'embedding' | 'compare' | undefined;
    let requestBytes = 0;
    try {
      if (request.method === 'GET' && url.pathname === '/v1/health') {
        json(response, 200, {
          requestId,
          service: 'keepwork-local-model',
          version: '0.1.0',
          protocolVersion: PROTOCOL_VERSION,
          status: 'ok',
          models: registry.list().map(model => ({ id: model.id, state: model.state, installed: model.installed, trusted: model.trusted })),
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/models') {
        json(response, 200, { requestId, models: registry.list() });
        return;
      }
      const modelMatch = /^\/v1\/models\/([^/]+)(?:\/(load|unload))?$/.exec(url.pathname);
      if (modelMatch) {
        modelId = decodeURIComponent(modelMatch[1] ?? '');
        const action = modelMatch[2];
        if (request.method === 'GET' && !action) {
          json(response, 200, { requestId, model: registry.getInfo(modelId) });
          return;
        }
        if (request.method === 'POST' && action === 'load') {
          json(response, 200, { requestId, model: await registry.load(modelId) });
          return;
        }
        if (request.method === 'POST' && action === 'unload') {
          json(response, 200, { requestId, model: await registry.unload(modelId) });
          return;
        }
      }
      const speakerMatch = /^\/v1\/speaker\/(embedding|compare)$/.exec(url.pathname);
      if (request.method === 'POST' && speakerMatch) {
        operation = speakerMatch[1] as 'embedding' | 'compare';
        const parsed = await parseInferenceMultipart(request);
        requestBytes = parsed.audio.length;
        modelId = stringMetadata(parsed.metadata, 'modelId');
        const config = registry.getSpeakerConfig(modelId);
        const encoding = stringMetadata(parsed.metadata, 'encoding');
        if (!encoding || !['pcm_f32le', 'pcm_s16le', 'wav'].includes(encoding)) {
          throw new LocalModelError('METADATA_INVALID', 'encoding must be pcm_f32le, pcm_s16le, or wav', { status: 400 });
        }
        const prepared = decodeAndPrepareAudio(parsed.audio, {
          encoding: encoding as 'pcm_f32le' | 'pcm_s16le' | 'wav',
          ...(typeof parsed.metadata.sampleRate === 'number' ? { sampleRate: parsed.metadata.sampleRate } : {}),
          ...(typeof parsed.metadata.channels === 'number' ? { channels: parsed.metadata.channels } : {}),
        }, config);
        const controller = new AbortController();
        request.once('aborted', () => controller.abort());
        const template = operation === 'compare' ? numericTemplate(parsed.metadata) : undefined;
        const result = await registry.invokeSpeaker(operation, {
          samples: prepared.samples,
          sampleRate: prepared.sampleRate,
          ...(template ? { template } : {}),
        }, controller.signal, modelId);
        if ('embedding' in result.output) {
          json(response, 200, {
            requestId,
            modelId: result.model.id,
            modelVersion: result.model.version,
            dimension: result.model.output.dimension,
            formatVersion: result.model.output.formatVersion,
            normalized: true,
            durationMs: prepared.durationMs,
            processingMs: result.output.processingMs,
            embedding: Array.from(result.output.embedding),
          });
        } else {
          json(response, 200, {
            requestId,
            modelId: result.model.id,
            modelVersion: result.model.version,
            formatVersion: result.model.output.formatVersion,
            durationMs: prepared.durationMs,
            processingMs: result.output.processingMs,
            score: result.output.score,
          });
        }
        logger.info('request.complete', {
          requestId, modelId: result.model.id, operation, elapsedMs: performance.now() - started, bytes: requestBytes,
        });
        return;
      }
      throw new LocalModelError('NOT_FOUND', 'Endpoint not found', { status: 404 });
    } catch (error) {
      const local = asLocalModelError(error);
      logger.warn('request.error', {
        requestId,
        ...(modelId ? { modelId } : {}),
        ...(operation ? { operation } : {}),
        elapsedMs: performance.now() - started,
        bytes: requestBytes,
        code: local.code,
      });
      if (!response.headersSent) json(response, local.status, { requestId, error: local.toBody() });
      else response.destroy();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const origin = `http://${host}:${actualPort}`;
  logger.info('service.started', { origin, protocolVersion: PROTOCOL_VERSION });
  return {
    server,
    origin,
    async close() {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await registry.dispose();
    },
  };
}
