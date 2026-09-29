/**
 * OpenAI-compatible embeddings client (checkbox 106) - OPT-IN accelerator only.
 *
 * The default search path is `pg_trgm` and never touches this module: semantic search
 * exists only when `EMBEDDINGS_ENABLED=true`, and the default endpoint is a LOCAL Ollama
 * server so a free-tier personal deployment never needs a paid embedding API. The request
 * shape mirrors the chat gateway (`services/ai/gateway.ts`): POST `${baseUrl}/embeddings`
 * with `{ model, input }`, which both Ollama (`/v1/embeddings`) and OpenAI understand.
 *
 * `MAX_EMBEDDING_DIMS` (2048) mirrors the `<= 2048` CHECKs on `embeddings.dims` and
 * `vector_dims(embeddings.embedding)` in migration v53: an oversized model config is
 * rejected HERE with a clear message before the database constraint has to.
 */
export const MAX_EMBEDDING_DIMS = 2048;
export const DEFAULT_EMBEDDINGS_MODEL = 'nomic-embed-text';
export const DEFAULT_EMBEDDINGS_BASE_URL = 'http://127.0.0.1:11434/v1';

const EMBEDDINGS_TIMEOUT_MS = 20_000;
const ERROR_DETAIL_MAX_CHARS = 200;

export type EmbeddingsEnv = Record<string, string | undefined>;
export type EmbeddingsFetch = typeof fetch;

export type EmbeddingsErrorCode =
  | 'EMBEDDINGS_DISABLED'
  | 'EMBEDDINGS_DIMS'
  | 'EMBEDDINGS_HTTP'
  | 'EMBEDDINGS_PARSE'
  | 'EMBEDDINGS_NETWORK';

export class EmbeddingsError extends Error {
  readonly code: EmbeddingsErrorCode;

  constructor(message: string, code: EmbeddingsErrorCode) {
    super(message);
    this.name = 'EmbeddingsError';
    this.code = code;
  }
}

/** Normal path when `EMBEDDINGS_ENABLED` is unset; callers degrade, never crash. */
export class EmbeddingsDisabledError extends EmbeddingsError {
  constructor() {
    super(
      'semantic search is unavailable: set EMBEDDINGS_ENABLED=true (and optionally EMBEDDINGS_BASE_URL/EMBEDDINGS_MODEL) to enable it',
      'EMBEDDINGS_DISABLED',
    );
    this.name = 'EmbeddingsDisabledError';
  }
}

export interface EmbeddingsConfig {
  baseUrl: string;
  apiKey: string | null;
  model: string;
  /** Configured dimension count, or null when the provider's actual dims are trusted. */
  dims: number | null;
  /** Hostname only - safe for a status payload, never the full URL and never the key. */
  host: string;
}

export interface EmbeddingsStatus {
  enabled: boolean;
  model: string | null;
  host: string | null;
  dims: number | null;
  maxDims: number;
}

export interface EmbeddingsDeps {
  /** Injected for tests so no test ever performs a real outbound request. */
  fetchImpl?: EmbeddingsFetch;
  env?: EmbeddingsEnv;
}

function safeHost(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).host;
  } catch {
    return null;
  }
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  return 'unknown error';
}

function parseDims(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function isEmbeddingsEnabled(env: EmbeddingsEnv = process.env): boolean {
  return String(env.EMBEDDINGS_ENABLED ?? '').trim().toLowerCase() === 'true';
}

/** Null when the feature is off (the default). Never throws on a malformed env value. */
export function getEmbeddingsConfig(env: EmbeddingsEnv = process.env): EmbeddingsConfig | null {
  if (!isEmbeddingsEnabled(env)) return null;
  const baseUrl = (env.EMBEDDINGS_BASE_URL?.trim() || DEFAULT_EMBEDDINGS_BASE_URL).replace(/\/+$/, '');
  const apiKey = env.EMBEDDINGS_API_KEY?.trim() || null;
  const model = env.EMBEDDINGS_MODEL?.trim() || DEFAULT_EMBEDDINGS_MODEL;
  const host = safeHost(baseUrl);
  if (host === null) return null;
  return { baseUrl, apiKey, model, dims: parseDims(env.EMBEDDINGS_DIMS), host };
}

export function getEmbeddingsStatus(env: EmbeddingsEnv = process.env): EmbeddingsStatus {
  const config = getEmbeddingsConfig(env);
  return {
    enabled: config !== null,
    model: config?.model ?? null,
    host: config?.host ?? null,
    dims: config?.dims ?? null,
    maxDims: MAX_EMBEDDING_DIMS,
  };
}

/**
 * Rejects a vector length the `embeddings.embedding` column cannot hold. Exported so the
 * indexing / semantic paths validate injected providers with the same message.
 */
export function assertEmbeddingDims(dims: number, model: string): void {
  if (!Number.isInteger(dims) || dims <= 0) {
    throw new EmbeddingsError(`embedding dimension ${dims} is not a positive integer`, 'EMBEDDINGS_DIMS');
  }
  if (dims > MAX_EMBEDDING_DIMS) {
    throw new EmbeddingsError(
      `embedding dimension ${dims} for model ${model} exceeds the maximum ${MAX_EMBEDDING_DIMS}: ` +
        `the embeddings.embedding column rejects vectors longer than ${MAX_EMBEDDING_DIMS} dims`,
      'EMBEDDINGS_DIMS',
    );
  }
}

function parseEmbeddingsPayload(payload: unknown, config: EmbeddingsConfig): number[][] {
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) {
    throw new EmbeddingsError(
      `embeddings provider returned a malformed response from ${config.host}`,
      'EMBEDDINGS_PARSE',
    );
  }
  const vectors = data.map((entry, index) => {
    const embedding = (entry as { embedding?: unknown } | null)?.embedding;
    if (
      !Array.isArray(embedding) ||
      embedding.length === 0 ||
      embedding.some((value) => typeof value !== 'number' || !Number.isFinite(value))
    ) {
      throw new EmbeddingsError(
        `embeddings provider returned a malformed vector at index ${index} from ${config.host}`,
        'EMBEDDINGS_PARSE',
      );
    }
    return embedding as number[];
  });
  for (const vector of vectors) {
    assertEmbeddingDims(vector.length, config.model);
    if (config.dims !== null && vector.length !== config.dims) {
      throw new EmbeddingsError(
        `embeddings model ${config.model} returned ${vector.length} dims but EMBEDDINGS_DIMS=${config.dims}`,
        'EMBEDDINGS_PARSE',
      );
    }
  }
  return vectors;
}

/**
 * Embed `texts` with the configured OpenAI-compatible provider.
 * Throws `EmbeddingsDisabledError` when `EMBEDDINGS_ENABLED` is unset - callers must
 * treat that as "semantic search unavailable", not as a failure of anything else.
 */
export async function embedTexts(texts: string[], deps: EmbeddingsDeps = {}): Promise<number[][]> {
  const env = deps.env ?? process.env;
  const config = getEmbeddingsConfig(env);
  if (!config) throw new EmbeddingsDisabledError();
  if (texts.length === 0) return [];
  if (config.dims !== null) assertEmbeddingDims(config.dims, config.model);

  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBEDDINGS_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(`${config.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: config.model, input: texts }),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new EmbeddingsError(
        `embeddings request timed out after ${EMBEDDINGS_TIMEOUT_MS} ms talking to ${config.host}`,
        'EMBEDDINGS_NETWORK',
      );
    }
    throw new EmbeddingsError(
      `embeddings network error talking to ${config.host}: ${describeCause(error)}`,
      'EMBEDDINGS_NETWORK',
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new EmbeddingsError(
      `embeddings provider HTTP ${response.status}: ${detail.replace(/\s+/g, ' ').trim().slice(0, ERROR_DETAIL_MAX_CHARS) || 'request failed'}`,
      'EMBEDDINGS_HTTP',
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new EmbeddingsError(
      `embeddings provider returned a malformed response from ${config.host}`,
      'EMBEDDINGS_PARSE',
    );
  }
  return parseEmbeddingsPayload(payload, config);
}
