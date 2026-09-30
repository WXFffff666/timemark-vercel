/**
 * OCR routes (task 146) - default-exported Hono router, session-authenticated.
 *
 *   GET  /api/ocr            -> engine status (disabled by default)
 *   GET  /api/ocr/results    -> stored extraction rows for a document
 *   POST /api/ocr            -> extract text + structured fields from an upload
 *
 * Input is validated (type whitelist + 2 MB cap) BEFORE anything else, and
 * oversized / unsupported inputs are rejected even while OCR is disabled. When
 * no engine is configured the endpoint answers a clear 503 `ocr_disabled`.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import type { User } from '@timemark/shared';
import { formatZodError } from '@timemark/shared';
import {
  OCR_MAX_BYTES,
  OCR_SUPPORTED_TYPES,
  OcrDisabledError,
  OcrFailedError,
  OcrTooLargeError,
  OcrUnsupportedTypeError,
  attachmentBelongsToUser,
  createOcrService,
  documentBelongsToUser,
  getOcrEngine,
  listOcrResults,
  storeOcrResult,
} from '../services/agent/ocr.service.js';

const ocr = new Hono<{ Variables: { user: User } }>();
ocr.use('*', authMiddleware);

/** base64 character cap (4/3 expansion + slack), rejected before decoding. */
const OCR_BASE64_MAX_CHARS = Math.ceil(OCR_MAX_BYTES / 3) * 4 + 16;

const contentTypeSchema = z.enum(OCR_SUPPORTED_TYPES);

const extractSchema = z
  .object({
    documentId: z.number().int().positive().optional(),
    attachmentId: z.number().int().positive().optional(),
    contentType: contentTypeSchema,
    dataBase64: z.string().min(1, '文件内容不能为空').max(OCR_BASE64_MAX_CHARS, '文件超过 2 MB 上限'),
  })
  .strict();

function parseId(raw: string): number | null {
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Engine status - the clear "off by default" state.
ocr.get('/', async (c) => {
  const engine = await getOcrEngine();
  return c.json({
    success: true,
    data: {
      enabled: engine !== null,
      engine: engine?.name ?? null,
      local: engine?.local ?? true,
      supportedTypes: [...OCR_SUPPORTED_TYPES],
      maxBytes: OCR_MAX_BYTES,
    },
  });
});

ocr.get('/results', async (c) => {
  const userId = Number(c.get('user').id);
  const documentIdRaw = c.req.query('documentId');
  const limitRaw = c.req.query('limit');
  const documentId = documentIdRaw ? parseId(documentIdRaw) : undefined;
  if (documentIdRaw !== undefined && documentId === null) {
    return c.json({ success: false, error: '无效的 documentId' }, 400);
  }
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
  const data = await listOcrResults(userId, {
    ...(documentId ? { documentId } : {}),
    ...(Number.isInteger(limit) ? { limit: limit as number } : {}),
  });
  return c.json({ success: true, data });
});

ocr.post('/', async (c) => {
  const userId = Number(c.get('user').id);
  const body = await c.req.json().catch(() => null);
  const parsed = extractSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: formatZodError(parsed.error), details: z.flattenError(parsed.error) }, 400);
  }
  const input = parsed.data;

  const bytes = Buffer.from(input.dataBase64, 'base64');
  if (bytes.byteLength > OCR_MAX_BYTES) {
    return c.json({ success: false, error: '文件超过 2 MB 上限' }, 413);
  }

  // Ownership checks happen before any engine work (no existence leak).
  if (input.documentId !== undefined && !(await documentBelongsToUser(userId, input.documentId))) {
    return c.json({ success: false, error: '证件不存在' }, 404);
  }
  if (input.attachmentId !== undefined && !(await attachmentBelongsToUser(userId, input.attachmentId))) {
    return c.json({ success: false, error: '附件不存在' }, 404);
  }

  const engine = await getOcrEngine();
  const service = createOcrService({ engine });

  if (!service.enabled) {
    return c.json(
      {
        success: false,
        error: 'OCR 未启用：未配置本地识别引擎',
        code: 'ocr_disabled',
        data: { enabled: false, engine: null },
      },
      503,
    );
  }

  try {
    const result = await service.recognize({ bytes, contentType: input.contentType });
    const stored = await storeOcrResult(userId, {
      documentId: input.documentId ?? null,
      attachmentId: input.attachmentId ?? null,
      result,
    });
    return c.json({
      success: true,
      data: {
        id: stored.id,
        engine: result.engine,
        text: result.text,
        fields: result.fields,
        byteSize: result.byteSize,
      },
    });
  } catch (error) {
    if (error instanceof OcrTooLargeError) {
      return c.json({ success: false, error: '文件超过 2 MB 上限' }, 413);
    }
    if (error instanceof OcrUnsupportedTypeError) {
      return c.json({ success: false, error: `不支持的文件类型: ${error.contentType}` }, 415);
    }
    if (error instanceof OcrDisabledError) {
      return c.json({ success: false, error: 'OCR 未启用', code: 'ocr_disabled' }, 503);
    }
    if (error instanceof OcrFailedError) {
      return c.json({ success: false, error: 'OCR 识别失败', code: 'ocr_failed' }, 422);
    }
    throw error;
  }
});

export default ocr;
