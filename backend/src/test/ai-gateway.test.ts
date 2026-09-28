import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Checkbox 98 acceptance: AI provider gateway.
 *
 * Everything runs against an injected fetch stub - no test performs a real
 * outbound request, and the timeout test drives fake timers instead of waiting.
 *
 * Acceptance map:
 *   (a) 429 primary -> one jittered retry -> failover to the fallback (3 calls)
 *   (b) timeout -> typed AiTimeoutError, aborted exactly at the 30s budget
 *   (c) identical summarisation request -> exactly ONE upstream call
 *   (d) no env -> chat throws AiDisabledError, /status reports enabled:false
 *   plus: malformed JSON body -> typed AiParseError (no unhandled rejection),
 *   secret/SSRF guards on /status, cache size + TTL bounds.
 */

const authState = vi.hoisted(() => ({ user: null as { id: number; username: string } | null }));

vi.mock('../middleware/auth.middleware.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth.middleware.js')>();
  type MockCtx = { set: (key: 'user', value: unknown) => void };
  return {
    authMiddleware: async (c: MockCtx, next: () => Promise<void>) => {
      if (authState.user) {
        c.set('user', authState.user);
        return next();
      }
      return (actual.authMiddleware as unknown as (c: MockCtx, n: () => Promise<void>) => Promise<void>)(c, next);
    },
  };
});

import {
  AI_CACHE_MAX_ENTRIES,
  AI_CACHE_TTL_MS,
  AI_TIMEOUT_MS,
  AiDisabledError,
  AiError,
  AiHttpError,
  AiParseError,
  AiRequestError,
  AiTimeoutError,
  createAiGateway,
  type AiGateway,
} from '../services/ai/gateway.js';
import aiRoutes from '../routes/ai.js';

const PRIMARY_ENV = {
  AI_BASE_URL: 'https://primary.example/v1',
  AI_API_KEY: 'sk-test-primary-key',
  AI_MODEL: 'primary-model',
};
const FALLBACK_ENV = {
  AI_FALLBACK_BASE_URL: 'https://fallback.example/v1',
  AI_FALLBACK_API_KEY: 'sk-test-fallback-key',
  AI_FALLBACK_MODEL: 'fallback-model',
};

interface StubResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

function jsonResponse(payload: unknown, status = 200): StubResponse {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) };
}

function rawResponse(text: string, status = 200): StubResponse {
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

function completion(content: string) {
  return {
    model: 'stub-model',
    choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
  };
}

function asFetch(mock: unknown): typeof fetch {
  return mock as unknown as typeof fetch;
}

function makeGateway(
  fetchMock: unknown,
  env: Record<string, string> = { ...PRIMARY_ENV },
  extra: { random?: () => number; now?: () => number } = {},
): AiGateway {
  return createAiGateway({
    fetchImpl: asFetch(fetchMock),
    env: { ...env },
    random: extra.random ?? (() => 0),
    ...(extra.now ? { now: extra.now } : {}),
  });
}

async function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

beforeEach(() => {
  authState.user = { id: 1, username: 'alice' };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('AI gateway (checkbox 98)', () => {
  it('(a) retries a 429 once and then fails over to the fallback provider', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'rate limited' } }, 429))
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'rate limited' } }, 429))
      .mockResolvedValueOnce(jsonResponse(completion('fallback answer')));
    const gateway = makeGateway(fetchMock, { ...PRIMARY_ENV, ...FALLBACK_ENV });

    const result = await gateway.chat([{ role: 'user', content: 'hello' }]);

    expect(result.provider).toBe('fallback');
    expect(result.content).toBe('fallback answer');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls[0]).toContain('primary.example');
    expect(urls[1]).toContain('primary.example');
    expect(urls[2]).toContain('fallback.example');
    // The fallback request is a real chat-completions call with the fallback model.
    const fallbackBody = JSON.parse(String(fetchMock.mock.calls[2][1]?.body)) as { model: string };
    expect(fallbackBody.model).toBe('fallback-model');
  });

  it('(a2) fails over on 5xx and on timeout, but not on a non-retryable 401', async () => {
    const fiveHundredMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'boom' } }, 503))
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'boom' } }, 503))
      .mockResolvedValueOnce(jsonResponse(completion('ok from fallback')));
    const fiveHundred = makeGateway(fiveHundredMock, { ...PRIMARY_ENV, ...FALLBACK_ENV });
    const viaFallback = await fiveHundred.chat([{ role: 'user', content: 'x' }]);
    expect(viaFallback.provider).toBe('fallback');
    expect(fiveHundredMock).toHaveBeenCalledTimes(3);

    const unauthorizedMock = vi.fn().mockResolvedValue(jsonResponse({ error: { message: 'bad key' } }, 401));
    const unauthorized = makeGateway(unauthorizedMock, { ...PRIMARY_ENV, ...FALLBACK_ENV });
    const outcome = await settle(unauthorized.chat([{ role: 'user', content: 'x' }]));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBeInstanceOf(AiHttpError);
      expect((outcome.error as AiHttpError).status).toBe(401);
      expect((outcome.error as AiHttpError).retryable).toBe(false);
    }
    expect(unauthorizedMock).toHaveBeenCalledTimes(1);
  });

  it('(b) a timeout surfaces as typed AiTimeoutError, aborted exactly at the 30s budget (fake timers)', async () => {
    vi.useFakeTimers();
    const aborted: number[] = [];
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<never>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal;
          signal.addEventListener('abort', () => {
            aborted.push(1);
            reject(new Error('aborted'));
          });
        }),
    );
    const gateway = makeGateway(fetchMock); // primary only, no fallback

    const pending = gateway.chat([{ role: 'user', content: 'hang' }]);
    const outcomePromise = settle(pending);

    // Exactly one full budget in, the first attempt is aborted - never later.
    await vi.advanceTimersByTimeAsync(AI_TIMEOUT_MS);
    expect(aborted).toHaveLength(1);

    // Flush the (0ms jittered) retry sleep, then burn the retry's fresh budget.
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(AI_TIMEOUT_MS);
    const outcome = await outcomePromise;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBeInstanceOf(AiTimeoutError);
      expect((outcome.error as AiTimeoutError).code).toBe('AI_TIMEOUT');
      expect((outcome.error as AiTimeoutError).retryable).toBe(true);
    }
    expect(aborted).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('(c) serves an identical summarisation request from cache with exactly ONE upstream call', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(completion('the summary')));
    const gateway = makeGateway(fetchMock);
    const messages = [{ role: 'user', content: 'summarise this event' }];
    const options = { maxTokens: 128, jsonSchema: { name: 'summary', schema: { type: 'object' } } };

    const first = await gateway.chat(messages, options);
    const second = await gateway.chat(messages, options);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.content).toBe('the summary');

    // Different options hash to a different key -> one more upstream call.
    await gateway.chat(messages, { ...options, maxTokens: 129 });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Opting out of the cache bypasses both read and write.
    await gateway.chat(messages, { ...options, useCache: false });
    await gateway.chat(messages, { ...options, useCache: false });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('(d) with no env the gateway throws AiDisabledError and never calls fetch', async () => {
    const fetchMock = vi.fn();
    const gateway = makeGateway(fetchMock, {});

    const outcome = await settle(gateway.chat([{ role: 'user', content: 'hi' }]));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBeInstanceOf(AiDisabledError);
      expect((outcome.error as AiDisabledError).code).toBe('AI_DISABLED');
      expect((outcome.error as AiDisabledError).retryable).toBe(false);
      expect(outcome.error).toBeInstanceOf(AiError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    const status = gateway.status();
    expect(status.enabled).toBe(false);
    expect(status.provider).toBeNull();
  });

  it('QA: a malformed JSON body is a typed AiParseError, never a bare error or unhandled rejection', async () => {
    const truncatedMock = vi.fn().mockResolvedValue(rawResponse('{"choices": [', 200));
    const truncated = makeGateway(truncatedMock);
    const first = await settle(truncated.chat([{ role: 'user', content: 'x' }]));
    expect(first.ok).toBe(false);
    if (!first.ok) {
      expect(first.error).toBeInstanceOf(AiParseError);
      expect(first.error).toBeInstanceOf(AiError);
      expect((first.error as AiParseError).code).toBe('AI_PARSE');
    }
    // Deterministic malformed output is not retried.
    expect(truncatedMock).toHaveBeenCalledTimes(1);

    const htmlMock = vi.fn().mockResolvedValue(rawResponse('<html>gateway error</html>', 200));
    const html = makeGateway(htmlMock);
    const second = await settle(html.chat([{ role: 'user', content: 'x' }]));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toBeInstanceOf(AiParseError);

    const shapeMock = vi.fn().mockResolvedValue(jsonResponse({ choices: [] }, 200));
    const shape = makeGateway(shapeMock);
    const third = await settle(shape.chat([{ role: 'user', content: 'x' }]));
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.error).toBeInstanceOf(AiParseError);
  });

  it('rejects empty messages locally with a typed AiRequestError', async () => {
    const fetchMock = vi.fn();
    const gateway = makeGateway(fetchMock);
    const outcome = await settle(gateway.chat([], undefined));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBeInstanceOf(AiRequestError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('bounds the in-memory cache by entry count', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(completion('ok')));
    const gateway = makeGateway(fetchMock);

    for (let index = 0; index < AI_CACHE_MAX_ENTRIES + 20; index += 1) {
      await gateway.chat([{ role: 'user', content: `question ${index}` }]);
    }
    expect(gateway.status().cache.entries).toBeLessThanOrEqual(AI_CACHE_MAX_ENTRIES);
    expect(gateway.status().cache.maxEntries).toBe(AI_CACHE_MAX_ENTRIES);
  });

  it('expires cache entries after the TTL', async () => {
    let clock = 1_000;
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(completion('ok')));
    const gateway = makeGateway(fetchMock, { ...PRIMARY_ENV }, { now: () => clock });
    const messages = [{ role: 'user', content: 'same question' }];

    await gateway.chat(messages);
    await gateway.chat(messages);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    clock += AI_CACHE_TTL_MS + 1;
    await gateway.chat(messages);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never places the API key (or a full base URL) in provider error text', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      rawResponse(`auth failed for key sk-test-primary-key at https://primary.example/v1`, 500),
    );
    const gateway = makeGateway(fetchMock); // primary only: no fallback noise
    const outcome = await settle(gateway.chat([{ role: 'user', content: 'x' }]));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBeInstanceOf(AiHttpError);
      const message = (outcome.error as AiHttpError).message;
      expect(message).not.toContain('sk-test-primary-key');
      expect(message).toContain('[redacted]');
    }
  });
});

describe('GET /api/ai/status (checkbox 98)', () => {
  async function callStatus(query = ''): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await aiRoutes.request(`http://localhost/status${query}`);
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      /* no body */
    }
    return { status: res.status, json };
  }

  function stubAllAiEnv(values: Record<string, string> = {}): void {
    for (const name of [
      'AI_BASE_URL',
      'AI_API_KEY',
      'AI_MODEL',
      'AI_FALLBACK_BASE_URL',
      'AI_FALLBACK_API_KEY',
      'AI_FALLBACK_MODEL',
    ]) {
      vi.stubEnv(name, values[name] ?? '');
    }
  }

  it('(d) reports enabled:false with no env, still 200 - no hard failure', async () => {
    stubAllAiEnv();
    const { status, json } = await callStatus();
    expect(status).toBe(200);
    const data = json.data as { enabled: boolean; provider: string | null };
    expect(data.enabled).toBe(false);
    expect(data.provider).toBeNull();
  });

  it('is auth-guarded', async () => {
    stubAllAiEnv();
    authState.user = null;
    const { status } = await callStatus();
    expect(status).toBe(401);
  });

  it('reports host and model only - never the key, never the full URL', async () => {
    stubAllAiEnv({
      AI_BASE_URL: 'https://leaky.example/v1/private-path',
      AI_API_KEY: 'sk-live-status-secret',
      AI_MODEL: 'main-model',
      ...FALLBACK_ENV,
    });
    const { status, json } = await callStatus();
    expect(status).toBe(200);
    const data = json.data as {
      enabled: boolean;
      provider: string | null;
      primary: { configured: boolean; host: string | null; model: string | null };
    };
    expect(data.enabled).toBe(true);
    expect(data.provider).toBe('primary');
    expect(data.primary.host).toBe('leaky.example');
    expect(data.primary.model).toBe('main-model');

    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain('sk-live-status-secret');
    expect(serialized).not.toContain('private-path');
    expect(serialized).not.toContain('/v1');
  });

  it('SSRF guard: a baseUrl supplied in the request is ignored - the env URL wins', async () => {
    stubAllAiEnv({
      AI_BASE_URL: 'https://primary.example/v1',
      AI_API_KEY: 'sk-test-primary-key',
      AI_MODEL: 'primary-model',
    });
    const { status, json } = await callStatus('?baseUrl=https://evil.example/steal&base_url=https://evil.example');
    expect(status).toBe(200);
    const data = json.data as { primary: { host: string | null } };
    expect(data.primary.host).toBe('primary.example');
    expect(JSON.stringify(json)).not.toContain('evil.example');
  });
});
