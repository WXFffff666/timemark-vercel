/**
 * 证件与文档（D2 证件保险箱）— Zod 校验与类型
 *
 * 领域：护照 (passport)、身份证 (id_card)、驾照 (driver_license)、签证 (visa)、
 * 证明 (certificate)、保单 (policy)、合同 (contract)、其它 (other)。
 *
 * `documentNumber` 永不落库明文：服务端用 `@timemark/shared/crypto` 的 AES-256-GCM
 * 加密为 `document_number_encrypted`（与通知凭证同一套 MASTER_KEY 约定）。
 * 列表响应只返回 `numberConfigured` 布尔标志（镜像 channels 的 tokenConfigured 模式），
 * 明文仅在一次性 reveal 端点返回。
 *
 * 证件图片一律走附件存储（attachments），本领域不保存任何字节。
 */
import { z } from 'zod';
import { expiryReminderConfigSchema } from './expiry.js';

/** 证件/文档类型 */
export const DOCUMENT_KINDS = [
  'passport',
  'id_card',
  'driver_license',
  'visa',
  'certificate',
  'policy',
  'contract',
  'other',
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
export const documentKindSchema = z.enum(DOCUMENT_KINDS);

/** 提醒配置与到期中心同构（共用提醒引擎与 JSONB 约定） */
export const documentReminderConfigSchema = expiryReminderConfigSchema;
export type DocumentReminderConfig = z.infer<typeof documentReminderConfigSchema>;

const ymdDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式必须为 YYYY-MM-DD');

/** 拒绝控制字符（明文号码里的 CR/LF/NUL），不使用 control-char 正则（eslint no-control-regex） */
function hasControlCharacters(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

const documentFieldsSchema = z.object({
  kind: documentKindSchema,
  title: z.string().min(1, '名称不能为空').max(200),
  issuer: z.string().max(200).nullish(),
  /** 证件号码明文传输、加密落库；null = 清除；缺省 = 不变。响应永不回显 */
  documentNumber: z
    .string()
    .max(200, '证件号码过长')
    .refine((v) => v.length === 0 || !hasControlCharacters(v), '证件号码不能包含控制字符')
    .nullish(),
  issuedAt: ymdDateSchema.nullish(),
  expiresAt: ymdDateSchema.nullish(),
  country: z.string().max(100).nullish(),
  notes: z.string().max(2000).nullish(),
  reminderConfig: documentReminderConfigSchema.nullish(),
  isActive: z.boolean().optional(),
  /** 预留：D5 家庭档案 */
  profileId: z.number().int().positive().nullish(),
});

function expiresNotBeforeIssued(data: {
  issuedAt?: string | null;
  expiresAt?: string | null;
}): boolean {
  if (!data.issuedAt || !data.expiresAt) return true;
  return data.expiresAt >= data.issuedAt;
}

const EXPIRES_BEFORE_ISSUED_MESSAGE = 'expires_at 不能早于 issued_at';

export const createDocumentSchema = documentFieldsSchema.refine(expiresNotBeforeIssued, {
  message: EXPIRES_BEFORE_ISSUED_MESSAGE,
  path: ['expiresAt'],
});

/** PATCH：全字段可选；跨字段 refine 只在两个字段都出现时生效（与到期中心一致） */
export const updateDocumentSchema = documentFieldsSchema
  .partial()
  .refine(expiresNotBeforeIssued, {
    message: EXPIRES_BEFORE_ISSUED_MESSAGE,
    path: ['expiresAt'],
  });

/** POST /api/documents/:id/attachments — 关联一个已存在的附件 */
export const linkAttachmentSchema = z.object({
  attachmentId: z.number().int().positive('附件 ID 必须为正整数'),
});

export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;
export type UpdateDocumentInput = z.infer<typeof updateDocumentSchema>;
export type LinkAttachmentInput = z.infer<typeof linkAttachmentSchema>;
