import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestCtx {
    signal?: AbortSignal;
    sessionId: string;
    origin: string;
    userAgent: string;
}

export const requestContext = new AsyncLocalStorage<RequestCtx>();

export function currentRequest(): RequestCtx {
    return requestContext.getStore() || { sessionId: '', origin: '', userAgent: '' };
}
