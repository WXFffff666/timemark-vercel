import type { ApiResponse } from '@timemark/shared';

const API_BASE = import.meta.env.DEV ? 'http://localhost:3000/api' : '/api';
const SESSION_ID_KEY = 'timemark_session_id';

export const usesCookieAuth = () => !!localStorage.getItem(SESSION_ID_KEY);

/** 清除可能干扰 HttpOnly Cookie 认证的过期 Bearer */
export function clearStaleBearerTokens() {
  localStorage.removeItem('accessToken');
  localStorage.removeItem('refreshToken');
  sessionStorage.removeItem('accessToken');
  sessionStorage.removeItem('refreshToken');
}

const getTokens = () => {
  if (usesCookieAuth()) {
    return {
      accessToken: null as string | null,
      refreshToken: null as string | null,
      sessionId: localStorage.getItem(SESSION_ID_KEY),
    };
  }
  return {
    accessToken: localStorage.getItem('accessToken') || sessionStorage.getItem('accessToken'),
    refreshToken: localStorage.getItem('refreshToken') || sessionStorage.getItem('refreshToken'),
    sessionId: null as string | null,
  };
};

const setAccessToken = (token: string) => {
  if (usesCookieAuth()) return;
  sessionStorage.setItem('accessToken', token);
};

/**
 * Why a refresh failed, kept distinguishable on purpose.
 *
 * `ok`         the session is alive
 * `expired`    the server said this credential is finished (expired / revoked / invalid).
 *              This is the ONLY outcome that may drop the local session.
 * `transport`  we never reached the server, or it answered 5xx / 429. The credential's
 *              validity is unknown, so it is unknown — not invalid. Retrying with backoff
 *              is correct; logging the user out is not.
 *
 * Collapsing these into one boolean is what made users get logged out by a tunnel, a
 * laptop lid, or a Vercel cold start.
 */
export type RefreshOutcome = 'ok' | 'expired' | 'transport';

export class ApiTransportError extends Error {
  /** Attempts left before we give up and surface the failure to the caller. */
  readonly retryable = true;
  constructor(message: string, readonly attempts: number) {
    super(message);
    this.name = 'ApiTransportError';
  }
}

/** Codes emitted by POST /api/auth/refresh that mean "this session is over". */
const TERMINAL_REFRESH_CODES = new Set(['refresh_missing', 'refresh_invalid', 'session_revoked', 'user_missing']);

/** Full jitter: sleep a random duration in [0, min(cap, base * 2^attempt)]. */
const RETRY_BASE_MS = 300;
const RETRY_CAP_MS = 3000;
const MAX_TRANSPORT_ATTEMPTS = 2;

function fullJitterDelay(attempt: number): number {
  const ceiling = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt);
  return Math.random() * ceiling;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function refreshSession(refreshToken?: string | null): Promise<RefreshOutcome> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(refreshToken ? { refreshToken } : {}),
    });
  } catch {
    // fetch only rejects for transport-level problems: offline, DNS, TLS, CORS, aborted.
    // The server never spoke, so it never said anything about this session.
    return 'transport';
  }

  if (response.status >= 500 || response.status === 429) {
    // A platform or rate-limit failure is not a verdict on the credential either.
    return 'transport';
  }

  if (!response.ok) {
    // Only a known code is a verdict. An unrecognized 4xx (proxy, WAF, gateway, an older
    // deploy) is unknown — clearing the session on a guess is how people lose a day of work.
    const data = (await response.json().catch(() => null)) as { code?: string } | null;
    return data?.code && TERMINAL_REFRESH_CODES.has(data.code) ? 'expired' : 'transport';
  }

  const data = (await response.json().catch(() => null)) as ApiResponse<{ accessToken?: string }> | null;
  if (!data?.success) return 'transport';
  if (data.data?.accessToken && !usesCookieAuth()) {
    setAccessToken(data.data.accessToken);
  }
  return 'ok';
}

// Single-flight handle: one in-flight refresh shared by every concurrent 401.
let refreshPromise: Promise<RefreshOutcome> | null = null;

async function request<T>(url: string, options?: RequestInit, retryCount = 0): Promise<T> {
  const { accessToken, refreshToken } = getTokens();

  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    ...(accessToken && { Authorization: `Bearer ${accessToken}` }),
    ...options?.headers,
  };

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${url}`, { ...options, headers, credentials: 'include' });
  } catch (error) {
    // A dead network says nothing about the session. Surface it as retryable and keep
    // every credential intact — the old code treated this identically to an invalid token.
    if (error instanceof Error && error.name === 'AbortError') throw error;
    if (retryCount < MAX_TRANSPORT_ATTEMPTS) {
      await sleep(fullJitterDelay(retryCount));
      return request<T>(url, options, retryCount + 1);
    }
    throw new ApiTransportError('网络连接失败，请检查网络后重试', MAX_TRANSPORT_ATTEMPTS);
  }

  if (response.status === 401 && retryCount === 0) {
    // Single-flight: concurrent 401s share one refresh. The old code had a race where a
    // second caller could read `refreshPromise` after it had been nulled, treat the
    // successful refresh as a failure, and log the user out.
    if (!refreshPromise) {
      refreshPromise = refreshSession(refreshToken).finally(() => {
        refreshPromise = null;
      });
    }
    const outcome = await refreshPromise;

    if (outcome === 'ok') return request<T>(url, options, 1);

    if (outcome === 'transport') {
      // Unknown, not invalid: one more try with backoff, session kept whatever happens.
      await sleep(fullJitterDelay(0));
      return request<T>(url, options, MAX_TRANSPORT_ATTEMPTS);
    }

    // 'expired': the server explicitly rejected the credential. This is the only path
    // that ends the session. No blind retry first — a retry here could only 401 again.
    clearStaleBearerTokens();
    localStorage.removeItem(SESSION_ID_KEY);
    throw new Error('登录已过期，请重新登录');
  }

  if (response.status === 401) {
    // A second 401 after a successful refresh means the credential really is dead.
    clearStaleBearerTokens();
    localStorage.removeItem(SESSION_ID_KEY);
    throw new Error('登录已过期，请重新登录');
  }

  if (!response.ok) {
    let message = `HTTP ${response.status}: ${response.statusText}`;
    let locked = false;
    let remainingSeconds = 0;
    let requiresTotp = false;
    let code: string | undefined;
    try {
      const errData = await response.json() as ApiResponse<unknown> & {
        remainingSeconds?: number;
        locked?: boolean;
        requiresTotp?: boolean;
        code?: string;
        details?: { fieldErrors?: Record<string, string[]> };
      };
      if (errData.error) message = errData.error;
      if (
        errData.details?.fieldErrors &&
        (message === 'Validation failed' || message === 'Invalid input' || message === '请求参数无效')
      ) {
        const detailText = Object.entries(errData.details.fieldErrors)
          .flatMap(([field, msgs]) => (msgs?.length ? [`${field}: ${msgs.join(', ')}`] : []))
          .join('；');
        if (detailText) message = detailText;
      }
      if (errData.locked) locked = true;
      if (typeof errData.remainingSeconds === 'number') remainingSeconds = errData.remainingSeconds;
      if (errData.requiresTotp) requiresTotp = true;
      if (errData.code) code = errData.code;
    } catch {
      // ignore
    }
    const err = new Error(message) as Error & {
      locked?: boolean;
      remainingSeconds?: number;
      requiresTotp?: boolean;
      code?: string;
    };
    err.locked = locked;
    err.remainingSeconds = remainingSeconds;
    if (requiresTotp) err.requiresTotp = true;
    if (code) err.code = code;
    throw err;
  }

  const data: ApiResponse<T> = await response.json();
  if (!data.success) throw new Error(data.error || 'Request failed');
  return data.data as T;
}

export const api = {
  get: <T>(url: string) => request<T>(url, { method: 'GET' }),
  post: <T>(url: string, body?: any) => request<T>(url, { method: 'POST', body: JSON.stringify(body) }),
  put: <T>(url: string, body?: any) => request<T>(url, { method: 'PUT', body: JSON.stringify(body) }),
  patch: <T>(url: string, body?: any) => request<T>(url, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T>(url: string, body?: any) => request<T>(url, { method: 'DELETE', ...(body ? { body: JSON.stringify(body) } : {}) }),
  getRaw: async <T>(url: string): Promise<{ data: T; pagination?: Record<string, unknown> }> => {
    const doFetch = () => {
      const { accessToken } = getTokens();
      return fetch(`${API_BASE}${url}`, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          ...(accessToken && { Authorization: `Bearer ${accessToken}` }),
        },
      });
    };
    let response = await doFetch();
    // Same contract as request(): one refresh-and-retry on the first 401, then give up.
    // getRaw used to skip this, so TriggerLogs' export/list died on a stale access cookie.
    if (response.status === 401) {
      const outcome = await (refreshPromise ?? refreshSession(getTokens().refreshToken));
      if (outcome === 'ok') response = await doFetch();
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = await response.json();
    if (!json.success) throw new Error(json.error || 'Request failed');
    return { data: json.data as T, pagination: json.pagination };
  },
};

export interface AvailableChannel {
  id: number;
  type: string;
  name: string;
  config_method: string;
  is_active: boolean;
  last_test_result: 'success' | 'failed' | null;
  last_test_at: string | null;
  connection_status: string | null;
}

export function fetchAvailableChannels() {
  return api.get<AvailableChannel[]>('/channels/available');
}

/** checkbox 107: named AI provider slots. `local` = Ollama / LM Studio. */
export type AiProviderName = 'primary' | 'fallback' | 'local';

export interface AiProviderStatusView {
  configured: boolean;
  model: string | null;
  /** Hostname only - the API never returns a full base URL. */
  host: string | null;
  /** Reachability of the active provider; null when not probed. */
  reachable: boolean | null;
}

export interface AiStatusView {
  enabled: boolean;
  provider: AiProviderName | null;
  primary: AiProviderStatusView;
  fallback: AiProviderStatusView;
  local: AiProviderStatusView;
  cache: { entries: number; maxEntries: number; ttlMs: number };
}

export interface AiConnectionTestView {
  ok: boolean;
  provider: AiProviderName | null;
  model: string | null;
  host: string | null;
  latencyMs: number;
  error?: { code: string; message: string };
}

/** checkbox 107: which AI provider is active (+ a short reachability probe). */
export function fetchAiStatus() {
  return api.get<AiStatusView>('/ai/status');
}

/** checkbox 107: send one tiny prompt to a named provider ("测试连接"). */
export function runAiConnectionTest(provider: AiProviderName) {
  return api.post<AiConnectionTestView>('/ai/test', { provider });
}

/** checkbox 101: coarse grant carried by an agent token. `read` is the default. */
export type AgentTokenScope = 'read' | 'write' | 'admin';

/** checkbox 101: a stored token as the API ever reveals it - never the raw value/hash. */
export interface AgentTokenView {
  id: string;
  name: string;
  scopes: AgentTokenScope[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
}

/** The one-time POST response: the raw token is present here and NOWHERE else. */
export interface CreatedAgentTokenView {
  token: string;
  record: AgentTokenView;
}

/** checkbox 101: list the caller's agent tokens (raw values are never included). */
export function fetchAgentTokens() {
  return api.get<{ tokens: AgentTokenView[] }>('/agent-tokens');
}

/** checkbox 101: mint a token. The raw value is returned exactly once. */
export function createAgentToken(name: string, scopes: AgentTokenScope[]) {
  return api.post<CreatedAgentTokenView>('/agent-tokens', { name, scopes });
}

/** checkbox 101: rename a token (returns no payload). */
export function renameAgentToken(id: string, name: string) {
  return api.patch<void>(`/agent-tokens/${id}`, { name });
}

/** checkbox 101: revoke a token (soft delete; returns no payload). */
export function revokeAgentToken(id: string) {
  return api.post<void>(`/agent-tokens/${id}/revoke`, {});
}

// ---------------------------------------------------------------------------
// checkbox 109: the in-app assistant client for the agent action surface.
//   GET  /api/agent/tools            -> the registry (name + required scope + flags)
//   POST /api/agent/actions/:tool    -> validate -> authorise -> (confirm | execute)
//   POST /api/agent/confirm/:id      -> phase 2; consumes the confirmation (single-use, 2-min TTL)
// The 202 `confirm_required` response is surfaced AS-IS: the action has NOT run.
// ---------------------------------------------------------------------------

/** checkbox 109: one registry entry as GET /api/agent/tools reveals it. */
export interface AgentToolView {
  name: string;
  description: string;
  requiredScope: string;
  destructive: boolean;
  requiresConfirmation: boolean;
  inputSchema?: unknown;
}

/** checkbox 109: the backend's redacted, human-readable confirmation preview. Rendered verbatim. */
export interface AgentToolPreview {
  tool: string;
  description: string;
  args: unknown;
  expiresAt: string;
}

export type AgentActionOutcome =
  | { kind: 'executed'; data: unknown }
  | { kind: 'confirm_required'; confirmationId: string; preview: AgentToolPreview };

export type AgentConfirmFailureCode =
  | 'confirmation_not_found'
  | 'confirmation_already_used'
  | 'confirmation_expired'
  | 'invalid_confirmation_id'
  | 'forbidden'
  | 'unknown';

export type AgentConfirmOutcome =
  | { kind: 'executed'; data: unknown }
  | { kind: 'failed'; status: number; code: AgentConfirmFailureCode; message: string };

/**
 * Map a failed confirm response onto the route's documented contract. 409 and 410 are the two
 * distinct cases the UI must tell apart (`confirmation_already_used` vs `confirmation_expired`).
 */
function classifyConfirmFailure(status: number, raw: string): AgentConfirmFailureCode {
  if (raw === 'confirmation_already_used' || status === 409) return 'confirmation_already_used';
  if (raw === 'confirmation_expired' || status === 410) return 'confirmation_expired';
  if (raw === 'invalid_confirmation_id' || status === 400) return 'invalid_confirmation_id';
  if (raw === 'confirmation_not_found' || status === 404) return 'confirmation_not_found';
  if (status === 401 || status === 403) return 'forbidden';
  return 'unknown';
}

/** checkbox 109: the registry of tools the signed-in owner may invoke. */
export function fetchAgentTools() {
  return api.get<{ tools: AgentToolView[] }>('/agent/tools');
}

/**
 * checkbox 109: invoke one registry tool with typed arguments.
 * A 202 `confirm_required` outcome is returned unchanged - nothing has executed, and the caller
 * must obtain explicit user consent before `confirmAgentAction`.
 */
export async function invokeAgentAction(tool: string, args: unknown): Promise<AgentActionOutcome> {
  const data = await api.post<unknown>(`/agent/actions/${encodeURIComponent(tool)}`, { args });
  if (data && typeof data === 'object' && (data as { status?: unknown }).status === 'confirm_required') {
    const pending = data as { confirmationId: string; preview: AgentToolPreview };
    return { kind: 'confirm_required', confirmationId: pending.confirmationId, preview: pending.preview };
  }
  return { kind: 'executed', data };
}

/**
 * checkbox 109: phase 2. Consumes a pending confirmation and reports the distinct 404/409/410
 * outcomes instead of collapsing them into one generic error.
 */
export async function confirmAgentAction(confirmationId: string): Promise<AgentConfirmOutcome> {
  const { accessToken } = getTokens();
  const response = await fetch(`${API_BASE}/agent/confirm/${encodeURIComponent(confirmationId)}`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      ...(accessToken && { Authorization: `Bearer ${accessToken}` }),
    },
  });
  let body: (ApiResponse<unknown> & { code?: string; message?: string }) | null = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (response.ok && body?.success) return { kind: 'executed', data: body.data };
  const raw = body?.error || body?.code || '';
  return {
    kind: 'failed',
    status: response.status,
    code: classifyConfirmFailure(response.status, raw),
    message: body?.message || raw || `HTTP ${response.status}`,
  };
}

// ---------------------------------------------------------------------------
// checkbox 132: global search across every entity (GET /api/search).
//   GET /api/search?q=&types=&limit= -> ranked hits across all ten entity types
//   plus per-type facet counts. The command palette (Ctrl/Cmd+K) is the consumer.
// ---------------------------------------------------------------------------

/** The ten result-entity types `GET /api/search` folds together. */
export const GLOBAL_SEARCH_TYPES = [
  'event',
  'contact',
  'interaction',
  'document',
  'expiry',
  'inventory',
  'maintenance',
  'habit',
  'goal',
  'inbox',
] as const;
export type GlobalSearchType = (typeof GLOBAL_SEARCH_TYPES)[number];

export interface GlobalSearchHit {
  owner_type: GlobalSearchType;
  owner_id: number;
  title: string;
  subtitle: string | null;
  rank: number;
}

/** Per-type facet counts; every one of the ten keys is present (0 when nothing matched). */
export type GlobalSearchFacets = Record<GlobalSearchType, number>;

export interface GlobalSearchResponse {
  mode: 'trigram';
  query: string;
  /** The effective type filter (all ten when the request specified none). */
  types: GlobalSearchType[];
  /** `types` values the server dropped because they are not known entity types. */
  ignoredTypes: string[];
  /** The effective, clamped page size. */
  limit: number;
  /** Total matches across every facet (NOT capped by `limit`). */
  total: number;
  facets: GlobalSearchFacets;
  results: GlobalSearchHit[];
}

/** checkbox 132: ranked global search over the ten entity types + facets. Zero egress. */
export function globalSearch(
  query: string,
  options: { types?: GlobalSearchType[]; limit?: number } = {},
): Promise<GlobalSearchResponse> {
  const params = new URLSearchParams({ q: query });
  if (options.types && options.types.length > 0) params.set('types', options.types.join(','));
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  return api.get<GlobalSearchResponse>(`/search?${params.toString()}`);
}

// ---------------------------------------------------------------------------
// checkbox 134: cross-entity tags (vocabulary, links, and the AND/OR smart filter)
// ---------------------------------------------------------------------------

export const TAG_ENTITY_TYPES = [
  'event',
  'contact',
  'document',
  'expiry',
  'inventory',
  'maintenance',
  'habit',
  'goal',
] as const;
export type TagEntityType = (typeof TAG_ENTITY_TYPES)[number];
export type TagFilterMode = 'and' | 'or';

export interface TagRecord {
  id: number;
  name: string;
  color: string | null;
  created_at: string;
  /** Present on the vocabulary list; 0 when the tag is unused. */
  link_count?: number;
}

export interface TaggedEntity {
  entity_type: TagEntityType;
  entity_id: number;
  tag_ids: number[];
}

/** The caller's tag vocabulary, name-ordered, with link counts. */
export function listTags(): Promise<TagRecord[]> {
  return api.get<TagRecord[]>('/tags');
}

export function createTag(input: { name: string; color?: string | null }): Promise<TagRecord> {
  return api.post<TagRecord>('/tags', input);
}

export function updateTag(id: number, patch: { name?: string; color?: string | null }): Promise<TagRecord> {
  return api.patch<TagRecord>(`/tags/${id}`, patch);
}

/** Deletes the tag AND its links; the linked entities are never touched by this call. */
export function deleteTag(id: number): Promise<void> {
  return api.delete<void>(`/tags/${id}`);
}

export interface TagLinkRecord {
  tag_id: number;
  entity_type: TagEntityType;
  entity_id: number;
  created_at: string;
}

/** Idempotent: linking the same pair twice succeeds (the second call recreates nothing). */
export function linkTag(tagId: number, entityType: TagEntityType, entityId: number): Promise<TagLinkRecord> {
  return api.post<TagLinkRecord>(`/tags/${tagId}/links`, { entityType, entityId });
}

export function unlinkTag(tagId: number, entityType: TagEntityType, entityId: number): Promise<void> {
  return api.delete<void>(`/tags/${tagId}/links`, { entityType, entityId });
}

/**
 * Smart filter: entities carrying the requested tags. ALL tags by default (`mode: 'and'`),
 * ANY with `mode: 'or'`; composes with the entity-type filter and the limit.
 */
export function listTaggedEntities(options: {
  tagIds: number[];
  mode?: TagFilterMode;
  entityTypes?: TagEntityType[];
  limit?: number;
}): Promise<TaggedEntity[]> {
  const params = new URLSearchParams();
  if (options.tagIds.length > 0) params.set('tagIds', options.tagIds.join(','));
  if (options.mode) params.set('mode', options.mode);
  if (options.entityTypes && options.entityTypes.length > 0) {
    params.set('entityTypes', options.entityTypes.join(','));
  }
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  return api.get<TaggedEntity[]>(`/tags/entities?${params.toString()}`);
}
