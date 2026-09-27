import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { AsyncLocalStorage } from 'async_hooks';

/**
 * Keys whose values must never reach a log destination. `api_key` is kept for
 * compatibility with the previous config; `private_key` covers the FCM
 * service-account JSON shape. Redaction happens at the logger level
 * (source-side), so a sink can never receive the plaintext value.
 */
export const REDACTED_KEYS = [
  'token',
  'secret',
  'password',
  'authorization',
  'cookie',
  'apiKey',
  'api_key',
  'webhook',
  'private_key',
  // Attachment download signatures / signed URLs must never reach a log sink (todo 57).
  'signature',
  'signedUrl',
  'signed_url',
] as const;

/** Wildcard levels below a key that are covered: `*.k`, `*.*.k`, `*.*.*.k`. */
const REDACT_WILDCARD_DEPTH = 3;

function buildRedactPaths(keys: readonly string[]): string[] {
  const paths: string[] = [];
  for (const key of keys) {
    paths.push(key);
    let prefix = '';
    for (let depth = 1; depth <= REDACT_WILDCARD_DEPTH; depth += 1) {
      prefix += '*.';
      paths.push(`${prefix}${key}`);
    }
  }
  return paths;
}

/**
 * The complete `redact.paths` list handed to pino: top-level keys plus nested
 * wildcard forms, so `{ account: { secret: 'x' } }` and deeper payloads are
 * redacted before serialization.
 */
export const REDACT_PATHS: readonly string[] = buildRedactPaths(REDACTED_KEYS);

export interface RequestLogContext {
  requestId: string;
  /** Request-scoped child logger (`logger.child({ requestId })`) created by the middleware. */
  logger: Logger;
}

const requestContext = new AsyncLocalStorage<RequestLogContext>();

/**
 * Options shared by the production singleton and by destination-injected test
 * instances (`createLoggerInstance(captureStream)`), so tests exercise the real
 * redaction and request-correlation configuration.
 */
export function buildLoggerOptions(): LoggerOptions {
  return {
    level: process.env.LOG_LEVEL || 'info',
    redact: {
      paths: [...REDACT_PATHS],
      censor: '[REDACTED]',
    },
    mixin(_mergeObject, _level, loggerInstance) {
      const ctx = requestContext.getStore();
      if (!ctx) return {};
      // Loggers created from the request-scoped child already carry `requestId`
      // as a binding. Returning it here as well would hit pino's documented
      // duplicate-keys caveat (docs/child-loggers.md#duplicate-keys-caveat) and
      // emit `"requestId":...,"requestId":...` in a single JSON line.
      if (loggerInstance.bindings().requestId === ctx.requestId) return {};
      return { requestId: ctx.requestId };
    },
  };
}

/** Create a pino instance with the production options; pass a destination to capture its output. */
export function createLoggerInstance(destination?: DestinationStream): Logger {
  return pino(buildLoggerOptions(), destination);
}

/** Structured logger for TimeMark backend using pino. */
export const logger = createLoggerInstance();

/**
 * Run `fn` with the request-scoped context so every subsequent `createLogger()`
 * call and every log line resolved through the mixin carries `requestId`.
 */
export function runWithRequestLog<T>(context: RequestLogContext, fn: () => T): T {
  return requestContext.run(context, fn);
}

/**
 * Create a child logger scoped to a specific module. Inside a request this
 * inherits the middleware's `logger.child({ requestId })`; outside a request it
 * falls back to the process-wide logger.
 */
export function createLogger(module: string): Logger {
  const scoped = requestContext.getStore()?.logger;
  return (scoped ?? logger).child({ module });
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
