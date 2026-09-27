import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import type { User } from '@timemark/shared';
import {
  DOCUMENT_KINDS,
  createDocumentSchema,
  formatZodError,
  linkAttachmentSchema,
  updateDocumentSchema,
} from '@timemark/shared';
import {
  createDocument,
  deleteDocument,
  getDocument,
  linkDocumentAttachment,
  listDocuments,
  listExpiringDocuments,
  revealDocumentNumber,
  toPublicDocument,
  unlinkDocumentAttachment,
  updateDocument,
  type DocumentFilters,
} from '../services/document.service.js';
import { toPublicAttachment } from '../services/attachment.service.js';

/**
 * 证件保险箱 API（D2，todo 54）。
 *
 * 约定与 /api/expiry、/api/inventory 一致：`new Hono<{Variables:{user:User}}>()` +
 * `use('*', authMiddleware)`，分页返回 `{ success, data, pagination }`；
 * 「不存在」与「他人的行」都是 404（防存在性泄露）。
 *
 * 证件号码：加密存储；列表/详情只返回 `numberConfigured` 布尔标志；
 * 明文仅 `GET /:id/number` 一次性返回（绝不回显密文）。
 * 解密失败（如 MASTER_KEY 已更换）返回 422 且不回显任何密文/明文；
 * 列表端点从不解密，因此密钥错误也不会让它崩溃。
 * 证件图片只存于附件存储；`POST /:id/attachments` / `DELETE /:id/attachments/:attachmentId`
 * 负责关联/解除关联（两端都做 user_id 归属校验）。
 */
const documents = new Hono<{ Variables: { user: User } }>();
documents.use('*', authMiddleware);

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

documents.get('/', async (c) => {
  const userId = Number(c.get('user').id);

  const kindRaw = c.req.query('kind');
  if (kindRaw && !(DOCUMENT_KINDS as readonly string[]).includes(kindRaw)) {
    return c.json({ success: false, error: `未知的证件类型: ${kindRaw}` }, 400);
  }
  const activeRaw = c.req.query('active');
  let active: boolean | undefined;
  if (activeRaw === 'true') active = true;
  else if (activeRaw === 'false') active = false;
  else if (activeRaw !== undefined && activeRaw !== '') {
    return c.json({ success: false, error: "active 只能为 'true' 或 'false'" }, 400);
  }

  const filters: DocumentFilters = {
    kind: kindRaw,
    active,
    q: c.req.query('q') || undefined,
  };
  const page = parsePage(c.req.query('page'));
  const limit = parseLimit(c.req.query('limit'));

  const { items, total } = await listDocuments(userId, filters, page, limit);
  return c.json({
    success: true,
    data: items.map(toPublicDocument),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
});

documents.get('/expiring', async (c) => {
  const userId = Number(c.get('user').id);
  const raw = parseInt(c.req.query('days') ?? '', 10);
  const days = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 3650) : 90;
  const items = await listExpiringDocuments(userId, days);
  return c.json({ success: true, data: items.map(toPublicDocument), days });
});

documents.post('/', async (c) => {
  const userId = Number(c.get('user').id);
  const body = await c.req.json().catch(() => ({}));
  const parsed = createDocumentSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      success: false,
      error: formatZodError(parsed.error),
      details: z.flattenError(parsed.error),
    }, 400);
  }
  const document = await createDocument(userId, parsed.data);
  return c.json({ success: true, data: toPublicDocument(document) }, 201);
});

documents.get('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const document = await getDocument(userId, id);
  if (!document) return c.json({ success: false, error: '证件不存在' }, 404);
  return c.json({ success: true, data: toPublicDocument(document) });
});

/** One-shot reveal. Never returns the ciphertext; undecryptable values fail closed. */
documents.get('/:id/number', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const result = await revealDocumentNumber(userId, id);
  if (result.status === 'not_found') {
    return c.json({ success: false, error: '证件不存在' }, 404);
  }
  if (result.status === 'not_configured') {
    return c.json({ success: false, error: '该证件未配置号码' }, 404);
  }
  if (result.status === 'undecryptable') {
    // Fail closed: no ciphertext, no plaintext, no crash.
    return c.json({ success: false, error: '证件号码无法解密（MASTER_KEY 可能已更换，请重新录入）' }, 422);
  }
  return c.json({ success: true, data: { number: result.number } });
});

documents.patch('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const body = await c.req.json().catch(() => ({}));
  const parsed = updateDocumentSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      success: false,
      error: formatZodError(parsed.error),
      details: z.flattenError(parsed.error),
    }, 400);
  }

  const document = await updateDocument(userId, id, parsed.data);
  if (!document) return c.json({ success: false, error: '证件不存在' }, 404);
  return c.json({ success: true, data: toPublicDocument(document) });
});

documents.delete('/:id', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const deleted = await deleteDocument(userId, id);
  if (!deleted) return c.json({ success: false, error: '证件不存在' }, 404);
  return c.json({ success: true });
});

documents.post('/:id/attachments', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的 ID' }, 400);

  const body = await c.req.json().catch(() => ({}));
  const parsed = linkAttachmentSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      success: false,
      error: formatZodError(parsed.error),
      details: z.flattenError(parsed.error),
    }, 400);
  }

  const result = await linkDocumentAttachment(userId, id, parsed.data.attachmentId);
  if (result.status === 'document_not_found') {
    return c.json({ success: false, error: '证件不存在' }, 404);
  }
  if (result.status === 'attachment_not_found') {
    return c.json({ success: false, error: '附件不存在' }, 404);
  }
  return c.json({ success: true, data: toPublicAttachment(result.attachment) });
});

documents.delete('/:id/attachments/:attachmentId', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseId(c.req.param('id'));
  const attachmentId = parseId(c.req.param('attachmentId'));
  if (id === null || attachmentId === null) {
    return c.json({ success: false, error: '无效的 ID' }, 400);
  }

  const result = await unlinkDocumentAttachment(userId, id, attachmentId);
  if (result.status === 'not_found') {
    return c.json({ success: false, error: '附件不存在或未关联该证件' }, 404);
  }
  return c.json({ success: true, data: toPublicAttachment(result.attachment) });
});

export default documents;
