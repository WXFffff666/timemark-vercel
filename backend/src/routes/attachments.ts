import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import type { User, AttachmentOwnerType } from '@timemark/shared';
import {
  ATTACHMENT_BASE64_MAX_CHARS,
  ATTACHMENT_CONTENT_TYPES,
  ATTACHMENT_MAX_BYTES,
  attachmentFilenameSchema,
  createAttachmentSchema,
  formatZodError,
} from '@timemark/shared';
import {
  AttachmentContentTypeMismatchError,
  AttachmentEmptyError,
  AttachmentOwnerNotFoundError,
  AttachmentTooLargeError,
  assertContentTypeMatches,
  createAttachment,
  deleteAttachment,
  getAttachment,
  isAttachmentOwnerType,
  listAttachments,
  openAttachmentObject,
  toPublicAttachment,
  type AttachmentRecord,
} from '../services/attachment.service.js';
import { StorageNotConfiguredError } from '../services/storage.service.js';
import {
  ATTACHMENT_SIGNED_URL_TTL_SECONDS,
  AttachmentSigningNotConfiguredError,
  buildAttachmentDownloadPath,
  clampAttachmentSignedTtlSeconds,
  signAttachmentDownload,
  verifyAttachmentDownloadSignature,
} from '../utils/attachment-signing.js';

/**
 * 附件 API（D2，todo 53）。
 *
 * 约定与 /api/expiry、/api/inventory 一致：`new Hono<{Variables:{user:User}}>()` +
 * `use('*', authMiddleware)`，分页返回 `{ success, data, pagination }`。
 *
 * 安全要点：
 * - 每个查询都按 user_id 限定；他人的行与不存在的行都是 404（防存在性泄露）。
 * - 内容类型白名单 5 种，明确拒绝 image/svg+xml（脚本向量）；声明与实际字节不符时
 *   **拒绝**（fail closed，不静默改写），见 attachment.service.assertContentTypeMatches。
 * - 2 MB 上限在调用对象存储之前强制（含 Content-Length 预检）；零字节拒绝。
 * - 上传 key 由服务端生成，用户文件名永不参与 key（文件名仅作标签）。
 * - 下载始终以 `Content-Disposition: attachment` + `nosniff` 下发，绝不内联渲染。
 * - 短时签名链接（todo 57）：`GET /:id/signed-url` 先做归属校验再签发 ≤300 秒的 API 链接；
 *   消费链接（`GET /:id/download`）仍要求会话并再次做归属校验 —— 有效签名 + 他人会话 = 404。
 *   签名与 URL 绝不写日志（logger redact 兜底）。不存在公开列表端点。
 * - 生产环境缺 BLOB_READ_WRITE_TOKEN 时存储操作抛错 → 503，不会写本地磁盘。
 * - 签名 URL / storage key 不写日志、不出现在响应中。
 */
const attachments = new Hono<{ Variables: { user: User } }>();
attachments.use('*', authMiddleware);

/** multipart 信封（boundary/字段）的余量，用于 Content-Length 早期拒绝。 */
const MULTIPART_BODY_SLACK_BYTES = 64 * 1024;
/** JSON（base64）信封余量：字段名 + 大括号 + 少量引号。 */
const JSON_BODY_SLACK_BYTES = 4096;
const STORAGE_UNAVAILABLE_MESSAGE = '附件存储未配置：请设置 BLOB_READ_WRITE_TOKEN';

function parsePage(raw: string | undefined): number {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

function parseLimit(raw: string | undefined): number {
  const n = parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n < 1) return 50;
  return Math.min(n, 200);
}

function parseId(raw: string): number | null {
  const id = parseInt(raw, 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function parseDeclaredLength(raw: string | undefined): number | null {
  const n = Number(raw ?? '');
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Strict base64: only padded, canonical base64; Node's lenient decoder is not trusted. */
function decodeBase64Strict(value: string): Uint8Array | null {
  const normalized = value.replace(/\s+/g, '');
  if (normalized.length === 0 || normalized.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return null;
  const buffer = Buffer.from(normalized, 'base64');
  if (buffer.toString('base64') !== normalized) return null;
  return new Uint8Array(buffer);
}

/** ASCII-safe fallback for the `filename=` parameter; quotes, backslashes and angle brackets become `_`. */
function asciiFallbackFilename(filename: string): string {
  let out = '';
  for (const ch of filename) {
    const code = ch.codePointAt(0) ?? 0;
    const printable = code >= 0x20 && code <= 0x7e;
    out += printable && ch !== '"' && ch !== '\\' && ch !== '<' && ch !== '>' ? ch : '_';
  }
  return out || 'attachment';
}

/** RFC 5987 filename* encoding (`attr-char` excludes !'()*); never throws for odd input. */
function encodeFilenameStar(filename: string): string | null {
  try {
    return [...encodeURIComponent(filename)]
      .map((ch) => ("!'()*".includes(ch) ? `%${ch.charCodeAt(0).toString(16).toUpperCase()}` : ch))
      .join('');
  } catch {
    return null;
  }
}

/**
 * Always `attachment` (never `inline`), with a sanitized ASCII fallback plus an RFC 5987
 * `filename*` for CJK names. CR/LF cannot survive: the schema rejects control characters
 * and the fallback replaces anything outside 0x20-0x7e.
 */
function contentDispositionFor(filename: string): string {
  const star = encodeFilenameStar(filename);
  const base = `attachment; filename="${asciiFallbackFilename(filename)}"`;
  return star ? `${base}; filename*=UTF-8''${star}` : base;
}

function isStorageUnavailable(error: unknown): boolean {
  return error instanceof StorageNotConfiguredError;
}

/** Storage object -> HTTP response; owner check has already happened. Never inline. */
async function streamAttachment(c: Context, record: AttachmentRecord): Promise<Response> {
  let object;
  try {
    object = await openAttachmentObject(record);
  } catch (error) {
    if (isStorageUnavailable(error)) {
      return c.json({ success: false, error: STORAGE_UNAVAILABLE_MESSAGE }, 503);
    }
    throw error;
  }
  if (!object) return c.json({ success: false, error: '附件文件缺失' }, 404);

  return c.body(object.stream, 200, {
    'Content-Type': record.content_type,
    'Content-Length': String(object.size),
    'Content-Disposition': contentDispositionFor(record.filename),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
  });
}

function validateFilename(raw: unknown): { ok: true; filename: string } | { ok: false; message: string } {
  const parsed = attachmentFilenameSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? '文件名无效' };
  return { ok: true, filename: parsed.data };
}

attachments.get('/', async (c) => {
  const userId = Number(c.get('user').id);

  const ownerTypeRaw = c.req.query('owner_type');
  let ownerType: AttachmentOwnerType | undefined;
  if (ownerTypeRaw !== undefined && ownerTypeRaw !== '') {
    if (!isAttachmentOwnerType(ownerTypeRaw)) {
      return c.json({ success: false, error: `未知的归属类型: ${ownerTypeRaw}` }, 400);
    }
    ownerType = ownerTypeRaw;
  }

  const ownerIdRaw = c.req.query('owner_id');
  let ownerId: number | undefined;
  if (ownerIdRaw !== undefined && ownerIdRaw !== '') {
    const parsed = parseInt(ownerIdRaw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return c.json({ success: false, error: 'owner_id 必须为正整数' }, 400);
    }
    if (!ownerType) {
      return c.json({ success: false, error: '使用 owner_id 时必须同时提供 owner_type' }, 400);
    }
    ownerId = parsed;
  }

  const page = parsePage(c.req.query('page'));
  const limit = parseLimit(c.req.query('limit'));

  const { items, total } = await listAttachments(userId, { ownerType, ownerId }, page, limit);
  return c.json({
    success: true,
    data: items.map(toPublicAttachment),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
});

attachments.post('/', async (c) => {
  const userId = Number(c.get('user').id);
  const requestContentType = c.req.header('content-type') ?? '';

  let ownerTypeRaw: unknown;
  let ownerIdRaw: unknown;
  let filenameRaw: unknown;
  let declaredType: string;
  let bytes: Uint8Array;

  if (requestContentType.includes('multipart/form-data')) {
    const declaredLength = parseDeclaredLength(c.req.header('content-length'));
    if (declaredLength !== null && declaredLength > ATTACHMENT_MAX_BYTES + MULTIPART_BODY_SLACK_BYTES) {
      return c.json({ success: false, error: '文件超过 2 MB 上限' }, 413);
    }

    const form = await c.req.parseBody();
    const file = form['file'];
    if (!(file instanceof File)) {
      return c.json({ success: false, error: 'multipart 请求必须包含 file 字段' }, 400);
    }
    ownerTypeRaw = form['ownerType'];
    ownerIdRaw = form['ownerId'];
    const filenameField = form['filename'];
    filenameRaw =
      typeof filenameField === 'string' && filenameField.trim() ? filenameField : file.name;
    const contentTypeField = form['contentType'];
    declaredType =
      typeof contentTypeField === 'string' && contentTypeField.trim() ? contentTypeField : file.type;
    bytes = new Uint8Array(await file.arrayBuffer());
  } else {
    const declaredLength = parseDeclaredLength(c.req.header('content-length'));
    if (declaredLength !== null && declaredLength > ATTACHMENT_BASE64_MAX_CHARS + JSON_BODY_SLACK_BYTES) {
      return c.json({ success: false, error: '文件超过 2 MB 上限' }, 413);
    }

    const body = await c.req.json().catch(() => ({}));
    const parsed = createAttachmentSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: formatZodError(parsed.error),
          details: z.flattenError(parsed.error),
        },
        400,
      );
    }
    ownerTypeRaw = parsed.data.ownerType;
    ownerIdRaw = parsed.data.ownerId;
    filenameRaw = parsed.data.filename;
    declaredType = parsed.data.contentType;
    const decoded = decodeBase64Strict(parsed.data.dataBase64);
    if (!decoded) {
      return c.json({ success: false, error: '文件内容不是合法的 base64' }, 400);
    }
    bytes = decoded;
  }

  if (!isAttachmentOwnerType(ownerTypeRaw)) {
    return c.json({ success: false, error: `未知的归属类型: ${String(ownerTypeRaw)}` }, 400);
  }
  const ownerId = Number(ownerIdRaw);
  if (!Number.isInteger(ownerId) || ownerId <= 0) {
    return c.json({ success: false, error: 'owner_id 必须为正整数' }, 400);
  }
  const filename = validateFilename(filenameRaw);
  if (!filename.ok) {
    return c.json({ success: false, error: filename.message }, 400);
  }
  if (!(ATTACHMENT_CONTENT_TYPES as readonly string[]).includes(declaredType)) {
    return c.json(
      { success: false, error: `不支持的内容类型: ${declaredType || '(空)'}（image/svg+xml 等脚本向量被拒绝）` },
      400,
    );
  }

  // Cap / emptiness / sniffing all happen BEFORE any storage or DB call.
  if (bytes.byteLength === 0) {
    return c.json({ success: false, error: '不能上传空文件' }, 400);
  }
  if (bytes.byteLength > ATTACHMENT_MAX_BYTES) {
    return c.json({ success: false, error: '文件超过 2 MB 上限' }, 413);
  }
  try {
    assertContentTypeMatches(bytes, declaredType);
  } catch (error) {
    if (error instanceof AttachmentContentTypeMismatchError) {
      return c.json({ success: false, error: error.message }, 400);
    }
    throw error;
  }

  try {
    const record = await createAttachment(userId, {
      ownerType: ownerTypeRaw,
      ownerId,
      filename: filename.filename,
      contentType: declaredType,
      bytes,
    });
    return c.json({ success: true, data: toPublicAttachment(record) }, 201);
  } catch (error) {
    if (isStorageUnavailable(error)) {
      return c.json({ success: false, error: STORAGE_UNAVAILABLE_MESSAGE }, 503);
    }
    if (error instanceof AttachmentOwnerNotFoundError) {
      return c.json({ success: false, error: '附件归属对象不存在' }, 404);
    }
    if (error instanceof AttachmentTooLargeError) {
      return c.json({ success: false, error: error.message }, 413);
    }
    if (error instanceof AttachmentEmptyError) {
      return c.json({ success: false, error: error.message }, 400);
    }
    throw error;
  }
});

/** Download: authenticated owner check on every fetch; never inline. */
attachments.get('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const record = await getAttachment(userId, id);
  // 404 for "does not exist" and "belongs to another user" alike.
  if (!record) return c.json({ success: false, error: '附件不存在' }, 404);

  return streamAttachment(c, record);
});

/**
 * 签发一个短时下载链接（todo 57）。签发前先做 owner 校验；TTL 硬上限 300 秒；
 * 返回的是 API 相对路径（绝不返回对象存储的签名 URL），消费时仍要带会话并再次做
 * owner 查询 —— 因此「有效签名 + 他人会话」仍然是 404。签名值绝不写日志。
 */
attachments.get('/:id/signed-url', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const record = await getAttachment(userId, id);
  if (!record) return c.json({ success: false, error: '附件不存在' }, 404);

  const requested = Number(c.req.query('ttl'));
  const ttlSeconds = clampAttachmentSignedTtlSeconds(Number.isFinite(requested) ? requested : ATTACHMENT_SIGNED_URL_TTL_SECONDS);
  const expiresAtMs = Date.now() + ttlSeconds * 1000;

  let signature: string;
  try {
    signature = signAttachmentDownload(id, expiresAtMs);
  } catch (error) {
    if (error instanceof AttachmentSigningNotConfiguredError) {
      return c.json({ success: false, error: error.message }, 503);
    }
    throw error;
  }

  return c.json({
    success: true,
    data: {
      url: buildAttachmentDownloadPath(id, expiresAtMs, signature),
      expiresAt: new Date(expiresAtMs).toISOString(),
      ttlSeconds,
    },
  });
});

/**
 * 消费签名链接：签名（含过期）→ 会话归属，缺一不可。
 * 签名无效/过期 → 403；签名有效但不是自己的附件 → 404（与普通下载一致，不泄露存在性）。
 */
attachments.get('/:id/download', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const expiresRaw = c.req.query('expires');
  const signature = c.req.query('signature');
  const expiresAtMs = Number(expiresRaw);
  if (expiresRaw === undefined || !Number.isFinite(expiresAtMs) || !signature) {
    return c.json({ success: false, error: '缺少或无效的下载签名参数' }, 400);
  }

  const verdict = verifyAttachmentDownloadSignature(id, expiresAtMs, signature);
  if (verdict.status === 'not_configured') {
    return c.json({ success: false, error: '附件下载签名未配置' }, 503);
  }
  if (verdict.status === 'expired') {
    return c.json({ success: false, error: '下载签名已过期' }, 403);
  }
  if (verdict.status === 'invalid') {
    return c.json({ success: false, error: '下载签名无效' }, 403);
  }

  // Owner check ALWAYS runs, signed or not. Never log the signature or the URL.
  const record = await getAttachment(userId, id);
  if (!record) return c.json({ success: false, error: '附件不存在' }, 404);

  return streamAttachment(c, record);
});

attachments.delete('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  try {
    const deleted = await deleteAttachment(userId, id);
    if (!deleted) return c.json({ success: false, error: '附件不存在' }, 404);
    return c.json({ success: true });
  } catch (error) {
    if (isStorageUnavailable(error)) {
      return c.json({ success: false, error: STORAGE_UNAVAILABLE_MESSAGE }, 503);
    }
    throw error;
  }
});

export default attachments;
