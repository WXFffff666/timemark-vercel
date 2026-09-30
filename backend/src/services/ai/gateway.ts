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
 *   local     OLLAMA_BASE_URL (default http://localhost:11434/v1) / OLLAMA_MODEL
 *             / OLLAMA_API_KEY (optional - Ollama and LM Studio need no key)
 *
 * The local provider is OFF unless `OLLAMA_MODEL` is set: the base URL has a
 * dev-time `localhost` default (the ONE allowed default) but a model name is
 * required, so a bare `.env` still leaves AI disabled (plan criterion 14).
 * Providers are tried in a fixed order primary -> fallback -> local; each one is
 * only consulted after the previous exhausts its retry, and only for retryable
 * failures (429 / 408 / 5xx / timeout / network).
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

/**
 * Short ceiling for the `/status` reachability probe. It must never make
 * `GET /api/ai/status` slow: any provider that has not answered within this
 * window is reported `reachable:false` (`unreachable`) and the route returns.
 */
export const AI_PROBE_TIMEOUT_MS = 1_500;

/** Dev-time default for the local provider; the only permitted default. */
const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434/v1';

const ERROR_DETAIL_MAX_CHARS = 300;

/** Named provider slots. `local` is the Ollama / LM Studio OpenAI-compatible endpoint. */
export type AiProviderName = 'primary' | 'fallback' | 'local';

/**
 * Model tiers (checkbox 117). A tier is a quality class for a call site - NOT a model
 * name: every tier resolves to an ORDERED list of the configured provider slots above
 * (see `resolveTierProviderOrder`). The plan's mapping of processes to tiers:
 *
 *   lite    triage, classification, habit naming
 *   medium  NL parsing, brief assembly, digest narrative
 *   high    weekly review, complex reasoning
 *
 * Because a tier only re-orders the EXISTING slots, all three user classes work with
 * no extra machinery: a local-only operator (only `OLLAMA_MODEL` set) runs every tier
 * on Ollama, and a cloud-only operator runs every tier on the free cloud slots.
 */
export const AI_MODEL_TIERS = ['lite', 'medium', 'high'] as const;
export type AiModelTier = (typeof AI_MODEL_TIERS)[number];

/**
 * The tier used when a call does not name one. `medium` resolves to the natural
 * `primary -> fallback -> local` order, so pre-tier callers keep their exact behaviour.
 */
export const DEFAULT_AI_MODEL_TIER: AiModelTier = 'medium';

/** Per-tier, comma-separated provider preference order (e.g. `local,primary,fallback`). */
export const TIER_PROVIDER_ENV: Record<AiModelTier, string> = {
  lite: 'AI_TIER_LITE_PROVIDERS',
  medium: 'AI_TIER_MEDIUM_PROVIDERS',
  high: 'AI_TIER_HIGH_PROVIDERS',
};

/** Natural provider order; also the fallback when a tier list resolves to nothing usable. */
export const DEFAULT_PROVIDER_ORDER: readonly AiProviderName[] = ['primary', 'fallback', 'local'];

export function isAiModelTier(value: unknown): value is AiModelTier {
  return typeof value === 'string' && (AI_MODEL_TIERS as readonly string[]).includes(value);
}

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
  /**
   * Model tier for this call (checkbox 117). Defaults to `medium`, which resolves to
   * the natural `primary -> fallback -> local` order and therefore preserves the
   * pre-tier behaviour. A tier only re-orders the configured slots; it never makes an
   * unconfigured provider reachable.
   */
  tier?: AiModelTier;
}

export interface AiChatResult {
  content: string;
  model: string;
  provider: AiProviderName;
  cached: boolean;
  toolCalls?: unknown[];
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export interface AiProviderStatus {
  configured: boolean;
  model: string | null;
  /** Hostname only - never the full base URL and never the key. */
  host: string | null;
  /**
   * Reachability of the ACTIVE provider: `true` when the host answered the
   * short probe, `false` when it timed out / refused the connection, `null`
   * when no probe ran (no provider, or the slot is not the active one).
   */
  reachable: boolean | null;
}

export interface AiStatus {
  enabled: boolean;
  /** Which provider resolves today: primary wins, then fallback, then local. */
  provider: AiProviderName | null;
  primary: AiProviderStatus;
  fallback: AiProviderStatus;
  local: AiProviderStatus;
  cache: { entries: number; maxEntries: number; ttlMs: number };
}

/** Result of the one-shot "测试连接" probe: never throws, always typed. */
export interface AiConnectionTest {
  ok: boolean;
  provider: AiProviderName | null;
  model: string | null;
  host: string | null;
  latencyMs: number;
  error?: { code: AiErrorCode; message: string };
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
  /** `status()` plus a short reachability probe of the resolved provider. */
  statusWithProbe(): Promise<AiStatus>;
  /** Send ONE tiny prompt to a provider (default: the resolved one) and report. */
  testConnection(provider?: AiProviderName): Promise<AiConnectionTest>;
  clearCache(): void;
}

interface AiProvider {
  label: AiProviderName;
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
const LOCAL_ENV = { baseUrl: 'OLLAMA_BASE_URL', apiKey: 'OLLAMA_API_KEY', model: 'OLLAMA_MODEL' } as const;

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
  label: AiProviderName,
): AiProvider | null {
  const baseUrl = (env[keys.baseUrl] ?? '').trim();
  const apiKey = (env[keys.apiKey] ?? '').trim();
  const model = (env[keys.model] ?? '').trim();
  if (!baseUrl || !apiKey || !model) return null;
  const host = safeHost(baseUrl);
  if (!host) return null;
  return { label, baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, model, host };
}

/**
 * The local provider (Ollama / LM Studio). The base URL defaults to the
 * dev-time `localhost` endpoint, but a model name is REQUIRED: without
 * `OLLAMA_MODEL` the slot stays OFF, so a bare `.env` never enables AI. No API
 * key is required (Ollama and LM Studio accept anonymous requests).
 */
function readLocalProvider(env: AiEnv): AiProvider | null {
  const baseUrl = (env[LOCAL_ENV.baseUrl] ?? '').trim() || DEFAULT_OLLAMA_BASE_URL;
  const model = (env[LOCAL_ENV.model] ?? '').trim();
  if (!model) return null;
  const host = safeHost(baseUrl);
  if (!host) return null;
  return {
    label: 'local',
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey: (env[LOCAL_ENV.apiKey] ?? '').trim(),
    model,
    host,
  };
}

/** Read the configured providers in the gateway's natural order (unconfigured slots are dropped). */
export function listConfiguredProviders(env: AiEnv): AiProviderName[] {
  const configured: AiProviderName[] = [];
  if (readProvider(env, PRIMARY_ENV, 'primary')) configured.push('primary');
  if (readProvider(env, FALLBACK_ENV, 'fallback')) configured.push('fallback');
  if (readLocalProvider(env)) configured.push('local');
  return configured;
}

/** True when at least one provider slot is configured (the AI feature ships OFF). */
export function isAiConfigured(env: AiEnv): boolean {
  return listConfiguredProviders(env).length > 0;
}

/** Parse a tier's comma-separated provider names; unknown names and duplicates are dropped. */
function parseProviderList(raw: string): AiProviderName[] {
  const names: AiProviderName[] = [];
  for (const part of raw.split(',')) {
    const name = part.trim().toLowerCase();
    if (!(DEFAULT_PROVIDER_ORDER as readonly string[]).includes(name)) continue;
    if (!names.includes(name as AiProviderName)) names.push(name as AiProviderName);
  }
  return names;
}

/**
 * The provider order a tier actually uses, resolved from config. Deterministic rules:
 *
 *  1. `AI_TIER_<TIER>_PROVIDERS` names the preference order; only CONFIGURED slots are
 *     kept (naming an unconfigured provider can never produce a call to it - e.g. a
 *     local-only deployment whose tier list mentions the cloud slots still runs locally).
 *  2. A non-empty kept list is used strictly: the gateway fails over inside it and never
 *     escalates to a slot the operator left out.
 *  3. Otherwise (unset, empty, or every named slot unconfigured) the full configured
 *     chain in the natural order is used, so a stale tier list can never strand a job.
 */
export function resolveTierProviderOrder(tier: AiModelTier, env: AiEnv): AiProviderName[] {
  const configured = listConfiguredProviders(env);
  const raw = (env[TIER_PROVIDER_ENV[tier]] ?? '').trim();
  if (raw) {
    const configuredSet = new Set(configured);
    const listed = parseProviderList(raw).filter((name) => configuredSet.has(name));
    if (listed.length > 0) return listed;
  }
  return configured;
}

/** Resolve one named slot; `null` when that provider is not configured. */
function providerForName(env: AiEnv, name: AiProviderName): AiProvider | null {
  if (name === 'primary') return readProvider(env, PRIMARY_ENV, 'primary');
  if (name === 'fallback') return readProvider(env, FALLBACK_ENV, 'fallback');
  return readLocalProvider(env);
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
            // Local providers (Ollama / LM Studio) need no key; only send the
            // header when a key is actually configured.
            ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
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
  // Resolve the injected fetch, else defer to the CURRENT `globalThis.fetch`
  // at call time (tests stub it per-case; production uses the platform fetch).
  const fetchImpl: AiFetch = deps.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
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
    // The tier chooses the ordered provider list; the default (`medium`) resolves to
    // the natural primary -> fallback -> local order.
    const chain = resolveTierProviderOrder(options.tier ?? DEFAULT_AI_MODEL_TIER, env)
      .map((name) => providerForName(env, name))
      .filter((entry): entry is AiProvider => entry !== null);
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

  function buildStatus(reachability: {
    primary: boolean | null;
    fallback: boolean | null;
    local: boolean | null;
  }): AiStatus {
    const primary = readProvider(env, PRIMARY_ENV, 'primary');
    const fallback = readProvider(env, FALLBACK_ENV, 'fallback');
    const local = readLocalProvider(env);
    const resolved: AiProviderName | null = primary?.label ?? fallback?.label ?? local?.label ?? null;
    return {
      enabled: resolved !== null,
      provider: resolved,
      primary: describeProvider(env[PRIMARY_ENV.model], primary, reachability.primary),
      fallback: describeProvider(env[FALLBACK_ENV.model], fallback, reachability.fallback),
      local: describeProvider(env[LOCAL_ENV.model], local, reachability.local),
      cache: { entries: cache.size, maxEntries: AI_CACHE_MAX_ENTRIES, ttlMs: AI_CACHE_TTL_MS },
    };
  }

  function status(): AiStatus {
    return buildStatus({ primary: null, fallback: null, local: null });
  }

  /**
   * `status()` plus a SHORT reachability probe of the resolved provider. Only
   * the active provider is probed (never all three) so the route stays fast;
   * `reachable` is `null` on the other slots. Never throws.
   */
  async function statusWithProbe(): Promise<AiStatus> {
    const primary = readProvider(env, PRIMARY_ENV, 'primary');
    const fallback = readProvider(env, FALLBACK_ENV, 'fallback');
    const local = readLocalProvider(env);
    const active = primary ?? fallback ?? local;
    if (!active) return status();
    const reachable = await probeProvider(active, fetchImpl);
    return buildStatus({
      primary: active.label === 'primary' ? reachable : null,
      fallback: active.label === 'fallback' ? reachable : null,
      local: active.label === 'local' ? reachable : null,
    });
  }

  /**
   * "测试连接": send ONE tiny prompt to a specific provider (default: whichever
   * is active) and report success + latency, or the typed error. Never throws.
   */
  async function testConnection(selector?: AiProviderName): Promise<AiConnectionTest> {
    const primary = readProvider(env, PRIMARY_ENV, 'primary');
    const fallback = readProvider(env, FALLBACK_ENV, 'fallback');
    const local = readLocalProvider(env);
    const byName: Record<AiProviderName, AiProvider | null> = { primary, fallback, local };
    const target = selector ? byName[selector] : primary ?? fallback ?? local;
    if (!target) {
      return {
        ok: false,
        provider: selector ?? null,
        model: null,
        host: null,
        latencyMs: 0,
        error: { code: 'AI_DISABLED', message: new AiDisabledError().message },
      };
    }
    const started = now();
    try {
      const result = await requestOnce(
        target,
        fetchImpl,
        buildRequestBody(target, TEST_PROMPT, { maxTokens: 8, useCache: false }),
        AI_TIMEOUT_MS,
      );
      return {
        ok: true,
        provider: target.label,
        model: result.model,
        host: target.host,
        latencyMs: Math.max(0, now() - started),
      };
    } catch (error) {
      const aiError = error instanceof AiError ? error : new AiNetworkError(target.host, error);
      return {
        ok: false,
        provider: target.label,
        model: target.model,
        host: target.host,
        latencyMs: Math.max(0, now() - started),
        error: { code: aiError.code, message: aiError.message },
      };
    }
  }

  return { chat: runChat, status, statusWithProbe, testConnection, clearCache: () => cache.clear() };
}

/** One tiny prompt for the "测试连接" button - deliberately cheap (8 tokens). */
const TEST_PROMPT: AiMessage[] = [{ role: 'user', content: 'ping' }];

/**
 * Short reachability probe: `GET {baseUrl}/models`. Any HTTP answer means the
 * host is reachable; a network error or the short timeout means it is not. It
 * NEVER throws and NEVER waits longer than `AI_PROBE_TIMEOUT_MS`, so it cannot
 * make `/api/ai/status` slow.
 */
async function probeProvider(provider: AiProvider, fetchImpl: AiFetch): Promise<boolean> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Settle the race first so the ceiling holds even if the fetch impl
      // ignores the abort signal, then stop the network work.
      reject(new Error('probe timed out'));
      controller.abort();
    }, AI_PROBE_TIMEOUT_MS);
  });
  try {
    await Promise.race([
      fetchImpl(`${provider.baseUrl}/models`, {
        method: 'GET',
        headers: provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {},
        signal: controller.signal,
      }),
      timeout,
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function describeProvider(
  modelRaw: string | undefined,
  resolved: AiProvider | null,
  reachable: boolean | null,
): AiProviderStatus {
  // Deliberately omits the base URL (and therefore any secret it could embed):
  // only the hostname and the model name are safe to report.
  const model =
    resolved?.model ?? (typeof modelRaw === 'string' && modelRaw.trim() ? modelRaw.trim() : null);
  return { configured: resolved !== null, model, host: resolved?.host ?? null, reachable };
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

/** `GET /api/ai/status` payload with the short reachability probe applied. */
export function getAiStatusWithProbe(): Promise<AiStatus> {
  return gateway().statusWithProbe();
}

/** `POST /api/ai/test` - one tiny prompt against a named provider. */
export function testAiConnection(provider?: AiProviderName): Promise<AiConnectionTest> {
  return gateway().testConnection(provider);
}
