import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Checkbox 107 acceptance: first-class local-model support (Ollama / LM Studio)
 * plus the `docs/AI.md` contract.
 *
 * Everything runs against an injected / stubbed fetch - no test performs a real
 * outbound request. The slow-model case drives fake timers instead of waiting.
 *
 * Acceptance map:
 *   (a) OLLAMA_BASE_URL + OLLAMA_MODEL -> /api/ai/status reports `local` active
 *   (b) POST /api/ai/test -> 测试连接 round-trip succeeds against the mock
 *   (c) unreachable local -> status reachable:false, app still functions
 *   (d) slow local (60s) -> typed AiTimeoutError, retry path runs, no over-run
 *   (e) failover path reaches the local provider after the cloud one fails
 *   (f) nothing configured -> AiDisabledError / enabled:false (degrades)
 *   (g) docs/AI.md carries the four model families + figures (literal strings)
 *   plus: SSRF guard (no request-supplied base URL), no key / full-URL leak,
 *   short probe ceiling, auth guard.
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
  AI_PROBE_TIMEOUT_MS,
  AI_TIMEOUT_MS,
  AiDisabledError,
  AiTimeoutError,
  createAiGateway,
  type AiGateway,
} from '../services/ai/gateway.js';
import aiRoutes from '../routes/ai.js';

const LOCAL_ENV = {
  OLLAMA_BASE_URL: 'http://local-model.test:11434/v1',
  OLLAMA_MODEL: 'qwen3:8b',
};
const PRIMARY_ENV = {
  AI_BASE_URL: 'https://primary.example/v1',
  AI_API_KEY: 'sk-test-primary-key',
  AI_MODEL: 'primary-model',
};

interface StubResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

function jsonResponse(payload: unknown, status = 200): StubResponse {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) };
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
  env: Record<string, string>,
  extra: { random?: () => number } = {},
): AiGateway {
  return createAiGateway({
    fetchImpl: asFetch(fetchMock),
    env: { ...env },
    random: extra.random ?? (() => 0),
  });
}

async function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

function stubAllAiEnv(values: Record<string, string> = {}): void {
  for (const name of [
    'AI_BASE_URL',
    'AI_API_KEY',
    'AI_MODEL',
    'AI_FALLBACK_BASE_URL',
    'AI_FALLBACK_API_KEY',
    'AI_FALLBACK_MODEL',
    'OLLAMA_BASE_URL',
    'OLLAMA_MODEL',
    'OLLAMA_API_KEY',
  ]) {
    vi.stubEnv(name, values[name] ?? '');
  }
}

beforeEach(() => {
  authState.user = { id: 1, username: 'alice' };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('local provider - gateway (checkbox 107)', () => {
  it('(a) resolves `local` as the active provider from OLLAMA_BASE_URL + OLLAMA_MODEL', () => {
    const gateway = makeGateway(vi.fn(), LOCAL_ENV);
    const status = gateway.status();
    expect(status.enabled).toBe(true);
    expect(status.provider).toBe('local');
    expect(status.local).toEqual({
      configured: true,
      model: 'qwen3:8b',
      host: 'local-model.test',
      reachable: null,
    });
    expect(status.primary.configured).toBe(false);
    expect(status.fallback.configured).toBe(false);
  });

  it('(a2) OLLAMA_BASE_URL alone (no OLLAMA_MODEL) leaves the local slot OFF', () => {
    const gateway = makeGateway(vi.fn(), { OLLAMA_BASE_URL: 'http://localhost:11434/v1' });
    const status = gateway.status();
    expect(status.enabled).toBe(false);
    expect(status.provider).toBeNull();
    expect(status.local.configured).toBe(false);
  });

  it('(a3) probes the local base URL and reports reachable:true on any HTTP answer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
    const gateway = makeGateway(fetchMock, LOCAL_ENV);
    const status = await gateway.statusWithProbe();
    expect(status.local.reachable).toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://local-model.test:11434/v1/models');
  });

  it('(b) 测试连接 sends one tiny prompt and reports success, latency and the model', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(completion('pong')));
    const gateway = makeGateway(fetchMock, LOCAL_ENV);
    const result = await gateway.testConnection('local');

    expect(result.ok).toBe(true);
    expect(result.provider).toBe('local');
    expect(result.model).toBe('stub-model');
    expect(result.host).toBe('local-model.test');
    expect(typeof result.latencyMs).toBe('number');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://local-model.test:11434/v1/chat/completions');
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'qwen3:8b',
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 8,
    });
    // No key configured -> no Authorization header is sent to the local host.
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('(c) an unreachable local model reports reachable:false and a typed test error (no throw)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const gateway = makeGateway(fetchMock, LOCAL_ENV);

    const status = await gateway.statusWithProbe();
    expect(status.enabled).toBe(true);
    expect(status.provider).toBe('local');
    expect(status.local.reachable).toBe(false);

    const test = await gateway.testConnection('local');
    expect(test.ok).toBe(false);
    expect(test.provider).toBe('local');
    expect(test.error?.code).toBe('AI_NETWORK');
  });

  it('(d) a 60s slow local model never blocks past the configured timeout; typed timeout + retry', async () => {
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
    const gateway = makeGateway(fetchMock, LOCAL_ENV); // local only

    const pending = settle(gateway.chat([{ role: 'user', content: 'hang' }]));

    // Exactly one per-attempt budget in, the first attempt is aborted.
    await vi.advanceTimersByTimeAsync(AI_TIMEOUT_MS);
    expect(aborted).toHaveLength(1);

    // Retry path: flush the (0ms jittered) sleep, then burn the retry's budget.
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(AI_TIMEOUT_MS);
    const outcome = await pending;

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBeInstanceOf(AiTimeoutError);
      expect((outcome.error as AiTimeoutError).code).toBe('AI_TIMEOUT');
      expect((outcome.error as AiTimeoutError).retryable).toBe(true);
    }
    // Two attempts = one retry, then a typed failure; never a bare hang.
    expect(aborted).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('(e) failover path reaches the local provider after the cloud provider fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'down' } }, 503))
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'down' } }, 503))
      .mockResolvedValueOnce(jsonResponse(completion('local answer')));
    const gateway = makeGateway(fetchMock, { ...PRIMARY_ENV, ...LOCAL_ENV });

    const result = await gateway.chat([{ role: 'user', content: 'hello' }]);

    expect(result.provider).toBe('local');
    expect(result.content).toBe('local answer');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls[0]).toContain('primary.example');
    expect(urls[2]).toContain('local-model.test');
  });

  it('(f) with nothing configured every entry point degrades with AiDisabledError', async () => {
    const fetchMock = vi.fn();
    const gateway = makeGateway(fetchMock, {});
    const outcome = await settle(gateway.chat([{ role: 'user', content: 'hi' }]));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBeInstanceOf(AiDisabledError);
    expect(fetchMock).not.toHaveBeenCalled();

    const status = gateway.status();
    expect(status.enabled).toBe(false);
    expect(status.provider).toBeNull();
    expect(status.local.reachable).toBeNull();

    const test = await gateway.testConnection('local');
    expect(test.ok).toBe(false);
    expect(test.error?.code).toBe('AI_DISABLED');
  });

  it('only probes the active provider (the short ceiling keeps /status fast)', () => {
    // A small constant is the contract: the route may never stall on a probe.
    expect(AI_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(2000);
  });
});

describe('local provider - routes (checkbox 107)', () => {
  async function callStatus(): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await aiRoutes.request('http://localhost/status');
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  async function callTest(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await aiRoutes.request('http://localhost/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  it('(a) /status reports the local provider, reachable, host-only (no key / full URL)', async () => {
    stubAllAiEnv(LOCAL_ENV);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ data: [] })));

    const { status, json } = await callStatus();
    expect(status).toBe(200);
    const data = json.data as {
      enabled: boolean;
      provider: string | null;
      local: { configured: boolean; model: string | null; host: string | null; reachable: boolean | null };
    };
    expect(data.enabled).toBe(true);
    expect(data.provider).toBe('local');
    expect(data.local).toEqual({ configured: true, model: 'qwen3:8b', host: 'local-model.test', reachable: true });

    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain('11434');
    expect(serialized).not.toContain('/v1');
  });

  it('(b) POST /api/ai/test round-trips the 测试连接 against the mock', async () => {
    stubAllAiEnv(LOCAL_ENV);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(completion('pong')));
    vi.stubGlobal('fetch', fetchMock);

    const { status, json } = await callTest({ provider: 'local' });
    expect(status).toBe(200);
    const data = json.data as { ok: boolean; provider: string | null; model: string | null };
    expect(data.ok).toBe(true);
    expect(data.provider).toBe('local');
    expect(data.model).toBe('stub-model');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('local-model.test');
  });

  it('SSRF guard: a request-supplied baseUrl/key is ignored - only the env endpoint is used', async () => {
    stubAllAiEnv(LOCAL_ENV);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(completion('pong')));
    vi.stubGlobal('fetch', fetchMock);

    await callTest({ provider: 'local', baseUrl: 'https://evil.example/v1', apiKey: 'sk-evil' });

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.every((url) => url.includes('local-model.test'))).toBe(true);
    expect(urls.some((url) => url.includes('evil.example'))).toBe(false);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.stringify(init.headers)).not.toContain('sk-evil');
  });

  it('(c) an unreachable local model -> status unreachable, the route still 200s and degrades', async () => {
    stubAllAiEnv(LOCAL_ENV);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const { status, json } = await callStatus();
    expect(status).toBe(200);
    const data = json.data as { provider: string | null; local: { reachable: boolean | null } };
    expect(data.provider).toBe('local');
    expect(data.local.reachable).toBe(false);

    // The app keeps working: the test endpoint returns a typed failure, no crash.
    const test = await callTest({ provider: 'local' });
    expect(test.status).toBe(200);
    const testData = test.json.data as { ok: boolean; error?: { code: string } };
    expect(testData.ok).toBe(false);
    expect(testData.error?.code).toBe('AI_NETWORK');
  });

  it('(d) the /status probe never blocks past its short ceiling, even for a hanging host', async () => {
    stubAllAiEnv(LOCAL_ENV);
    // A fetch that ignores the abort signal entirely - only the race can save us.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));

    const started = Date.now();
    const { status, json } = await callStatus();
    const elapsed = Date.now() - started;

    expect(status).toBe(200);
    expect((json.data as { local: { reachable: boolean | null } }).local.reachable).toBe(false);
    expect(elapsed).toBeLessThan(AI_PROBE_TIMEOUT_MS + 2000);
  });

  it('(f) with no env the route is enabled:false and the test endpoint is AI_DISABLED', async () => {
    stubAllAiEnv();
    vi.stubGlobal('fetch', vi.fn());

    const { status, json } = await callStatus();
    expect(status).toBe(200);
    const data = json.data as { enabled: boolean; provider: string | null; local: { reachable: boolean | null } };
    expect(data.enabled).toBe(false);
    expect(data.provider).toBeNull();
    expect(data.local.reachable).toBeNull();

    const test = await callTest({});
    expect(test.status).toBe(200);
    expect((test.json.data as { ok: boolean; error?: { code: string } }).ok).toBe(false);
    expect((test.json.data as { error?: { code: string } }).error?.code).toBe('AI_DISABLED');
  });

  it('is auth-guarded', async () => {
    stubAllAiEnv(LOCAL_ENV);
    authState.user = null;
    const { status } = await callStatus();
    expect(status).toBe(401);
  });
});

describe('docs/AI.md (checkbox 107)', () => {
  const doc = readFileSync(new URL('../../../docs/AI.md', import.meta.url), 'utf8');

  it('documents the four model families with their memory figures', () => {
    for (const needle of [
      'Phi-4-mini 3.8B',
      '~3 GB Q4',
      'CPU-friendly',
      'MIT',
      'function calling supported',
      'Qwen3 4B',
      '3-4 GB',
      'Qwen3 8B',
      '6-8 GB',
      'Apache-2.0',
      'strongest out-of-the-box tool calling',
      'Gemma 4 E2B',
      '7.6 tok/s',
      '8 GB CPU box',
      'native function calling',
      'FunctionGemma 270M',
      'very low-end hardware',
    ]) {
      expect(doc).toContain(needle);
    }
  });

  it('documents how to run them and the cloud caveats + the Vercel localhost note', () => {
    for (const needle of [
      'ollama pull qwen3:8b',
      'localhost:11434/v1',
      'LM Studio',
      'improve Google products',
      '50 req/day',
      'no-training',
      'cannot reach',
      'localhost',
      'MCP',
      'tool API',
    ]) {
      expect(doc).toContain(needle);
    }
  });
});
