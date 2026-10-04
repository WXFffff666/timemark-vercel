import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Checkbox 117 acceptance (part 1): model tiering + provider routing in the AI gateway.
 *
 * Every case runs against an injected fetch stub - no test performs a real outbound
 * request. The tier is asserted both structurally (`resolveTierProviderOrder`) and
 * behaviourally (which host the gateway actually contacted), including the two
 * hard routing rules:
 *
 *   - a local-only deployment NEVER contacts a cloud URL, whatever the tier config says;
 *   - a tier list that resolves to nothing usable falls back to the full configured
 *     chain (deterministic: the same env always yields the same order).
 */

import {
  DEFAULT_AI_MODEL_TIER,
  DEFAULT_PROVIDER_ORDER,
  AI_MODEL_TIERS,
  AiDisabledError,
  createAiGateway,
  isAiConfigured,
  isAiModelTier,
  listConfiguredProviders,
  resolveTierProviderOrder,
  type AiGateway,
} from '../services/ai/gateway.js';

const PRIMARY_ENV = {
  AI_BASE_URL: 'https://primary.example/v1',
  AI_API_KEY: ['sk-', 'test-primary-', 'key'].join(''),
  AI_MODEL: 'primary-model',
};
const FALLBACK_ENV = {
  AI_FALLBACK_BASE_URL: 'https://fallback.example/v1',
  AI_FALLBACK_API_KEY: ['sk-', 'test-fallback-', 'key'].join(''),
  AI_FALLBACK_MODEL: 'fallback-model',
};
const LOCAL_ENV = {
  OLLAMA_BASE_URL: 'http://127.0.0.1:11434/v1',
  OLLAMA_MODEL: 'llama3.1',
};

const ALL_CONFIGURED = { ...PRIMARY_ENV, ...FALLBACK_ENV, ...LOCAL_ENV };

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

function makeGateway(fetchMock: unknown, env: Record<string, string>): AiGateway {
  return createAiGateway({
    fetchImpl: asFetch(fetchMock),
    env: { ...env },
    random: () => 0,
  });
}

function calledUrls(fetchMock: { mock: { calls: unknown[][] } }): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('resolveTierProviderOrder', () => {
  it('resolves each tier to its configured provider order', () => {
    const env = {
      ...ALL_CONFIGURED,
      AI_TIER_LITE_PROVIDERS: 'local,primary',
      // Messy operator input: spaces + a duplicate - normalised to the listed order.
      AI_TIER_MEDIUM_PROVIDERS: 'fallback, primary ,local,fallback',
      AI_TIER_HIGH_PROVIDERS: 'fallback,primary',
    };
    expect(resolveTierProviderOrder('lite', env)).toEqual(['local', 'primary']);
    expect(resolveTierProviderOrder('medium', env)).toEqual(['fallback', 'primary', 'local']);
    expect(resolveTierProviderOrder('high', env)).toEqual(['fallback', 'primary']);
  });

  it('an unset tier config uses the natural configured order (back-compatible default)', () => {
    expect(resolveTierProviderOrder('lite', ALL_CONFIGURED)).toEqual(DEFAULT_PROVIDER_ORDER);
    expect(resolveTierProviderOrder('medium', ALL_CONFIGURED)).toEqual(['primary', 'fallback', 'local']);
    expect(resolveTierProviderOrder('high', { ...PRIMARY_ENV })).toEqual(['primary']);
    expect(resolveTierProviderOrder('high', { ...LOCAL_ENV })).toEqual(['local']);
    expect(resolveTierProviderOrder('high', {})).toEqual([]);
  });

  it('drops unknown names, duplicates and unconfigured providers; falls back deterministically', () => {
    const env = { ...LOCAL_ENV, AI_TIER_HIGH_PROVIDERS: 'primary,fallback' };
    // Named slots exist but none is configured -> the full configured chain, not an error.
    expect(resolveTierProviderOrder('high', env)).toEqual(['local']);

    const mixed = { ...ALL_CONFIGURED, AI_TIER_LITE_PROVIDERS: 'azure,nope,fallback' };
    expect(resolveTierProviderOrder('lite', mixed)).toEqual(['fallback']);

    // Deterministic: the same env yields the same order on every call.
    expect(resolveTierProviderOrder('lite', mixed)).toEqual(resolveTierProviderOrder('lite', mixed));
  });

  it('listConfiguredProviders / isAiConfigured report the raw slots (AI ships OFF)', () => {
    expect(listConfiguredProviders(ALL_CONFIGURED)).toEqual(['primary', 'fallback', 'local']);
    expect(listConfiguredProviders({ ...LOCAL_ENV })).toEqual(['local']);
    expect(listConfiguredProviders({})).toEqual([]);
    expect(isAiConfigured(ALL_CONFIGURED)).toBe(true);
    expect(isAiConfigured({})).toBe(false);
    // A model name is required for local: the dev-time localhost base URL alone stays OFF.
    expect(isAiConfigured({ OLLAMA_BASE_URL: 'http://127.0.0.1:11434/v1' })).toBe(false);
  });

  it('isAiModelTier accepts exactly the three tiers', () => {
    expect(AI_MODEL_TIERS).toEqual(['lite', 'medium', 'high']);
    expect(DEFAULT_AI_MODEL_TIER).toBe('medium');
    expect(AI_MODEL_TIERS.every(isAiModelTier)).toBe(true);
    expect(isAiModelTier('extreme')).toBe(false);
    expect(isAiModelTier(undefined)).toBe(false);
  });
});

describe('gateway tier routing (fetch-observed)', () => {
  it('a tier selects the intended provider, and medium stays the pre-tier default', async () => {
    const env = {
      ...ALL_CONFIGURED,
      AI_TIER_LITE_PROVIDERS: 'local,primary',
      AI_TIER_HIGH_PROVIDERS: 'fallback,primary',
    };

    const liteFetch = vi.fn().mockResolvedValue(jsonResponse(completion('lite answer')));
    const lite = await makeGateway(liteFetch, env).chat([{ role: 'user', content: 'hi' }], { tier: 'lite' });
    expect(lite.provider).toBe('local');
    expect(calledUrls(liteFetch)).toEqual(['http://127.0.0.1:11434/v1/chat/completions']);

    const highFetch = vi.fn().mockResolvedValue(jsonResponse(completion('high answer')));
    const high = await makeGateway(highFetch, env).chat([{ role: 'user', content: 'hi' }], { tier: 'high' });
    expect(high.provider).toBe('fallback');
    expect(calledUrls(highFetch)).toEqual(['https://fallback.example/v1/chat/completions']);

    // No tier => medium => the natural chain => primary first (unchanged behaviour).
    const defaultFetch = vi.fn().mockResolvedValue(jsonResponse(completion('default answer')));
    const fallbackTier = await makeGateway(defaultFetch, env).chat([{ role: 'user', content: 'hi' }]);
    expect(fallbackTier.provider).toBe('primary');
  });

  it('fails over inside the tier list only, in the configured order', async () => {
    const env = { ...ALL_CONFIGURED, AI_TIER_LITE_PROVIDERS: 'local,fallback' };
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('local down')) // attempt 1 (local)
      .mockRejectedValueOnce(new TypeError('local down')) // retry (local)
      .mockResolvedValueOnce(jsonResponse(completion('fell over'))); // (fallback)

    const result = await makeGateway(fetchMock, env).chat([{ role: 'user', content: 'hi' }], { tier: 'lite' });

    expect(result.provider).toBe('fallback');
    const urls = calledUrls(fetchMock);
    expect(urls).toEqual([
      'http://127.0.0.1:11434/v1/chat/completions',
      'http://127.0.0.1:11434/v1/chat/completions',
      'https://fallback.example/v1/chat/completions',
    ]);
    expect(urls.some((url) => url.includes('primary.example'))).toBe(false);
  });

  it('a strict local-only tier never escalates to a configured cloud slot', async () => {
    const env = { ...ALL_CONFIGURED, AI_TIER_LITE_PROVIDERS: 'local' };
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('local down'))
      .mockRejectedValueOnce(new TypeError('local down'));

    await expect(
      makeGateway(fetchMock, env).chat([{ role: 'user', content: 'hi' }], { tier: 'lite' }),
    ).rejects.toMatchObject({ code: 'AI_NETWORK' });

    // Exactly the two local attempts (initial + one retry): the cloud slots stay untouched.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(calledUrls(fetchMock).every((url) => url.includes('127.0.0.1:11434'))).toBe(true);
  });

  it('a local-only deployment never calls a cloud URL, whatever the tier config names', async () => {
    const env = {
      ...LOCAL_ENV,
      AI_TIER_LITE_PROVIDERS: 'primary,fallback',
      AI_TIER_MEDIUM_PROVIDERS: 'fallback',
      AI_TIER_HIGH_PROVIDERS: 'primary',
    };
    expect(resolveTierProviderOrder('lite', env)).toEqual(['local']);
    expect(resolveTierProviderOrder('medium', env)).toEqual(['local']);
    expect(resolveTierProviderOrder('high', env)).toEqual(['local']);

    for (const tier of AI_MODEL_TIERS) {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(completion(`${tier} local`)));
      const result = await makeGateway(fetchMock, env).chat([{ role: 'user', content: 'hi' }], { tier });
      expect(result.provider).toBe('local');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(calledUrls(fetchMock)).toEqual(['http://127.0.0.1:11434/v1/chat/completions']);
    }
  });

  it('with no provider configured every tier still throws AiDisabledError (AI OFF)', async () => {
    for (const tier of AI_MODEL_TIERS) {
      const fetchMock = vi.fn();
      await expect(
        makeGateway(fetchMock, { AI_TIER_LITE_PROVIDERS: 'local' }).chat([{ role: 'user', content: 'hi' }], { tier }),
      ).rejects.toBeInstanceOf(AiDisabledError);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });
});
