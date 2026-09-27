import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * 附件下载的短时签名（todo 57）。
 *
 * 模型：
 * - 服务端在**通过会话归属校验之后**才会签发一个 API 下载链接：
 *   `/api/attachments/<id>/download?expires=<epochMs>&signature=<hmac>`。
 * - TTL 硬上限 300 秒（5 分钟），任何调用方都无法签发更长的链接。
 * - 签名只覆盖 `id` 与 `expires`（不绑定用户）：消费该链接时**仍然**要带会话，
 *   服务端重新做 owner 查询 —— 他人的会话即使拿到有效签名也只能得到 404。
 * - 签名值绝不写日志（logger 的 redact 列表也包含 signature/signedUrl 兜底）。
 *
 * 密钥优先级：ATTACHMENT_URL_SECRET > JWT_SECRET > MASTER_KEY。
 * 三者都缺失时 fail closed（抛 AttachmentSigningNotConfiguredError，路由返回 503），
 * 绝不退化到无签名/固定密钥。
 */

/** 签名 URL 的硬上限（秒）：不允许任何调用方签发更长的链接。 */
export const ATTACHMENT_SIGNED_URL_TTL_SECONDS = 300;

const MAX_SIGNATURE_LENGTH = 128;

export class AttachmentSigningNotConfiguredError extends Error {
  readonly code = 'ATTACHMENT_SIGNING_NOT_CONFIGURED';
  constructor() {
    super('附件下载签名未配置：请设置 ATTACHMENT_URL_SECRET / JWT_SECRET / MASTER_KEY');
    this.name = 'AttachmentSigningNotConfiguredError';
  }
}

function signingSecret(): string {
  const candidates = [
    process.env.ATTACHMENT_URL_SECRET,
    process.env.JWT_SECRET,
    process.env.MASTER_KEY,
  ];
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (value) return value;
  }
  throw new AttachmentSigningNotConfiguredError();
}

/** TTL 收敛到 [1, 300] 秒；非法输入按 1 秒处理。 */
export function clampAttachmentSignedTtlSeconds(requested: number): number {
  if (!Number.isFinite(requested)) return 1;
  return Math.max(1, Math.min(Math.floor(requested), ATTACHMENT_SIGNED_URL_TTL_SECONDS));
}

function signPayload(id: number, expiresAtMs: number): string {
  return `${id}.${expiresAtMs}`;
}

export function signAttachmentDownload(id: number, expiresAtMs: number): string {
  return createHmac('sha256', signingSecret()).update(signPayload(id, expiresAtMs)).digest('base64url');
}

export type AttachmentSignatureVerdict =
  | { status: 'ok' }
  | { status: 'expired' }
  | { status: 'invalid' }
  | { status: 'not_configured' };

/**
 * Verify a download signature. Expiry is checked with the caller-supplied clock
 * (`nowMs`) so tests can move time; invalid signatures never reach the owner check.
 * Signature comparison is constant-time and length-guarded.
 */
export function verifyAttachmentDownloadSignature(
  id: number,
  expiresAtMs: number,
  signature: string,
  nowMs: number = Date.now(),
): AttachmentSignatureVerdict {
  if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(expiresAtMs)) return { status: 'invalid' };
  if (typeof signature !== 'string' || signature.length === 0 || signature.length > MAX_SIGNATURE_LENGTH) {
    return { status: 'invalid' };
  }
  if (nowMs > expiresAtMs) return { status: 'expired' };

  let expected: string;
  try {
    expected = signAttachmentDownload(id, expiresAtMs);
  } catch (error) {
    if (error instanceof AttachmentSigningNotConfiguredError) return { status: 'not_configured' };
    throw error;
  }

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return { status: 'invalid' };
  return timingSafeEqual(a, b) ? { status: 'ok' } : { status: 'invalid' };
}

/** API-relative download path; the provider/blob URL is never exposed to clients. */
export function buildAttachmentDownloadPath(id: number, expiresAtMs: number, signature: string): string {
  return `/api/attachments/${id}/download?expires=${expiresAtMs}&signature=${signature}`;
}
