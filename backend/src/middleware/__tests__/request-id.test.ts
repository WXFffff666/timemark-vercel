import { Writable } from 'node:stream';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createRequestIdMiddleware } from '../request-id.js';
import { createLogger, createLoggerInstance } from '../../utils/logger.js';

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

function buildApp(stream: Writable): Hono<{ Variables: { requestId: string } }> {
  const app = new Hono<{ Variables: { requestId: string } }>();
  app.use('*', createRequestIdMiddleware(createLoggerInstance(stream)));
  app.get('/probe', (c) => {
    const handlerLog = createLogger('handler-under-test');
    handlerLog.info({ event: 'handler.test' }, 'handler log');
    return c.text(c.get('requestId') ?? 'missing');
  });
  return app;
}

describe('request-id middleware correlation (todo 42)', () => {
  it('stamps the same requestId on the middleware log and a handler log, exactly once per line', async () => {
    const { stream, lines } = createCapture();
    const app = buildApp(stream);

    const res = await app.request('/probe', { headers: { 'X-Request-ID': 'req-correlated-42' } });

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Request-ID')).toBe('req-correlated-42');
    expect(await res.text()).toBe('req-correlated-42');

    // v2.28 C11：新增响应侧完成日志（http.request.completed），一行请求 + 一行处理 + 一行完成
    expect(lines).toHaveLength(3);
    const entries = parseLines(lines);
    const middlewareEntry = entries.find((entry) => entry.event === 'http.request.received');
    const completedEntry = entries.find((entry) => entry.event === 'http.request.completed');
    const handlerEntry = entries.find((entry) => entry.event === 'handler.test');
    expect(middlewareEntry?.requestId).toBe('req-correlated-42');
    expect(completedEntry?.requestId).toBe('req-correlated-42');
    expect(completedEntry?.status).toBe(200);
    expect(typeof completedEntry?.durationMs).toBe('number');
    expect(handlerEntry?.requestId).toBe('req-correlated-42');

    // pino duplicate-keys caveat: a single JSON line must not contain requestId twice.
    for (const line of lines) {
      expect(line.match(/"requestId"/g) ?? []).toHaveLength(1);
    }
  });

  it('generates a requestId when the header is absent and correlates it downstream', async () => {
    const { stream, lines } = createCapture();
    const app = buildApp(stream);

    const res = await app.request('/probe');

    const requestId = res.headers.get('X-Request-ID');
    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(await res.text()).toBe(requestId);

    const entries = parseLines(lines);
    expect(entries.find((entry) => entry.event === 'http.request.received')?.requestId).toBe(requestId);
    expect(entries.find((entry) => entry.event === 'handler.test')?.requestId).toBe(requestId);
  });

  it('keeps module loggers created outside a request free of requestId', () => {
    const moduleLog = createLogger('outside-request');
    expect(moduleLog.bindings()).toMatchObject({ module: 'outside-request' });
    expect(moduleLog.bindings()).not.toHaveProperty('requestId');
  });
});
