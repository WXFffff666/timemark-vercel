import { createHash } from 'node:crypto';
import { createLogger } from '../../utils/logger.js';
import { isRetryableHttpStatus } from '../../utils/retry-classifier.js';

const log = createLogger('ai-gateway');

/**
 * AI provider gateway (checkbox 98).
 *
 * Talks the OpenAI-compatible wire format (`POST {baseUrl}/chat/completions`)
 * against a provider resolved exclusively from environment variables:
 *
 *   primary   AI_BASE_URL / AI_API_KEY / AI_MODEL
 *   fallback  AI_FALLBACK_BASE_URL / AI_FALLBACK_API_KEY / AI_FALLBACK_MODEL
 *
 * The fallback is only consulted after the primary exhausts its retry, and only
 * for retryable failures (429 / 408 / 5xx / timeout / network).
 *
 * Provider chain (all free tiers, all OpenAI-compatible):
 *   - Groq        fast inference, contractually does NOT train on inputs.
 *   - Google Gemini free tier - IMPORTANT: free-tier inputs ARE used to improve
 *                 Google products. Document this before enabling it for users.
 *   - OpenRouter  free tier is rate limited to 50 requests/day.
 *   - Cerebras    free tier with generous daily token limits.
 *   - Mistral     free tier ("La Plateforme") with per-minute limits.
 *   - Cloudflare Workers AI - free daily neuron allocation.
 *
 * Security notes:
 *   - SSRF guard: the base URL comes from the environment ONLY. `chat()` takes
 *     no URL parameter, the route layer forwards no request input into provider
 *     resolution, and `status()` exposes only the hostname (never a full URL
 *     that could embed a key). Do not add a request-supplied URL here.
 *   - Keys are never logged (logger-level redaction also covers `apiKey`) and
 *     are stripped from provider error text before it reaches an `AiError`.
 *   - With no provider configured every entry point throws `AiDisabledError`,
 *     which is a normal, expected path (plan criterion 14: AI ships OFF).
 */

/** Per-attempt wall-clock budget shared by the primary and the fallback. */
export const AI_TIMEOUT_MS = 30_000;

/** Full-jitter upper bound for the single retry delay (0..AI_RETRY_JITTER_MS). */
export const AI_RETRY_JITTER_MS = 500;

/** Hard cap on cached responses so a warm serverless instance cannot grow unbounded. */
export const AI_CACHE_MAX_ENTRIES = 100;

/** Cached AI responses expire after 10 minutes even while under the size cap. */
export const AI_CACHE_TTL_MS = 10 * 60 * 1000;

const ERROR_DETAIL_MAX_CHARS = 300;

/** Typed AI errors: no caller of this module should ever receive a bare `Error`. */
export type AiErrorCode =
  | 'AI_DISABLED'
  | 'AI_INVALID_REQUEST'
  | 'AI_TIMEOUT'
  | 'AI_NETWORK'
  | 'AI_HTTP'
  | 'AI_PARSE';

export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly retryable: boolean;

  constructor(message: string, code: AiErrorCode, retryable: boolean) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * Normal, expected path when `AI_*` is unset. Feature callers (tasks 99/107/108)
 * must catch this and degrade gracefully - a missing provider may never
 * hard-fail a request, a boot, or an unrelated feature.
 */
export class AiDisabledError extends AiError {
  constructor() {
    super(
      'AI is not configured: set AI_BASE_URL/AI_API_KEY/AI_MODEL (and optionally the AI_FALLBACK_* trio) to enable it',
      'AI_DISABLED',
      false,
    );
    this.name = 'AiDisabledError';
  }
}

/** Caller-side validation failure (e.g. empty `messages`), never sent upstream. */
export class AiRequestError extends AiError {
  constructor(detail: string) {
    super(`AI request rejected locally: ${detail}`, 'AI_INVALID_REQUEST', false);
    this.name = 'AiRequestError';
  }
}

export class AiTimeoutError extends AiError {
  constructor(timeoutMs: number = AI_TIMEOUT_MS) {
    super(`AI request timed out after ${timeoutMs} ms`, 'AI_TIMEOUT', true);
    this.name = 'AiTimeoutError';
  }
}

export class AiNetworkError extends AiError {
  constructor(host: string, cause: unknown) {
    super(`AI network error talking to ${host}: ${describeCause(cause)}`, 'AI_NETWORK', true);
    this.name = 'AiNetworkError';
  }
}

export class AiHttpError extends AiError {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(
      `AI provider HTTP ${status}: ${detail || 'request failed'}`,
      'AI_HTTP',
      isRetryableHttpStatus(status),
    );
    this.name = 'AiHttpError';
    this.status = status;
  }
}

/** Invalid JSON (or an unexpected OpenAI-compatible shape) from the provider. */
export class AiParseError extends AiError {
  constructor(host: string, detail?: string) {
    super(
      `AI provider returned a malformed response from ${host}${detail ? `: ${detail}` : ''}`,
      'AI_PARSE',
      false,
    );
    this.name = 'AiParseError';
  }
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  return 'unknown error';
}

/** Strip the API key from provider text before it can reach an error object. */
function sanitizeProviderText(text: string, apiKey: string): string {
  let out = text;
  if (apiKey) out = out.split(apiKey).join('[redacted]');
  return out.replace(/\s+/g, ' ').trim().slice(0, ERROR_DETAIL_MAX_CHARS);
}

export interface AiMessage {
  role: string;
  content: string;
  [key: string]: unknown;
}

export interface AiChatOptions {
  /** OpenAI tool definitions, passed through verbatim. */
  tools?: unknown[];
  /** OpenAI `response_format.json_schema` payload, passed through verbatim. */
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
  /**
   * Set `false` for non-idempotent calls. Defaults to `true`: summarisation and
   * other deterministic prompts are served from the in-memory cache.
   */
  useCache?: boolean;
}

export interface AiChatResult {
  content: string;
  model: string;
  provider: 'primary' | 'fallback';
  cached: boolean;
  toolCalls?: unknown[];
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export interface AiProviderStatus {
  configured: boolean;
  model: string | null;
  /** Hostname only - never the full base URL and never the key. */
  host: string | null;
}

export interface AiStatus {
  enabled: boolean;
  /** Which provider resolves today: primary wins when it is configured. */
  provider: 'primary' | 'fallback' | null;
  primary: AiProviderStatus;
  fallback: AiProviderStatus;
  cache: { entries: number; maxEntries: number; ttlMs: number };
}

export type AiEnv = Record<string, string | undefined>;

export type AiFetch = typeof fetch;

export interface AiGatewayDeps {
  /** Injected for tests so no test ever performs a real outbound request. */
  fetchImpl?: AiFetch;
  env?: AiEnv;
  /** Jitter source, injectable for deterministic tests. */
  random?: () => number;
  /** Clock, injectable for deterministic cache-TTL tests. */
  now?: () => number;
}

export interface AiGateway {
  chat(messages: AiMessage[], options?: AiChatOptions): Promise<AiChatResult>;
  status(): AiStatus;
  clearCache(): void;
}

interface AiProvider {
  label: 'primary' | 'fallback';
  baseUrl: string;
  apiKey: string;
  model: string;
  host: string;
}

const PRIMARY_ENV = { baseUrl: 'AI_BASE_URL', apiKey: 'AI_API_KEY', model: 'AI_MODEL' } as const;
const FALLBACK_ENV = {
  baseUrl: 'AI_FALLBACK_BASE_URL',
  apiKey: 'AI_FALLBACK_API_KEY',
  model: 'AI_FALLBACK_MODEL',
} as const;

/** Validate the operator-supplied base URL; malformed values disable the provider. */
function safeHost(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.hostname;
  } catch {
    return null;
  }
}

function readProvider(
  env: AiEnv,
  keys: { baseUrl: string; apiKey: string; model: string },
  label: 'primary' | 'fallback',
): AiProvider | null {
  const baseUrl = (env[keys.baseUrl] ?? '').trim();
  const apiKey = (env[keys.apiKey] ?? '').trim();
  const model = (env[keys.model] ?? '').trim();
  if (!baseUrl || !apiKey || !model) return null;
  const host = safeHost(baseUrl);
  if (!host) return null;
  return { label, baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, model, host };
}

function jitterDelayMs(random: () => number): number {
  const roll = random();
  const clamped = Number.isFinite(roll) ? Math.min(Math.max(roll, 0), 1) : 0;
  return Math.floor(clamped * AI_RETRY_JITTER_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildRequestBody(
  provider: AiProvider,
  messages: AiMessage[],
  options: AiChatOptions,
): Record<string, unknown> {
  return {
    model: provider.model,
    messages,
    ...(options.tools && options.tools.length > 0 ? { tools: options.tools } : {}),
    ...(options.jsonSchema
      ? { response_format: { type: 'json_schema', json_schema: options.jsonSchema } }
      : {}),
    ...(typeof options.maxTokens === 'number' && Number.isFinite(options.maxTokens)
      ? { max_tokens: options.maxTokens }
      : {}),
  };
}

/** Cache identity = hash of the full request (messages + options + resolved endpoint). */
function requestCacheKey(
  provider: AiProvider,
  messages: AiMessage[],
  options: AiChatOptions,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        host: provider.host,
        model: provider.model,
        messages,
        tools: options.tools ?? null,
        jsonSchema: options.jsonSchema ?? null,
        maxTokens: options.maxTokens ?? null,
      }),
    )
    .digest('hex');
}

async function requestOnce(
  provider: AiProvider,
  fetchImpl: AiFetch,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<AiChatResult> {
  const url = `${provider.baseUrl}/chat/completions`;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Settle the race with the typed error first, then stop the network work.
      reject(new AiTimeoutError(timeoutMs));
      controller.abort();
    }, timeoutMs);
  });

  try {
    const response = await Promise.race([
      (async () => {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${provider.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const text = await res.text();
        return { res, text };
      })(),
      timeout,
    ]);

    if (!response.res.ok) {
      throw new AiHttpError(response.res.status, sanitizeProviderText(response.text, provider.apiKey));
    }

    let payload: unknown;
    try {
      payload = JSON.parse(response.text);
    } catch {
      throw new AiParseError(provider.host, 'body is not valid JSON');
    }
    if (payload === null || typeof payload !== 'object') {
      throw new AiParseError(provider.host, 'expected a JSON object body');
    }

    const record = payload as Record<string, unknown>;
    if (record.error !== undefined && record.error !== null) {
      const providerMessage = (record.error as { message?: unknown }).message;
      const status = response.res.status >= 400 ? response.res.status : 502;
      throw new AiHttpError(status, sanitizeProviderText(String(providerMessage ?? 'provider error'), provider.apiKey));
    }

    const choices = Array.isArray(record.choices) ? record.choices : [];
    const choice = choices[0] as Record<string, unknown> | undefined;
    const message =
      choice && choice.message !== null && typeof choice.message === 'object'
        ? (choice.message as Record<string, unknown>)
        : undefined;
    if (!message) {
      throw new AiParseError(provider.host, 'missing choices[0].message');
    }

    const result: AiChatResult = {
      content: typeof message.content === 'string' ? message.content : '',
      model: typeof record.model === 'string' && record.model ? record.model : provider.model,
      provider: provider.label,
      cached: false,
    };
    if (Array.isArray(message.tool_calls)) {
      result.toolCalls = message.tool_calls;
    }
    const usageRecord =
      record.usage !== null && typeof record.usage === 'object'
        ? (record.usage as Record<string, unknown>)
        : undefined;
    if (usageRecord) {
      result.usage = {
        promptTokens: Number(usageRecord.prompt_tokens ?? 0),
        completionTokens: Number(usageRecord.completion_tokens ?? 0),
        totalTokens: Number(usageRecord.total_tokens ?? 0),
      };
    }
    return result;
  } catch (error) {
    if (error instanceof AiError) throw error;
    // The timeout path already rejects with AiTimeoutError; a signal aborted
    // without a typed error is still a timeout by construction.
    if (controller.signal.aborted) throw new AiTimeoutError(timeoutMs);
    throw new AiNetworkError(provider.host, error);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** One attempt + ONE retry with jitter; anything still failing is rethrown typed. */
async function callProviderWithRetry(
  provider: AiProvider,
  fetchImpl: AiFetch,
  body: Record<string, unknown>,
  random: () => number,
  timeoutMs: number,
): Promise<AiChatResult> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await requestOnce(provider, fetchImpl, body, timeoutMs);
    } catch (error) {
      const aiError = error instanceof AiError ? error : new AiNetworkError(provider.host, error);
      if (!aiError.retryable || attempt >= 1) throw aiError;
      await sleep(jitterDelayMs(random));
    }
  }
}

/**
 * Create an isolated gateway instance. Tests always use this factory with an
 * injected `fetchImpl`; production code uses the `chat()` / `getAiStatus()`
 * singleton wrappers below.
 */
export function createAiGateway(deps: AiGatewayDeps = {}): AiGateway {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const env = deps.env ?? process.env;
  const random = deps.random ?? Math.random;
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { expiresAt: number; result: AiChatResult }>();

  function cacheGet(key: string): AiChatResult | null {
    const entry = cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      cache.delete(key);
      return null;
    }
    return entry.result;
  }

  function cacheSet(key: string, result: AiChatResult): void {
    // Bound the cache by entry count (oldest insertion evicted first); TTL is
    // enforced on read. Together they keep warm instances from growing forever.
    if (cache.size >= AI_CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { expiresAt: now() + AI_CACHE_TTL_MS, result });
  }

  async function runChat(messages: AiMessage[], rawOptions?: AiChatOptions): Promise<AiChatResult> {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new AiRequestError('messages must be a non-empty array');
    }
    const options = rawOptions ?? {};
    const primary = readProvider(env, PRIMARY_ENV, 'primary');
    const fallback = readProvider(env, FALLBACK_ENV, 'fallback');
    const chain = primary ? (fallback ? [primary, fallback] : [primary]) : fallback ? [fallback] : [];
    if (chain.length === 0) {
      throw new AiDisabledError();
    }

    let lastError: AiError | null = null;
    for (let index = 0; index < chain.length; index += 1) {
      const provider = chain[index];
      const useCache = options.useCache !== false;
      const cacheKey = useCache ? requestCacheKey(provider, messages, options) : null;
      if (cacheKey) {
        const hit = cacheGet(cacheKey);
        if (hit) return { ...hit, cached: true };
      }

      try {
        const result = await callProviderWithRetry(
          provider,
          fetchImpl,
          buildRequestBody(provider, messages, options),
          random,
          AI_TIMEOUT_MS,
        );
        if (cacheKey) cacheSet(cacheKey, result);
        return result;
      } catch (error) {
        lastError = error instanceof AiError ? error : new AiNetworkError(provider.host, error);
        const next = chain[index + 1];
        if (!next || !lastError.retryable) throw lastError;
        log.warn(
          { fromHost: provider.host, toHost: next.host, code: lastError.code },
          'AI provider failed; falling over to the fallback provider',
        );
      }
    }
    throw lastError ?? new AiDisabledError();
  }

  function status(): AiStatus {
    const primary = readProvider(env, PRIMARY_ENV, 'primary');
    const fallback = readProvider(env, FALLBACK_ENV, 'fallback');
    const resolved: 'primary' | 'fallback' | null = primary ? 'primary' : fallback ? 'fallback' : null;
    return {
      enabled: resolved !== null,
      provider: resolved,
      primary: describeProvider(env[PRIMARY_ENV.baseUrl], env[PRIMARY_ENV.model], primary),
      fallback: describeProvider(env[FALLBACK_ENV.baseUrl], env[FALLBACK_ENV.model], fallback),
      cache: { entries: cache.size, maxEntries: AI_CACHE_MAX_ENTRIES, ttlMs: AI_CACHE_TTL_MS },
    };
  }

  return { chat: runChat, status, clearCache: () => cache.clear() };
}

function describeProvider(
  _baseUrl: string | undefined,
  modelRaw: string | undefined,
  resolved: AiProvider | null,
): AiProviderStatus {
  // Deliberately omits the base URL (and therefore any secret it could embed):
  // only the hostname and the model name are safe to report.
  const model =
    resolved?.model ?? (typeof modelRaw === 'string' && modelRaw.trim() ? modelRaw.trim() : null);
  return { configured: resolved !== null, model, host: resolved?.host ?? null };
}

let defaultGateway: AiGateway | null = null;

function gateway(): AiGateway {
  if (!defaultGateway) defaultGateway = createAiGateway();
  return defaultGateway;
}

/**
 * Public entry point for every AI feature (tasks 99/107/108).
 * Throws `AiDisabledError` when no provider is configured.
 */
export function chat(messages: AiMessage[], options?: AiChatOptions): Promise<AiChatResult> {
  return gateway().chat(messages, options);
}

/** Safe payload for `GET /api/ai/status`: hosts and model names only, never keys. */
export function getAiStatus(): AiStatus {
  return gateway().status();
}
