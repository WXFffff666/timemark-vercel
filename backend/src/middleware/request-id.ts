import { Context, Next } from 'hono';
import { randomUUID } from 'crypto';
import type { Logger } from 'pino';
import { logger, runWithRequestLog } from '../utils/logger.js';

/**
 * Build the request-id middleware around a base logger. The exported
 * `requestIdMiddleware` below is wired to the shared `logger`; tests inject a
 * capture-destination instance to assert log correlation without touching stdout.
 */
export function createRequestIdMiddleware(baseLogger: Logger = logger) {
  return async function requestIdMiddleware(c: Context, next: Next): Promise<void> {
    const requestId = c.req.header('X-Request-ID') || randomUUID();
    c.set('requestId', requestId);
    c.header('X-Request-ID', requestId);
    // Downstream calls inherit this child (via runWithRequestLog + createLogger),
    // so every log line in the request carries the same requestId.
    const requestLogger = baseLogger.child({ requestId });
    requestLogger.info(
      { event: 'http.request.received', method: c.req.method, path: c.req.path },
      'Request received',
    );
    await runWithRequestLog({ requestId, logger: requestLogger }, () => next());
  };
}

export const requestIdMiddleware = createRequestIdMiddleware();
