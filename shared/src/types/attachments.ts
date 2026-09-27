/**
 * 附件（D2 证件与文档到期保险箱）— 内容类型白名单、大小上限与所有者类型
 *
 * 附件字节永不写入 Postgres（Neon Free 仅 0.5 GB/项目）；行只保存元数据 +
 * 对象存储 key（见 backend/src/services/storage.service.ts）。
 *
 * 白名单刻意排除 `image/svg+xml`（可携带脚本，是存储型 XSS 向量）。
 * `text/plain` 只以 `Content-Disposition: attachment` + `nosniff` 下发。
 */
import { z } from 'zod';

/** 允许上传的内容类型（服务端与前端共用；前端 56 用它做上传前拦截） */
export const ATTACHMENT_CONTENT_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/plain',
] as const;
export type AttachmentContentType = (typeof ATTACHMENT_CONTENT_TYPES)[number];
export const attachmentContentTypeSchema = z.enum(ATTACHMENT_CONTENT_TYPES);

/** 单文件大小上限：2 MB（客户端 + 服务端都强制执行，服务端在落存储前拒绝） */
export const ATTACHMENT_MAX_BYTES = 2 * 1024 * 1024;

/** base64 载荷的字符上限（4/3 膨胀 + 少量换行余量），用于 JSON 分支的早期拒绝 */
export const ATTACHMENT_BASE64_MAX_CHARS = Math.ceil(ATTACHMENT_MAX_BYTES / 3) * 4 + 16;

/** 附件可归属的实体类型（多态 owner；owner_id 指向对应表的主键） */
export const ATTACHMENT_OWNER_TYPES = [
  'document',
  'expiry',
  'inventory',
  'maintenance',
  'event',
] as const;
export type AttachmentOwnerType = (typeof ATTACHMENT_OWNER_TYPES)[number];
export const attachmentOwnerTypeSchema = z.enum(ATTACHMENT_OWNER_TYPES);

/** 拒绝控制字符（CR/LF/NUL 会破坏响应头），但不使用 control-char 正则（eslint no-control-regex） */
function hasControlCharacters(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** 文件名标签：拒绝控制字符（CR/LF/NUL 会破坏响应头），长度上限 255 */
export const attachmentFilenameSchema = z
  .string()
  .min(1, '文件名不能为空')
  .max(255, '文件名过长')
  .refine((v) => !hasControlCharacters(v), '文件名不能包含控制字符');

/** POST /api/attachments 的 JSON（base64）分支 */
export const createAttachmentSchema = z.object({
  ownerType: attachmentOwnerTypeSchema,
  ownerId: z.number().int().positive('owner_id 必须为正整数'),
  filename: attachmentFilenameSchema,
  contentType: attachmentContentTypeSchema,
  /** 原始文件内容的 base64；服务端解码后按实际字节数强制 2 MB 上限 */
  dataBase64: z.string().min(1, '文件内容不能为空').max(ATTACHMENT_BASE64_MAX_CHARS, '文件超过 2 MB 上限'),
});
export type CreateAttachmentInput = z.infer<typeof createAttachmentSchema>;
