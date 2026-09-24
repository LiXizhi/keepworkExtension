import type { ModelErrorBody } from './types.js';

export class LocalModelError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number;
  readonly details?: unknown;

  constructor(
    code: string,
    message: string,
    options: { retryable?: boolean; status?: number; details?: unknown } = {},
  ) {
    super(message);
    this.name = 'LocalModelError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status ?? 500;
    this.details = options.details;
  }

  toBody(): ModelErrorBody {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}
export function asLocalModelError(error: unknown): LocalModelError {
  if (error instanceof LocalModelError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new LocalModelError('INTERNAL_ERROR', message || 'Unexpected local model error');
}
