import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { BlobNotFoundError, del, get, issueSignedToken, presignUrl, put } from '@vercel/blob';
import { createLogger } from '../utils/logger.js';

/**
 * Provider-agnostic object storage for attachments (todo 52).
 *
 * Modes (resolved lazily at call time, never at module load - tests and the
 * dev/prod switch both depend on that):
 *  - `blob`         : `BLOB_READ_WRITE_TOKEN` is set; Vercel Blob via the official SDK.
 *  - `local`        : no token AND not a production runtime; a dev-only fallback that
 *                     writes under `.data/` (override with `ATTACHMENT_LOCAL_DIR`).
 *  - `unconfigured` : no token in production (NODE_ENV=production or VERCEL); every
 *                     operation REFUSES (throws) instead of silently writing to disk,
 *                     so an attachment request fails with 503 rather than persisting
 *                     bytes to an ephemeral serverless filesystem.
 *
 * Bytes are NEVER written to Postgres. `putObject` returns `{ url, size, sha256 }`
 * where `sha256` is computed in-process from the exact bytes handed in.
 *
 * The SDK's `get()` returns null for a missing blob, so a separate `head()`
 * round-trip would only add latency; key safety is validated here instead.
 */
const log = createLogger('storage');

export type StorageMode = 'blob' | 'local' | 'unconfigured';

/** Short-lived cap for signed URLs: no caller can mint a link valid for > 5 minutes. */
export const SIGNED_URL_MAX_TTL_SECONDS = 300;

export interface PutObjectResult {
  /** Provider URL of the stored object. Never returned to clients or logged. */
  url: string;
  /** Exact byte length of the stored payload. */
  size: number;
  /** SHA-256 hex digest of the stored payload. */
  sha256: string;
}

export interface StoredObject {
  stream: ReadableStream<Uint8Array>;
  size: number;
}

export class StorageNotConfiguredError extends Error {
  readonly code = 'STORAGE_NOT_CONFIGURED';
  constructor() {
    super(
      '附件存储未配置：请设置 BLOB_READ_WRITE_TOKEN（生产环境禁止回退到本地磁盘）',
    );
    this.name = 'StorageNotConfiguredError';
  }
}

export class StorageKeyError extends Error {
  readonly code = 'STORAGE_KEY_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'StorageKeyError';
  }
}

function readToken(): string | undefined {
  const token = process.env.BLOB_READ_WRITE_TOKEN?.trim();
  return token ? token : undefined;
}

export function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
}

export function resolveStorageMode(): StorageMode {
  if (readToken()) return 'blob';
  return isProductionRuntime() ? 'unconfigured' : 'local';
}

/** Blob store access level. Private by default; a public store can opt in via BLOB_ACCESS. */
function blobAccess(): 'private' | 'public' {
  return process.env.BLOB_ACCESS === 'public' ? 'public' : 'private';
}

export function localBaseDir(): string {
  const configured = process.env.ATTACHMENT_LOCAL_DIR?.trim();
  return configured ? resolve(configured) : join(process.cwd(), '.data', 'attachments');
}

/**
 * Keys are generated internally (`attachments/<userId>/<uuid>.<ext>`) and must never
 * be derived from a user-supplied filename. Still, reject traversal shapes so a bug
 * upstream cannot escape the local base directory (defense in depth).
 */
function assertSafeKey(key: string): void {
  if (!key || key.length > 512) throw new StorageKeyError('存储 key 为空或过长');
  if (key.includes('\0') || key.includes('\\') || key.includes(':') || key.startsWith('/')) {
    throw new StorageKeyError('存储 key 含非法字符');
  }
  const segments = key.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new StorageKeyError('存储 key 含路径穿越片段');
  }
}

function localPathFor(key: string): string {
  const base = localBaseDir();
  const target = resolve(base, ...key.split('/'));
  if (target !== base && !target.startsWith(base + sep)) {
    throw new StorageKeyError('存储 key 越出本地存储目录');
  }
  return target;
}

function requireMode(): 'blob' | 'local' {
  const mode = resolveStorageMode();
  if (mode === 'unconfigured') throw new StorageNotConfiguredError();
  return mode;
}

function toWebStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * Store `bytes` under `key`. `sha256` is computed here (the DB stores it), and the
 * returned `size` is the exact payload length. Blob writes reject overwrite by
 * default, so a key collision surfaces instead of silently replacing data.
 */
export async function putObject(
  key: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<PutObjectResult> {
  assertSafeKey(key);
  const mode = requireMode();
  if (bytes.byteLength === 0) throw new StorageKeyError('不能存储空文件');

  const sha256 = createHash('sha256').update(bytes).digest('hex');

  if (mode === 'blob') {
    const result = await put(key, Buffer.from(bytes), {
      access: blobAccess(),
      contentType,
      addRandomSuffix: false,
      allowOverwrite: false,
      cacheControlMaxAge: 60 * 60,
    });
    return { url: result.url, size: bytes.byteLength, sha256 };
  }

  const filePath = localPathFor(key);
  await mkdir(dirname(filePath), { recursive: true });
  // `wx` = fail if the key already exists, mirroring Blob's allowOverwrite: false.
  await writeFile(filePath, bytes, { flag: 'wx' });
  return { url: `local://${key}`, size: bytes.byteLength, sha256 };
}

/**
 * Short-lived signed download URL, or `null` in the local fallback (there is no CDN
 * to sign against; the attachment route streams the bytes instead). The TTL is
 * clamped to [1, 300] seconds so no caller can mint a longer-lived link.
 */
export async function getSignedUrl(key: string, ttlSeconds: number): Promise<string | null> {
  assertSafeKey(key);
  const mode = requireMode();
  if (mode === 'local') return null;

  const ttl = Math.max(1, Math.min(Math.floor(ttlSeconds), SIGNED_URL_MAX_TTL_SECONDS));
  const validUntil = Date.now() + ttl * 1000;
  const signedToken = await issueSignedToken({
    pathname: key,
    operations: ['get'],
    validUntil,
  });
  const { presignedUrl } = await presignUrl(signedToken, {
    operation: 'get',
    pathname: key,
    access: blobAccess(),
    validUntil,
  });
  return presignedUrl;
}

/** Fetch stored bytes (streamed) or `null` when the object does not exist. */
export async function getObject(key: string): Promise<StoredObject | null> {
  assertSafeKey(key);
  const mode = requireMode();

  if (mode === 'blob') {
    const result = await get(key, { access: blobAccess() });
    if (!result || result.statusCode !== 200) return null;
    return { stream: result.stream, size: result.blob.size };
  }

  try {
    const bytes = await readFile(localPathFor(key));
    return { stream: toWebStream(new Uint8Array(bytes)), size: bytes.byteLength };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Delete the stored object. Missing objects are treated as already deleted. */
export async function deleteObject(key: string): Promise<void> {
  assertSafeKey(key);
  const mode = requireMode();

  if (mode === 'blob') {
    try {
      await del(key);
    } catch (error) {
      if (error instanceof BlobNotFoundError) return;
      throw error;
    }
    return;
  }

  await rm(localPathFor(key), { force: true });
}

/**
 * Startup status line. Called once from bootstrap (index.ts) and from the Vercel
 * cold-start init so an operator sees the mode loudly in logs: a warning for the
 * dev-only local fallback and an error when production is missing the token.
 */
export function logStorageStartupStatus(): void {
  const mode = resolveStorageMode();
  if (mode === 'unconfigured') {
    log.error(
      { event: 'storage.unconfigured' },
      'BLOB_READ_WRITE_TOKEN 未设置：生产环境附件功能将返回 503，不会回退写入本地磁盘',
    );
    return;
  }
  if (mode === 'local') {
    log.warn(
      { event: 'storage.local_fallback', dir: localBaseDir() },
      'BLOB_READ_WRITE_TOKEN 未设置：附件回退到本地 .data/ 目录（仅开发模式，生产环境将拒绝附件操作）',
    );
  }
}
