import pino from 'pino';
import { AsyncLocalStorage } from 'async_hooks';

const requestContext = new AsyncLocalStorage<{ requestId?: string }>();

/**
 * Structured logger for TimeMark backend using pino.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: ['*.token', '*.password', '*.secret', '*.apiKey', '*.api_key'],
    censor: '[REDACTED]',
  },
  mixin() {
    const ctx = requestContext.getStore();
    return ctx?.requestId ? { requestId: ctx.requestId } : {};
  },
});

export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return requestContext.run({ requestId }, fn);
}

/**
 * Create a child logger scoped to a specific module.
 */
export function createLogger(module: string) {
  return logger.child({ module });
}

/**
 * Build a `.catch()` handler for fire-and-forget promises so a rejection is
 * routed into pino (carrying the request id via the AsyncLocalStorage mixin)
 * with a STABLE `event` field instead of being silently swallowed.
 *
 * Usage: `somePromise().catch(logFireAndForget('notification.retry_enqueue_failed', 'Failed to enqueue retry'))`
 */
export function logFireAndForget(event: string, message?: string) {
  return (error: unknown): void => {
    logger.warn({ event, err: error }, message ?? event);
  };
}
