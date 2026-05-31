import pino from 'pino';

/**
 * Structured logger for TimeMark backend using pino.
 * - JSON output in production (ideal for Docker log aggregation)
 * - Sensitive field redaction
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: ['*.token', '*.password', '*.secret', '*.apiKey', '*.api_key'],
    censor: '[REDACTED]',
  },
});

/**
 * Create a child logger scoped to a specific module.
 */
export function createLogger(module: string) {
  return logger.child({ module });
}
