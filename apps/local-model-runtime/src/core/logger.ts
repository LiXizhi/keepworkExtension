export interface LogFields {
  requestId?: string;
  modelId?: string;
  operation?: string;
  elapsedMs?: number;
  bytes?: number;
  code?: string;
  [key: string]: unknown;
}

function write(level: 'info' | 'warn' | 'error', event: string, fields: LogFields = {}): void {
  const record = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...fields,
  });
  if (level === 'error') process.stderr.write(`${record}\n`);
  else process.stdout.write(`${record}\n`);
}

export const logger = {
  info: (event: string, fields?: LogFields) => write('info', event, fields),
  warn: (event: string, fields?: LogFields) => write('warn', event, fields),
  error: (event: string, fields?: LogFields) => write('error', event, fields),
};
