/**
 * 证件保险箱（D2，todo 56）前端纯函数工具。
 *
 * 只依赖 Wire 形状（蛇形命名，与 `backend/src/services/document.service.ts` 的
 * `PublicDocument` / `attachment.service.ts` 的 `PublicAttachment` 对齐）与共享包里的
 * 附件白名单常量；不含 React、不发请求，因此可以直接单测
 * 「重命名的 .exe → 客户端嗅探拦截（零网络）」「无到期日 → 占位符而非 NaN」等失败场景。
 */

import {
  ATTACHMENT_CONTENT_TYPES,
  ATTACHMENT_MAX_BYTES,
  type AttachmentContentType,
} from '@timemark/shared';
import {
  formatExpiryCountdown,
  parseLocalYmd,
  type ExpiryCountdownText,
} from '@/lib/expiry-utils';
import { calculateCountdown } from '@/lib/countdown';

/** 列表/详情响应形状；明文号码永不在此出现，只有 `numberConfigured` 标志。 */
export interface DocumentItem {
  id: number;
  user_id: number;
  profile_id: number | null;
  kind: string;
  title: string;
  issuer: string | null;
  issued_at: string | null;
  expires_at: string | null;
  country: string | null;
  notes: string | null;
  reminder_config: Record<string, unknown> | null;
  is_active: boolean;
  created_at: string | null;
  updated_at: string | null;
  /** true = 已加密保存了证件号码；明文只在一次性 reveal 端点上返回。 */
  numberConfigured: boolean;
}

/** `GET /api/attachments` 的公开 DTO；`storage_key` 永不出现。 */
export interface DocumentAttachment {
  id: number;
  owner_type: string | null;
  owner_id: number | null;
  filename: string;
  content_type: string;
  byte_size: number;
  sha256: string;
  created_at: string | null;
  download_url: string;
}

export const DOCUMENT_KIND_LABELS: Record<string, string> = {
  passport: '护照',
  id_card: '身份证',
  driver_license: '驾照',
  visa: '签证',
  certificate: '证明',
  policy: '保单',
  contract: '合同',
  other: '其它',
};

/** 未知 kind（API 返回脏数据）→ 回退为原字符串，绝不崩溃。 */
export function documentKindLabel(kind: string | null | undefined): string {
  if (!kind) return '未知';
  return DOCUMENT_KIND_LABELS[kind] ?? kind;
}

/**
 * 号码掩码。列表只拿得到 `numberConfigured` 布尔值，因此掩码是固定的点块，
 * 不含任何派生自真实号码的字符（不可能通过掩码反推号码）。
 */
export const DOCUMENT_NUMBER_MASK = '•••• •••• ••••';

/** 掩码展示：未配置号码显示占位符 `—`，配置了则显示固定掩码。 */
export function maskedDocumentNumber(configured: boolean): string {
  return configured ? DOCUMENT_NUMBER_MASK : '—';
}

export interface DocumentCountdown {
  kind: ExpiryCountdownText['kind'] | 'none';
  /** 纯文本，便于断言（例如「还有 6 天」「无到期日」）。 */
  text: string;
}

/**
 * 到期倒计时。无/非法 `expires_at` → `{ kind: 'none', text: '无到期日' }`，
 * 绝不产出 NaN（对齐库存页的失败场景约定）。
 */
export function documentCountdown(
  expiresAt: string | null | undefined,
  ref: Date,
): DocumentCountdown {
  const target = parseLocalYmd(expiresAt);
  if (!target) return { kind: 'none', text: '无到期日' };
  const parts = calculateCountdown(target, ref);
  return formatExpiryCountdown(parts);
}

/** 人类可读字节数；非有限输入返回占位符。 */
export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** 白名单校验（镜像服务端 `ATTACHMENT_CONTENT_TYPES`）。 */
export function isAllowedAttachmentType(contentType: string | null | undefined): boolean {
  return (
    typeof contentType === 'string' &&
    (ATTACHMENT_CONTENT_TYPES as readonly string[]).includes(contentType)
  );
}

/**
 * 魔数嗅探（与 `backend/src/services/attachment.service.ts` 的 `sniffContentType` 完全一致）。
 * 返回 null = 无法识别的字节（例如把 .exe 重命名为 .pdf）。
 */
export function sniffContentType(bytes: Uint8Array): AttachmentContentType | null {
  const startsWith = (signature: number[], offset = 0): boolean =>
    bytes.length >= offset + signature.length &&
    signature.every((b, i) => bytes[offset + i] === b);
  const asciiAt = (offset: number, text: string): boolean =>
    bytes.length >= offset + text.length &&
    [...text].every((ch, i) => bytes[offset + i] === ch.charCodeAt(0));

  if (startsWith([0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf'; // %PDF-
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (asciiAt(0, 'RIFF') && asciiAt(8, 'WEBP')) return 'image/webp';
  if (isProbablyText(bytes)) return 'text/plain';
  return null;
}

/** UTF-8 可解码且不含 NUL；二进制载荷（exe/zip 等）会在此失败。 */
function isProbablyText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export interface LocalFileLike {
  name: string;
  type: string;
  size: number;
}

/**
 * 客户端上传前校验（在发出任何网络请求之前）。返回错误文案，或 null 表示放行。
 *
 * 与服务端策略一致（fail closed）：大小上限、白名单、以及「声明的类型必须与魔数一致」；
 * 因此把 `.exe` 重命名为 `.pdf`（浏览器仍给出 `application/pdf`）会被魔数嗅探拦下。
 */
export function validateAttachment(file: LocalFileLike, headBytes: Uint8Array): string | null {
  if (file.size === 0) return '不能上传空文件';
  if (file.size > ATTACHMENT_MAX_BYTES) return '文件超过 2 MB 上限';
  if (!isAllowedAttachmentType(file.type)) {
    return `不支持的内容类型：${file.type || '(空)'}（仅支持 PDF / PNG / JPEG / WebP / TXT）`;
  }
  const declared = file.type as AttachmentContentType;
  const actual = sniffContentType(headBytes);
  if (actual !== declared) {
    return actual
      ? `声明的类型 ${declared} 与实际文件内容（${actual}）不一致`
      : `声明的类型 ${declared} 与实际文件内容不一致（无法识别实际类型）`;
  }
  return null;
}

/** 上传请求体形状（JSON/base64 分支），与服务端 `createAttachmentSchema` 对齐。 */
export interface AttachmentUploadBody {
  ownerType: 'document';
  ownerId: number;
  filename: string;
  contentType: AttachmentContentType;
  dataBase64: string;
}

/** 纯 base64（无 data URL 前缀）；浏览器 FileReader 的 `readAsDataURL` 结果在逗号后。 */
export function base64PayloadFromDataUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}
