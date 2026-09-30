/**
 * Remote backup to WebDAV / S3-compatible storage (task 149).
 *
 * A per-user target is configured once (credentials encrypted at rest with the
 * shared crypto util / MASTER_KEY). A manual run serialises the SAME payload the
 * existing `routes/backup.ts` export produces (`{ version, exportedAt, events,
 * relationshipMappings, eventTemplates }`) and PUTs it to the target. Previous
 * backups can be listed and restored, and every attempt is recorded.
 *
 * Safety properties:
 *   - The target host MUST be on the egress-guard allowlist (via
 *     `EGRESS_ALLOWED_HOSTS` / `OBJECT_STORAGE_ENDPOINT`); every request goes
 *     through `EgressGuard.fetch`, never the global fetch.
 *   - Credentials are AES-GCM encrypted at rest and NEVER logged or serialised
 *     into a response.
 *   - A `dryRun` validates + builds the payload without any network call, and a
 *     configurable retention count prunes older objects after a success.
 */
import { createHash, createHmac } from 'crypto';
import { query } from '../../db/index.js';
import { createLogger } from '../../utils/logger.js';
import { encrypt, decrypt } from '@timemark/shared/crypto';
import { requireMasterKey } from '../../utils/secrets.js';
import {
  EgressBlockedError,
  createEgressGuard,
  hostOf,
  isAllowlistedHost,
  type EgressGuard,
} from './egress-guard.service.js';

const log = createLogger('remote-backup');

export const REMOTE_BACKUP_DEFAULT_RETENTION = 5;
export const REMOTE_BACKUP_MAX_RETENTION = 50;
/** Backups can exceed the guard's 256 KiB default, so the guard for this lane is raised. */
export const REMOTE_BACKUP_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
export const REMOTE_BACKUP_OBJECT_PREFIX = 'timemark-backup';
export const REMOTE_BACKUP_DEFAULT_S3_REGION = 'us-east-1';

export type RemoteBackupTargetType = 'webdav' | 's3';

export class RemoteBackupConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteBackupConfigError';
  }
}

export class RemoteBackupDisabledError extends Error {
  constructor() {
    super('remote backup target is disabled');
    this.name = 'RemoteBackupDisabledError';
  }
}

export class RemoteBackupEgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteBackupEgressError';
  }
}

export class RemoteBackupTargetError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = 'RemoteBackupTargetError';
    this.status = status;
  }
}

export class RemoteBackupPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteBackupPayloadError';
  }
}

export interface RemoteBackupConfigInput {
  targetType: RemoteBackupTargetType;
  endpoint: string;
  pathPrefix?: string | null;
  bucket?: string | null;
  region?: string | null;
  username?: string | null;
  password?: string | null;
  accessKeyId?: string | null;
  secretKey?: string | null;
  retentionCount?: number | null;
  enabled?: boolean | null;
}

/** Internal shape - carries the DECRYPTED secret. Never returned from an API. */
export interface RemoteBackupConfig {
  userId: number;
  targetType: RemoteBackupTargetType;
  endpoint: string;
  pathPrefix: string;
  bucket: string | null;
  region: string;
  username: string | null;
  accessKeyId: string | null;
  secret: string | null;
  retentionCount: number;
  enabled: boolean;
}

export interface RemoteBackupConfigView {
  targetType: RemoteBackupTargetType;
  endpoint: string;
  pathPrefix: string;
  bucket: string | null;
  region: string;
  username: string | null;
  accessKeyId: string | null;
  hasSecret: boolean;
  retentionCount: number;
  enabled: boolean;
  updatedAt: string | null;
}

export interface RemoteBackupRecord {
  id: number;
  kind: string;
  status: string;
  targetType: string | null;
  objectKey: string | null;
  byteSize: number | null;
  retentionDeleted: number;
  dryRun: boolean;
  errorCode: string | null;
  detail: Record<string, unknown>;
  createdAt: string | null;
}

export interface RemoteBackupObject {
  key: string;
  byteSize: number | null;
}

export interface RunRemoteBackupOptions {
  dryRun?: boolean;
  retentionCount?: number;
  guard?: EgressGuard;
}

export interface RunRemoteBackupResult {
  dryRun: boolean;
  objectKey: string;
  byteSize: number;
  retentionDeleted: number;
  recordId: number;
}

export interface RestoreRemoteBackupOptions {
  key: string;
  dryRun?: boolean;
  guard?: EgressGuard;
}

export interface RestoreRemoteBackupResult {
  dryRun: boolean;
  events: number;
  mappings: number;
  templates: number;
  applied: boolean;
  recordId: number;
}

export interface BackupPayload {
  version: string;
  exportedAt: string;
  events: Array<Record<string, unknown>>;
  relationshipMappings: Array<Record<string, unknown>>;
  eventTemplates: Array<Record<string, unknown>>;
}

function clean(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
}

function clampRetention(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value)) return REMOTE_BACKUP_DEFAULT_RETENTION;
  const n = Math.trunc(value);
  if (n <= 0) return 0;
  return Math.min(n, REMOTE_BACKUP_MAX_RETENTION);
}

function normaliseEndpoint(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

function toIso(value: string | Date | null): string | null {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function resolveGuard(optionsGuard?: EgressGuard): EgressGuard {
  return (
    optionsGuard ??
    createEgressGuard({ maxCallBytes: REMOTE_BACKUP_MAX_PAYLOAD_BYTES })
  );
}

function assertTargetAllowed(url: string, guard: EgressGuard): void {
  const host = hostOf(url);
  if (!host || !isAllowlistedHost(host, guard.allowlist())) {
    throw new RemoteBackupEgressError(`目标主机 ${host ?? '(invalid)'} 不在出站白名单中`);
  }
}

async function callTarget(guard: EgressGuard, url: string, init: RequestInit): Promise<Response> {
  try {
    return await guard.fetch(url, init);
  } catch (error) {
    if (error instanceof EgressBlockedError) {
      throw new RemoteBackupEgressError(error.message);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------

export async function saveRemoteBackupConfig(
  userId: number,
  input: RemoteBackupConfigInput,
): Promise<RemoteBackupConfigView> {
  const targetType = input.targetType;
  const endpoint = clean(input.endpoint);
  if (targetType !== 'webdav' && targetType !== 's3') {
    throw new RemoteBackupConfigError('未知的备份目标类型');
  }
  if (!endpoint) throw new RemoteBackupConfigError('目标地址不能为空');

  const bucket = targetType === 's3' ? clean(input.bucket) : null;
  if (targetType === 's3' && !bucket) throw new RemoteBackupConfigError('S3 目标必须提供 bucket');

  const pathPrefix = clean(input.pathPrefix) ?? '';
  const region = targetType === 's3' ? clean(input.region) ?? REMOTE_BACKUP_DEFAULT_S3_REGION : 'us-east-1';
  const username = targetType === 'webdav' ? clean(input.username) : null;
  const accessKeyId = targetType === 's3' ? clean(input.accessKeyId) : null;

  const newSecret = targetType === 'webdav' ? clean(input.password) : clean(input.secretKey);
  const secretEncrypted = newSecret ? encrypt(newSecret, requireMasterKey()) : null;
  const retentionCount = clampRetention(input.retentionCount);
  const enabled = input.enabled == null ? true : Boolean(input.enabled);

  const result = await query(
    `INSERT INTO remote_backup_configs
       (user_id, target_type, endpoint, path_prefix, bucket, region, access_key_id, username, secret_encrypted, retention_count, enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (user_id) DO UPDATE SET
       target_type = EXCLUDED.target_type,
       endpoint = EXCLUDED.endpoint,
       path_prefix = EXCLUDED.path_prefix,
       bucket = EXCLUDED.bucket,
       region = EXCLUDED.region,
       access_key_id = EXCLUDED.access_key_id,
       username = EXCLUDED.username,
       -- Keep the existing ciphertext when the update omits a new secret.
       secret_encrypted = COALESCE(EXCLUDED.secret_encrypted, remote_backup_configs.secret_encrypted),
       retention_count = EXCLUDED.retention_count,
       enabled = EXCLUDED.enabled,
       updated_at = now()
     RETURNING *`,
    [userId, targetType, endpoint, pathPrefix, bucket, region, accessKeyId, username, secretEncrypted, retentionCount, enabled],
  );
  return toConfigView(result.rows[0]);
}

function decryptSecret(row: Record<string, unknown>): string | null {
  const ciphertext = row.secret_encrypted == null ? null : String(row.secret_encrypted);
  if (!ciphertext) return null;
  try {
    return decrypt(ciphertext, requireMasterKey());
  } catch {
    throw new RemoteBackupConfigError('凭据解密失败：MASTER_KEY 可能已更改');
  }
}

function toConfig(row: Record<string, unknown>): RemoteBackupConfig {
  return {
    userId: Number(row.user_id),
    targetType: row.target_type as RemoteBackupTargetType,
    endpoint: String(row.endpoint),
    pathPrefix: row.path_prefix == null ? '' : String(row.path_prefix),
    bucket: row.bucket == null ? null : String(row.bucket),
    region: row.region == null ? REMOTE_BACKUP_DEFAULT_S3_REGION : String(row.region),
    username: row.username == null ? null : String(row.username),
    accessKeyId: row.access_key_id == null ? null : String(row.access_key_id),
    secret: decryptSecret(row),
    retentionCount: Number(row.retention_count ?? REMOTE_BACKUP_DEFAULT_RETENTION),
    enabled: row.enabled !== false,
  };
}

function toConfigView(row: Record<string, unknown> | undefined): RemoteBackupConfigView {
  if (!row) throw new RemoteBackupConfigError('备份目标不存在');
  return {
    targetType: row.target_type as RemoteBackupTargetType,
    endpoint: String(row.endpoint),
    pathPrefix: row.path_prefix == null ? '' : String(row.path_prefix),
    bucket: row.bucket == null ? null : String(row.bucket),
    region: row.region == null ? REMOTE_BACKUP_DEFAULT_S3_REGION : String(row.region),
    username: row.username == null ? null : String(row.username),
    accessKeyId: row.access_key_id == null ? null : String(row.access_key_id),
    hasSecret: row.secret_encrypted != null && row.secret_encrypted !== '',
    retentionCount: Number(row.retention_count ?? REMOTE_BACKUP_DEFAULT_RETENTION),
    enabled: row.enabled !== false,
    updatedAt: toIso((row.updated_at as string | Date | null) ?? null),
  };
}

export async function getRemoteBackupConfig(userId: number): Promise<RemoteBackupConfig | null> {
  const result = await query('SELECT * FROM remote_backup_configs WHERE user_id = $1', [userId]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? toConfig(row) : null;
}

export async function getRemoteBackupConfigView(userId: number): Promise<RemoteBackupConfigView | null> {
  const result = await query('SELECT * FROM remote_backup_configs WHERE user_id = $1', [userId]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? toConfigView(row) : null;
}

export async function deleteRemoteBackupConfig(userId: number): Promise<boolean> {
  const result = await query('DELETE FROM remote_backup_configs WHERE user_id = $1 RETURNING id', [userId]);
  return result.rows.length > 0;
}

// ---------------------------------------------------------------------------
// Attempt log
// ---------------------------------------------------------------------------

export async function recordRemoteBackupAttempt(
  userId: number,
  input: {
    kind: string;
    status: string;
    targetType?: string | null;
    objectKey?: string | null;
    byteSize?: number | null;
    retentionDeleted?: number;
    dryRun?: boolean;
    errorCode?: string | null;
    detail?: Record<string, unknown>;
  },
): Promise<number> {
  try {
    const result = await query(
      `INSERT INTO remote_backup_records
         (user_id, kind, status, target_type, object_key, byte_size, retention_deleted, dry_run, error_code, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        userId,
        input.kind,
        input.status,
        input.targetType ?? null,
        input.objectKey ?? null,
        input.byteSize ?? null,
        input.retentionDeleted ?? 0,
        input.dryRun ?? false,
        input.errorCode ?? null,
        JSON.stringify(input.detail ?? {}),
      ],
    );
    return Number(result.rows[0]?.id ?? 0);
  } catch (error) {
    // Logging a failed record must never mask the original outcome.
    log.warn(
      { event: 'remote_backup.record_failed', err: error instanceof Error ? error.message : 'unknown' },
      'failed to record remote backup attempt',
    );
    return 0;
  }
}

export async function listRemoteBackupRecords(userId: number, limit = 100): Promise<RemoteBackupRecord[]> {
  const capped = Math.min(Math.max(limit, 1), 200);
  const result = await query(
    `SELECT id, kind, status, target_type, object_key, byte_size, retention_deleted, dry_run, error_code, detail, created_at
       FROM remote_backup_records
      WHERE user_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [userId, capped],
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    kind: String(row.kind),
    status: String(row.status),
    targetType: row.target_type == null ? null : String(row.target_type),
    objectKey: row.object_key == null ? null : String(row.object_key),
    byteSize: row.byte_size == null ? null : Number(row.byte_size),
    retentionDeleted: Number(row.retention_deleted ?? 0),
    dryRun: row.dry_run === true,
    errorCode: row.error_code == null ? null : String(row.error_code),
    detail: (row.detail ?? {}) as Record<string, unknown>,
    createdAt: toIso((row.created_at as string | Date | null) ?? null),
  }));
}

// ---------------------------------------------------------------------------
// Payload + object addressing
// ---------------------------------------------------------------------------

/** Build the same payload shape as `routes/backup.ts` GET /export. */
export async function buildBackupPayload(userId: number): Promise<{ payload: BackupPayload; json: string }> {
  const [events, mappings, templates] = await Promise.all([
    query('SELECT * FROM events WHERE user_id = $1', [userId]),
    query('SELECT * FROM relationship_mappings WHERE user_id = $1', [userId]),
    query('SELECT * FROM event_templates WHERE user_id = $1', [userId]),
  ]);
  const payload: BackupPayload = {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    events: events.rows as Array<Record<string, unknown>>,
    relationshipMappings: mappings.rows as Array<Record<string, unknown>>,
    eventTemplates: templates.rows as Array<Record<string, unknown>>,
  };
  return { payload, json: JSON.stringify(payload) };
}

function joinKey(prefix: string, filename: string): string {
  const parts = [prefix, filename].map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean);
  return parts.join('/');
}

export function buildRemoteObjectKey(config: RemoteBackupConfig, userId: number, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return joinKey(config.pathPrefix, `${REMOTE_BACKUP_OBJECT_PREFIX}-${userId}-${stamp}.json`);
}

function objectUrl(config: RemoteBackupConfig, key: string): string {
  const base = normaliseEndpoint(config.endpoint);
  if (config.targetType === 'webdav') {
    return `${base}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }
  return `${base}/${encodeURIComponent(config.bucket ?? '')}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

function basicAuthHeader(username: string | null, secret: string | null): string | null {
  if (!username || !secret) return null;
  return `Basic ${Buffer.from(`${username}:${secret}`).toString('base64')}`;
}

// ---------------------------------------------------------------------------
// S3 SigV4 (path-style, PUT/GET/DELETE/ListObjectsV2)
// ---------------------------------------------------------------------------

function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function signingKey(secret: string, dateStamp: string, region: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  return hmac(kService, 'aws4_request');
}

/** Minimal AWS SigV4 for a single S3 request. Exported for tests. */
export function signS3Request(params: {
  method: string;
  url: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  body?: Uint8Array;
  now?: Date;
}): Record<string, string> {
  const now = params.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const url = new URL(params.url);
  const body = params.body ?? new Uint8Array(0);
  const payloadHash = sha256Hex(body);

  const canonicalHeaders =
    `host:${url.host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

  const canonicalQuery = [...url.searchParams.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`)
    .join('&');
  // `URL.pathname` is already percent-encoded; re-encoding would double-encode.
  const canonicalUri = url.pathname;

  const canonicalRequest = [
    params.method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${params.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signature = createHmac('sha256', signingKey(params.secretAccessKey, dateStamp, params.region))
    .update(stringToSign, 'utf8')
    .digest('hex');

  return {
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    Authorization: `AWS4-HMAC-SHA256 Credential=${params.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function s3Headers(config: RemoteBackupConfig, method: string, url: string, body?: Uint8Array): Record<string, string> {
  if (!config.accessKeyId || !config.secret) {
    throw new RemoteBackupConfigError('S3 目标缺少访问凭据');
  }
  return signS3Request({
    method,
    url,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secret,
    body,
  });
}

// ---------------------------------------------------------------------------
// Target operations
// ---------------------------------------------------------------------------

async function uploadToTarget(config: RemoteBackupConfig, key: string, bytes: Uint8Array, guard: EgressGuard): Promise<void> {
  const url = objectUrl(config, key);
  let headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.targetType === 's3') {
    headers = { ...headers, ...s3Headers(config, 'PUT', url, bytes) };
  } else {
    const auth = basicAuthHeader(config.username, config.secret);
    if (auth) headers.Authorization = auth;
  }
  const response = await callTarget(guard, url, { method: 'PUT', headers, body: bytes });
  if (!response.ok) {
    throw new RemoteBackupTargetError(`上传失败（HTTP ${response.status}）`, response.status);
  }
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export async function listRemoteBackups(
  userId: number,
  options: { guard?: EgressGuard } = {},
): Promise<RemoteBackupObject[]> {
  const config = await getRemoteBackupConfig(userId);
  if (!config) throw new RemoteBackupConfigError('尚未配置备份目标');
  const guard = resolveGuard(options.guard);

  if (config.targetType === 'webdav') {
    const base = normaliseEndpoint(config.endpoint);
    const prefix = config.pathPrefix.replace(/^\/+|\/+$/g, '');
    const url = `${base}/${prefix ? `${prefix.split('/').map(encodeURIComponent).join('/')}/` : ''}`;
    assertTargetAllowed(url, guard);
    const headers: Record<string, string> = { Depth: '1' };
    const auth = basicAuthHeader(config.username, config.secret);
    if (auth) headers.Authorization = auth;
    const response = await callTarget(guard, url, { method: 'PROPFIND', headers });
    if (!response.ok && response.status !== 207) {
      throw new RemoteBackupTargetError(`列取失败（HTTP ${response.status}）`, response.status);
    }
    const text = await response.text();
    const hrefs: string[] = [];
    const re = /<[a-zA-Z0-9:]*href[^>]*>([^<]+)<\/[a-zA-Z0-9:]*href>/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const href = decodeXml(match[1]).trim();
      if (href.toLowerCase().endsWith('.json')) hrefs.push(href);
    }
    // Normalise each href to the object KEY (relative to the configured prefix)
    // so restore/delete can re-address it with the same `objectUrl` builder.
    return hrefs
      .map((href) => {
        const segments = decodeURIComponent(href).split('/').filter(Boolean);
        const filename = segments[segments.length - 1] ?? '';
        return { key: joinKey(prefix, filename), byteSize: null };
      })
      .filter((entry) => entry.key.includes(REMOTE_BACKUP_OBJECT_PREFIX));
  }

  const base = normaliseEndpoint(config.endpoint);
  const prefix = config.pathPrefix.replace(/^\/+|\/+$/g, '');
  const listPrefix = prefix ? `${prefix}/` : REMOTE_BACKUP_OBJECT_PREFIX;
  const url = `${base}/${encodeURIComponent(config.bucket ?? '')}?list-type=2&prefix=${encodeURIComponent(listPrefix)}`;
  assertTargetAllowed(url, guard);
  const response = await callTarget(guard, url, { method: 'GET', headers: s3Headers(config, 'GET', url) });
  if (!response.ok) {
    throw new RemoteBackupTargetError(`列取失败（HTTP ${response.status}）`, response.status);
  }
  const text = await response.text();
  const keys: string[] = [];
  const re = /<Key>([^<]+)<\/Key>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) keys.push(decodeXml(m[1]));
  return keys.map((key) => ({ key, byteSize: null }));
}

async function deleteBackupObject(config: RemoteBackupConfig, key: string, guard: EgressGuard): Promise<void> {
  // WebDAV list returns absolute hrefs (with prefix); S3 returns the raw key.
  const isAbsolute = /^https?:\/\//i.test(key);
  const url = isAbsolute ? key : objectUrl(config, key);
  let headers: Record<string, string> = {};
  if (config.targetType === 's3') {
    headers = s3Headers(config, 'DELETE', url);
  } else {
    const auth = basicAuthHeader(config.username, config.secret);
    if (auth) headers.Authorization = auth;
  }
  const response = await callTarget(guard, url, { method: 'DELETE', headers });
  if (!response.ok && response.status !== 204) {
    throw new RemoteBackupTargetError(`删除失败（HTTP ${response.status}）`, response.status);
  }
}

async function downloadFromTarget(config: RemoteBackupConfig, key: string, guard: EgressGuard): Promise<Uint8Array> {
  const url = objectUrl(config, key);
  let headers: Record<string, string> = {};
  if (config.targetType === 's3') {
    headers = s3Headers(config, 'GET', url);
  } else {
    const auth = basicAuthHeader(config.username, config.secret);
    if (auth) headers.Authorization = auth;
  }
  const response = await callTarget(guard, url, { method: 'GET', headers });
  if (!response.ok) {
    throw new RemoteBackupTargetError(`下载失败（HTTP ${response.status}）`, response.status);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** Prune older objects down to `retention` (0 = disabled). Newest-first by key. */
async function pruneBackups(config: RemoteBackupConfig, guard: EgressGuard, retention: number): Promise<number> {
  if (retention <= 0) return 0;
  const objects = await listRemoteBackups(config.userId, { guard });
  const markers = objects.filter((o) => o.key.includes(REMOTE_BACKUP_OBJECT_PREFIX));
  if (markers.length <= retention) return 0;
  const sorted = [...markers].sort((a, b) => b.key.localeCompare(a.key));
  const stale = sorted.slice(retention);
  let deleted = 0;
  for (const item of stale) {
    try {
      await deleteBackupObject(config, item.key, guard);
      deleted += 1;
    } catch (error) {
      log.warn(
        { event: 'remote_backup.prune_failed', err: error instanceof Error ? error.message : 'unknown' },
        'failed to prune a stale backup object',
      );
    }
  }
  return deleted;
}

// ---------------------------------------------------------------------------
// Run / restore
// ---------------------------------------------------------------------------

function errorCodeFor(error: unknown): string {
  if (
    error instanceof RemoteBackupConfigError ||
    error instanceof RemoteBackupDisabledError ||
    error instanceof RemoteBackupEgressError ||
    error instanceof RemoteBackupTargetError ||
    error instanceof RemoteBackupPayloadError
  ) {
    return error.name;
  }
  return 'BACKUP_FAILED';
}

export async function runRemoteBackup(
  userId: number,
  options: RunRemoteBackupOptions = {},
): Promise<RunRemoteBackupResult> {
  const config = await getRemoteBackupConfig(userId);
  if (!config) throw new RemoteBackupConfigError('尚未配置备份目标');
  if (!config.enabled) throw new RemoteBackupDisabledError();
  if (config.targetType === 's3' && (!config.accessKeyId || !config.secret)) {
    throw new RemoteBackupConfigError('S3 目标缺少访问凭据');
  }
  const guard = resolveGuard(options.guard);
  const key = buildRemoteObjectKey(config, userId);

  try {
    const { json } = await buildBackupPayload(userId);
    const bytes = Buffer.from(json, 'utf8');
    if (bytes.byteLength > REMOTE_BACKUP_MAX_PAYLOAD_BYTES) {
      throw new RemoteBackupPayloadError('备份数据超过单次上限');
    }
    assertTargetAllowed(objectUrl(config, key), guard);

    if (options.dryRun) {
      const recordId = await recordRemoteBackupAttempt(userId, {
        kind: 'backup',
        status: 'dry_run',
        targetType: config.targetType,
        objectKey: key,
        byteSize: bytes.byteLength,
        dryRun: true,
      });
      return { dryRun: true, objectKey: key, byteSize: bytes.byteLength, retentionDeleted: 0, recordId };
    }

    await uploadToTarget(config, key, bytes, guard);
    const retention = options.retentionCount == null ? config.retentionCount : clampRetention(options.retentionCount);
    const retentionDeleted = await pruneBackups(config, guard, retention);

    const recordId = await recordRemoteBackupAttempt(userId, {
      kind: 'backup',
      status: 'success',
      targetType: config.targetType,
      objectKey: key,
      byteSize: bytes.byteLength,
      retentionDeleted,
    });
    return { dryRun: false, objectKey: key, byteSize: bytes.byteLength, retentionDeleted, recordId };
  } catch (error) {
    await recordRemoteBackupAttempt(userId, {
      kind: 'backup',
      status: 'failure',
      targetType: config.targetType,
      objectKey: key,
      dryRun: options.dryRun === true,
      errorCode: errorCodeFor(error),
    });
    throw error;
  }
}

function assertPayloadShape(value: unknown): asserts value is BackupPayload {
  if (!value || typeof value !== 'object') {
    throw new RemoteBackupPayloadError('备份文件格式无效');
  }
  const record = value as Record<string, unknown>;
  for (const field of ['events', 'relationshipMappings', 'eventTemplates']) {
    const list = record[field];
    if (list !== undefined && !Array.isArray(list)) {
      throw new RemoteBackupPayloadError(`${field} 不是数组`);
    }
  }
  if (!Array.isArray(record.events) && !Array.isArray(record.relationshipMappings) && !Array.isArray(record.eventTemplates)) {
    throw new RemoteBackupPayloadError('备份文件缺少可恢复的数据');
  }
}

async function applyPayload(userId: number, payload: BackupPayload): Promise<{ events: number; mappings: number; templates: number }> {
  let events = 0;
  let mappings = 0;
  let templates = 0;

  for (const event of payload.events ?? []) {
    await query(
      `INSERT INTO events (user_id, name, type, date, calendar_type, lunar_date, reminder_config, notification_channels, person_name, birth_date, birth_date_lunar, reminder_recipient_name, reminder_recipient_email)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        userId,
        event.name,
        event.type,
        event.date,
        event.calendar_type || 'gregorian',
        event.lunar_date || null,
        typeof event.reminder_config === 'string' ? event.reminder_config : JSON.stringify(event.reminder_config || {}),
        typeof event.notification_channels === 'string' ? event.notification_channels : JSON.stringify(event.notification_channels || []),
        event.person_name || null,
        event.birth_date || null,
        event.birth_date_lunar || null,
        event.reminder_recipient_name || null,
        event.reminder_recipient_email || null,
      ],
    );
    events += 1;
  }

  for (const mapping of payload.relationshipMappings ?? []) {
    await query(
      `INSERT INTO relationship_mappings (user_id, event_id, from_relation, to_relation, recipient_email, recipient_type)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, mapping.event_id || 0, mapping.from_relation, mapping.to_relation, mapping.recipient_email || null, mapping.recipient_type || null],
    );
    mappings += 1;
  }

  for (const template of payload.eventTemplates ?? []) {
    await query(
      `INSERT INTO event_templates (user_id, event_type, template_content) VALUES ($1, $2, $3) ON CONFLICT (user_id, event_type) DO NOTHING`,
      [userId, template.event_type, template.template_content],
    );
    templates += 1;
  }

  return { events, mappings, templates };
}

export async function restoreRemoteBackup(
  userId: number,
  options: RestoreRemoteBackupOptions,
): Promise<RestoreRemoteBackupResult> {
  const config = await getRemoteBackupConfig(userId);
  if (!config) throw new RemoteBackupConfigError('尚未配置备份目标');
  const key = clean(options.key);
  if (!key) throw new RemoteBackupPayloadError('缺少要恢复的对象 key');
  const guard = resolveGuard(options.guard);
  assertTargetAllowed(objectUrl(config, key), guard);

  try {
    const bytes = await downloadFromTarget(config, key, guard);
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
    } catch {
      throw new RemoteBackupPayloadError('备份文件不是合法 JSON');
    }
    assertPayloadShape(parsed);
    const counts = {
      events: parsed.events?.length ?? 0,
      mappings: parsed.relationshipMappings?.length ?? 0,
      templates: parsed.eventTemplates?.length ?? 0,
    };

    if (options.dryRun) {
      const recordId = await recordRemoteBackupAttempt(userId, {
        kind: 'restore',
        status: 'dry_run',
        targetType: config.targetType,
        objectKey: key,
        byteSize: bytes.byteLength,
        dryRun: true,
        detail: counts,
      });
      return { dryRun: true, ...counts, applied: false, recordId };
    }

    const applied = await applyPayload(userId, parsed);
    const recordId = await recordRemoteBackupAttempt(userId, {
      kind: 'restore',
      status: 'success',
      targetType: config.targetType,
      objectKey: key,
      byteSize: bytes.byteLength,
      detail: applied,
    });
    return { dryRun: false, ...applied, applied: true, recordId };
  } catch (error) {
    await recordRemoteBackupAttempt(userId, {
      kind: 'restore',
      status: 'failure',
      targetType: config.targetType,
      objectKey: key,
      dryRun: options.dryRun === true,
      errorCode: errorCodeFor(error),
    });
    throw error;
  }
}
