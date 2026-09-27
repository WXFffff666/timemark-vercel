import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { REDACT_PATHS, REDACTED_KEYS, buildLoggerOptions, createLoggerInstance } from '../logger.js';

/** In-memory destination: every pino line is appended verbatim. */
function createCapture(): { stream: Writable; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  return { stream, lines };
}

function parseLines(lines: readonly string[]): Record<string, unknown>[] {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * Walk serialized log entries and return the JSON paths whose string values
 * still contain a sentinel. The paths are printed on failure, so a regression
 * names the exact leaking path (e.g. `$.account.secret`).
 */
function collectSensitivePaths(value: unknown, sentinels: readonly string[], path = '$'): string[] {
  if (typeof value === 'string') {
    return sentinels.some((sentinel) => value.includes(sentinel)) ? [path] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectSensitivePaths(item, sentinels, `${path}[${index}]`));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      collectSensitivePaths(child, sentinels, `${path}.${key}`),
    );
  }
  return [];
}

describe('pino source-side redaction (todo 42)', () => {
  it('declares top-level and wildcard redact paths for every required key', () => {
    const required = ['token', 'secret', 'authorization', 'cookie', 'password', 'apiKey', 'webhook'];
    for (const key of required) {
      expect(REDACT_PATHS).toContain(key);
      expect(REDACT_PATHS).toContain(`*.${key}`);
      expect(REDACT_PATHS).toContain(`*.*.${key}`);
      expect(REDACT_PATHS).toContain(`*.*.*.${key}`);
    }
    // Backwards compatibility with the previous config plus the FCM service-account field.
    expect(REDACTED_KEYS).toEqual(expect.arrayContaining([...required, 'api_key', 'private_key']));
  });

  it('redacts the required keys (acceptance: no abc/def/ghi in the serialized output)', () => {
    const { stream, lines } = createCapture();
    const log = createLoggerInstance(stream);
    log.info(
      {
        token: 'abc',
        secret: 'def',
        password: 'ghi',
        authorization: 'Bearer auth-value',
        cookie: 'session=cookie-value',
        apiKey: 'api-key-value',
        webhook: 'https://hooks.example.com/T1/B2/webhook-value',
      },
      'redaction acceptance',
    );

    const raw = lines.join('');
    expect(raw).not.toContain('abc');
    expect(raw).not.toContain('def');
    expect(raw).not.toContain('ghi');
    expect(raw).not.toContain('auth-value');
    expect(raw).not.toContain('cookie-value');
    expect(raw).not.toContain('api-key-value');
    expect(raw).not.toContain('webhook-value');

    expect(parseLines(lines)).toHaveLength(1);
    expect(parseLines(lines)[0]).toMatchObject({
      token: '[REDACTED]',
      secret: '[REDACTED]',
      password: '[REDACTED]',
      authorization: '[REDACTED]',
      cookie: '[REDACTED]',
      apiKey: '[REDACTED]',
      webhook: '[REDACTED]',
      msg: 'redaction acceptance',
    });
  });

  it('redacts nested values via wildcards (failure scenario: { account: { secret: "x" } })', () => {
    const { stream, lines } = createCapture();
    const log = createLoggerInstance(stream);
    log.info(
      {
        account: { secret: 'x' },
        nested: { auth: { token: 'deep-token-level2' } },
        deep: { a: { b: { secret: 'deep-secret-level3' } } },
      },
      'deep redaction',
    );

    const raw = lines.join('');
    const entry = parseLines(lines)[0];
    const leaks = parseLines(lines).flatMap((parsed) =>
      collectSensitivePaths(parsed, ['deep-token-level2', 'deep-secret-level3']),
    );
    expect(leaks, `sensitive values leaked at: ${leaks.join(', ')}`).toEqual([]);
    expect(raw).not.toContain('"secret":"x"');
    expect(raw).not.toContain('deep-token-level2');
    expect(raw).not.toContain('deep-secret-level3');
    expect(entry).toMatchObject({
      account: { secret: '[REDACTED]' },
      nested: { auth: { token: '[REDACTED]' } },
      deep: { a: { b: { secret: '[REDACTED]' } } },
    });
  });

  it('detects a leak when a wildcard path is removed (guards the acceptance test itself)', () => {
    const { stream, lines } = createCapture();
    const options = buildLoggerOptions();
    const underRedacted = pino(
      {
        ...options,
        redact: {
          paths: [...REDACT_PATHS].filter((path) => path !== '*.secret'),
          censor: '[REDACTED]',
        },
      },
      stream,
    );
    underRedacted.info({ account: { secret: 'leak-x-42' } }, 'under-redacted');

    const leaks = parseLines(lines).flatMap((parsed) => collectSensitivePaths(parsed, ['leak-x-42']));
    expect(leaks).toEqual(['$.account.secret']);
    expect(lines.join('')).toContain('leak-x-42');
  });

  it('does not crash and does not leak on circular objects or Errors carrying secret properties', () => {
    const { stream, lines } = createCapture();
    const log = createLoggerInstance(stream);
    const circular: Record<string, unknown> = { label: 'loop' };
    circular.self = circular;
    const error = Object.assign(new Error('boom'), { secret: 'err-secret-42', safe: 'kept' });

    expect(() => log.info({ circular, err: error }, 'malformed input')).not.toThrow();

    const raw = lines.join('');
    expect(raw).toContain('[Circular]');
    expect(raw).not.toContain('err-secret-42');
    const entry = parseLines(lines)[0];
    expect(entry.circular).toMatchObject({ label: 'loop' });
    expect(entry.err).toMatchObject({ type: 'Error', message: 'boom', secret: '[REDACTED]', safe: 'kept' });
  });

  it('keeps the log shape for non-sensitive fields and adds no requestId outside a request', () => {
    const { stream, lines } = createCapture();
    const log = createLoggerInstance(stream);
    log.info({ event: 'shape.test', userId: 7, count: 3, nested: { ok: true } }, 'shape');

    expect(parseLines(lines)[0]).toMatchObject({
      level: 30,
      event: 'shape.test',
      userId: 7,
      count: 3,
      nested: { ok: true },
      msg: 'shape',
    });
    expect(parseLines(lines)[0]).not.toHaveProperty('requestId');
  });
});
