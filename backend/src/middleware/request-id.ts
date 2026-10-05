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
    const startedAt = Date.now();
    try {
      await runWithRequestLog({ requestId, logger: requestLogger }, () => next());
    } finally {
      // v2.28 C11：补响应侧日志（status + 耗时）——此前只有请求侧，5xx/慢请求不可观测
      requestLogger.info(
        {
          event: 'http.request.completed',
          method: c.req.method,
          path: c.req.path,
          status: c.res.status,
          durationMs: Date.now() - startedAt,
        },
        'Request completed',
      );
    }
  };
}

export const requestIdMiddleware = createRequestIdMiddleware();
