/**
 * Optional OCR for documents and receipts (task 146).
 *
 * OCR is OPTIONAL and OFF BY DEFAULT. The service is built around a pluggable
 * `OcrEngine` seam:
 *
 *   - No engine configured  -> `enabled: false`, `recognize()` throws
 *     `OcrDisabledError` and the route answers a clear "OCR disabled" state.
 *   - Local/free engine     -> `createTesseractEngine()` wraps tesseract.js
 *     (local WASM, no network). It is resolved LAZILY and only when
 *     `OCR_ENGINE=tesseract`; if the package is not installed the resolver
 *     returns null and OCR stays disabled.
 *
 * There is deliberately NO paid/cloud engine shipped here: this module never
 * calls a paid API. Any future engine that needs the network MUST perform its
 * request through `OcrEngineContext.fetch`, which is the egress guard - never
 * the global `fetch`. The guard blocks non-allowlisted hosts and caps payloads.
 *
 * Structured extraction (issuer / date / total / currency) is a pure function
 * over the recognised text so it can be unit-tested without a real engine.
 */
import { query } from '../../db/index.js';
import { createLogger } from '../../utils/logger.js';
import { createEgressGuard, type EgressGuard } from './egress-guard.service.js';

const log = createLogger('ocr');

/** Per-file cap, matching the attachment pipeline (rejected before any work). */
export const OCR_MAX_BYTES = 2 * 1024 * 1024;
/** Types a local engine can read (images + a single-page PDF). */
export const OCR_SUPPORTED_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/pdf',
] as const;
export type OcrContentType = (typeof OCR_SUPPORTED_TYPES)[number];
/** Bounded stored excerpt - never the whole document body. */
export const OCR_TEXT_EXCERPT_MAX = 4000;
export const OCR_ENGINE_ENV = 'OCR_ENGINE';
/** Recognised `OCR_ENGINE` value for the bundled local engine. */
export const OCR_TESSERACT_ENGINE = 'tesseract';

export class OcrDisabledError extends Error {
  constructor() {
    super('OCR is not enabled: no engine is configured');
    this.name = 'OcrDisabledError';
  }
}

export class OcrUnsupportedTypeError extends Error {
  readonly contentType: string;
  constructor(contentType: string) {
    super(`unsupported OCR content type: ${contentType || 'unknown'}`);
    this.name = 'OcrUnsupportedTypeError';
    this.contentType = contentType;
  }
}

export class OcrTooLargeError extends Error {
  readonly byteSize: number;
  constructor(byteSize: number) {
    super(`OCR input of ${byteSize} bytes exceeds the ${OCR_MAX_BYTES}-byte cap`);
    this.name = 'OcrTooLargeError';
    this.byteSize = byteSize;
  }
}

export class OcrFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OcrFailedError';
  }
}

export interface OcrEngineOutput {
  text: string;
}

/** Anything a network engine may reach for. The only sanctioned outbound path. */
export interface OcrEngineContext {
  fetch: EgressGuard['fetch'];
}

export interface OcrEngine {
  readonly name: string;
  /** True when the engine runs entirely locally (no egress). */
  readonly local: boolean;
  recognize(
    input: { bytes: Uint8Array; contentType: string },
    ctx: OcrEngineContext,
  ): Promise<OcrEngineOutput>;
}

export interface StructuredFields {
  issuer: string | null;
  date: string | null;
  total: number | null;
  currency: string | null;
}

export function isOcrContentType(value: unknown): value is OcrContentType {
  return typeof value === 'string' && (OCR_SUPPORTED_TYPES as readonly string[]).includes(value);
}

function firstMatch(text: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) {
      const value = (match[1] ?? match[0] ?? '').trim();
      if (value) return value;
    }
  }
  return null;
}

function normaliseDate(raw: string | null): string | null {
  if (!raw) return null;
  const numeric = raw.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (numeric) {
    const [, y, m, d] = numeric;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const cjk = raw.match(/(\d{4})\s*年\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日)?/);
  if (cjk) {
    const [, y, m, d] = cjk;
    return `${y}-${m.padStart(2, '0')}-${(d ?? '01').padStart(2, '0')}`;
  }
  return null;
}

function parseAmount(raw: string | null): number | null {
  if (!raw) return null;
  const match = raw.replace(/,/g, '').match(/\d+(?:\.\d{1,2})?/);
  if (!match) return null;
  const value = Number.parseFloat(match[0]);
  return Number.isFinite(value) ? value : null;
}

function detectCurrency(text: string): string | null {
  if (/人民币|RMB|CNY|￥|¥|元/.test(text)) return 'CNY';
  if (/美元|USD|\$/.test(text)) return 'USD';
  if (/欧元|EUR|€/.test(text)) return 'EUR';
  if (/英镑|GBP|£/.test(text)) return 'GBP';
  if (/日元|JPY|円/.test(text)) return 'JPY';
  return null;
}

/**
 * Best-effort extraction of a few structured fields from OCR text. Pure and
 * total: every field may be null when nothing recognisable is found.
 */
export function extractStructuredFields(text: string): StructuredFields {
  const safe = typeof text === 'string' ? text : '';
  const issuer = firstMatch(safe, [
    /(?:签发|颁发|发证|出具|issuer|issued\s*by|authority)\s*[:：]?\s*([^\n]{2,60})/i,
    /([^\n]{2,40}(?:局|厅|中心|公司|银行|医院|学校|学院|派出所|管理局))/,
  ]);
  const date = normaliseDate(
    firstMatch(safe, [
      /(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})/,
      /(\d{4}\s*年\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*日)?)/,
    ]),
  );
  const amountRaw = firstMatch(safe, [
    /(?:合计|总计|总金额|金额|应付|实付|消费|total|amount)\s*[:：]?\s*([^\n]{0,30})/i,
  ]);
  const total = parseAmount(amountRaw ?? firstMatch(safe, [/(\d[\d,]*\.\d{2})/]));
  return { issuer, date, total, currency: detectCurrency(safe) };
}

function toExcerpt(text: string): string {
  return text.length > OCR_TEXT_EXCERPT_MAX ? text.slice(0, OCR_TEXT_EXCERPT_MAX) : text;
}

/**
 * Wrap a tesseract.js module (or the module namespace returned by a lazy
 * `import('tesseract.js')`) into an `OcrEngine`. Kept duck-typed so a test can
 * pass a fake module without the real dependency.
 */
export function createTesseractEngine(module: unknown): OcrEngine {
  const mod = module as { createWorker?: (...args: any[]) => Promise<any> } | null;
  return {
    name: 'tesseract',
    local: true,
    async recognize({ bytes }) {
      if (!mod || typeof mod.createWorker !== 'function') {
        throw new OcrFailedError('tesseract.js createWorker is unavailable');
      }
      let worker: any = null;
      try {
        worker = await mod.createWorker('eng');
        const { data } = await worker.recognize(Buffer.from(bytes));
        const text = typeof data?.text === 'string' ? data.text : '';
        return { text };
      } catch (error) {
        throw new OcrFailedError(error instanceof Error ? error.message : 'OCR engine failed');
      } finally {
        if (worker && typeof worker.terminate === 'function') {
          await worker.terminate().catch(() => undefined);
        }
      }
    },
  };
}

let cachedEngine: Promise<OcrEngine | null> | null = null;

/**
 * Resolve the engine from the environment. Defaults to null (disabled). Only
 * `OCR_ENGINE=tesseract` attempts a load, and a missing package keeps OCR off
 * rather than failing the request.
 */
export async function resolveOcrEngineFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<OcrEngine | null> {
  const requested = (env[OCR_ENGINE_ENV] ?? '').trim().toLowerCase();
  if (requested !== OCR_TESSERACT_ENGINE) return null;
  try {
    // Variable specifier so TS never tries to resolve an optional dependency.
    const spec = OCR_TESSERACT_ENGINE + '.js';
    const mod: unknown = await import(spec);
    return createTesseractEngine(mod);
  } catch {
    log.warn({ event: 'ocr.engine_unavailable', engine: requested }, 'OCR engine requested but not installed; staying disabled');
    return null;
  }
}

/** Cache the async engine resolution so a request does not re-import per call. */
export async function getOcrEngine(env: NodeJS.ProcessEnv = process.env): Promise<OcrEngine | null> {
  if (!cachedEngine) cachedEngine = resolveOcrEngineFromEnv(env);
  return cachedEngine;
}

/** Test/reset seam: drop the cached engine resolution. */
export function resetOcrEngineCache(): void {
  cachedEngine = null;
}

export interface OcrResult {
  text: string;
  excerpt: string;
  fields: StructuredFields;
  engine: string;
  contentType: string;
  byteSize: number;
}

export interface OcrService {
  readonly enabled: boolean;
  readonly engineName: string | null;
  recognize(input: { bytes: Uint8Array; contentType: string }): Promise<OcrResult>;
}

export interface CreateOcrServiceOptions {
  engine: OcrEngine | null;
  /** Egress guard handed to any network engine (default: env-configured guard). */
  guard?: EgressGuard;
}

export function createOcrService(options: CreateOcrServiceOptions): OcrService {
  const engine = options.engine;
  const guard = options.guard ?? createEgressGuard({});
  const ctx: OcrEngineContext = { fetch: guard.fetch };

  return {
    enabled: engine !== null,
    engineName: engine?.name ?? null,

    async recognize(input) {
      if (input.bytes.byteLength === 0) throw new OcrFailedError('OCR input is empty');
      if (input.bytes.byteLength > OCR_MAX_BYTES) throw new OcrTooLargeError(input.bytes.byteLength);
      if (!isOcrContentType(input.contentType)) throw new OcrUnsupportedTypeError(input.contentType);
      if (!engine) throw new OcrDisabledError();

      const output = await engine.recognize(
        { bytes: input.bytes, contentType: input.contentType },
        ctx,
      );
      const text = typeof output?.text === 'string' ? output.text : '';
      return {
        text,
        excerpt: toExcerpt(text),
        fields: extractStructuredFields(text),
        engine: engine.name,
        contentType: input.contentType,
        byteSize: input.bytes.byteLength,
      };
    },
  };
}

export interface StoreOcrResultInput {
  documentId?: number | null;
  attachmentId?: number | null;
  result: OcrResult;
  status?: 'extracted' | 'disabled' | 'failed';
  errorCode?: string | null;
}

export async function storeOcrResult(
  userId: number,
  input: StoreOcrResultInput,
): Promise<{ id: number }> {
  const result = await query(
    `INSERT INTO ocr_results
       (user_id, document_id, attachment_id, engine, status, content_type, byte_size, text_excerpt, fields, error_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      userId,
      input.documentId ?? null,
      input.attachmentId ?? null,
      input.result.engine,
      input.status ?? 'extracted',
      input.result.contentType,
      input.result.byteSize,
      input.result.excerpt,
      JSON.stringify(input.result.fields),
      input.errorCode ?? null,
    ],
  );
  return { id: Number(result.rows[0]?.id ?? 0) };
}

export interface OcrResultView {
  id: number;
  document_id: number | null;
  attachment_id: number | null;
  engine: string;
  status: string;
  content_type: string | null;
  byte_size: number | null;
  text_excerpt: string | null;
  fields: StructuredFields;
  created_at: string | null;
}

export async function listOcrResults(
  userId: number,
  options: { documentId?: number; limit?: number } = {},
): Promise<OcrResultView[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const params: unknown[] = [userId];
  let where = 'user_id = $1';
  if (options.documentId !== undefined) {
    params.push(options.documentId);
    where += ` AND document_id = $${params.length}`;
  }
  params.push(limit);
  const result = await query(
    `SELECT id, document_id, attachment_id, engine, status, content_type, byte_size, text_excerpt, fields, created_at
       FROM ocr_results
      WHERE ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length}`,
    params,
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    document_id: row.document_id == null ? null : Number(row.document_id),
    attachment_id: row.attachment_id == null ? null : Number(row.attachment_id),
    engine: String(row.engine),
    status: String(row.status),
    content_type: row.content_type == null ? null : String(row.content_type),
    byte_size: row.byte_size == null ? null : Number(row.byte_size),
    text_excerpt: row.text_excerpt == null ? null : String(row.text_excerpt),
    fields: (row.fields ?? {}) as StructuredFields,
    created_at: row.created_at == null ? null : new Date(row.created_at).toISOString(),
  }));
}

/** Ownership check for the optional document/attachment link (no existence leak). */
export async function documentBelongsToUser(userId: number, documentId: number): Promise<boolean> {
  const result = await query('SELECT 1 FROM documents WHERE id = $1 AND user_id = $2', [documentId, userId]);
  return result.rows.length > 0;
}

export async function attachmentBelongsToUser(userId: number, attachmentId: number): Promise<boolean> {
  const result = await query('SELECT 1 FROM attachments WHERE id = $1 AND user_id = $2', [attachmentId, userId]);
  return result.rows.length > 0;
}
