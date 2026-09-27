import crypto from 'node:crypto';
import axios from 'axios';
import { getBlessing } from '@timemark/shared/blessings';

/**
 * Firebase Cloud Messaging HTTP v1.
 * The account `token` column stores the full service-account JSON (AES-encrypted at rest, decrypted
 * before it reaches this module); the `chat_id` column stores the device registration token or
 * `topic:<name>`.
 *
 * The RS256 JWT is signed with Node's built-in crypto — no JWT dependency is needed.
 * Access tokens live ~1h and are cached in memory per warm instance.
 * SECURITY: the service-account JSON, the JWT and the bearer token are never logged.
 */
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

export interface FcmServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

interface CachedAccessToken {
  token: string;
  expiresAt: number;
}

const accessTokenCache = new Map<string, CachedAccessToken>();

export function parseFcmServiceAccount(raw: string): FcmServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('FCM 服务账号 JSON 解析失败：请粘贴 Firebase 控制台下载的完整 JSON 文件内容');
  }
  const account = parsed as Partial<FcmServiceAccount> | null;
  const missing = (['project_id', 'client_email', 'private_key'] as const).filter(
    (key) => typeof account?.[key] !== 'string' || !(account?.[key] as string).trim(),
  );
  if (account === null || typeof account !== 'object' || missing.length > 0) {
    throw new Error(`FCM 服务账号 JSON 缺少字段: ${missing.length > 0 ? missing.join(', ') : 'project_id/client_email/private_key'}`);
  }
  return account as FcmServiceAccount;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function buildFcmJwt(account: FcmServiceAccount): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: account.client_email,
      scope: FCM_SCOPE,
      aud: OAUTH_TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );
  const unsigned = `${header}.${claims}`;
  let signature: Buffer;
  try {
    signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), account.private_key);
  } catch {
    throw new Error('FCM 服务账号私钥无效或无法用于签名，请重新下载服务账号 JSON');
  }
  return `${unsigned}.${base64url(signature)}`;
}

export async function getFcmAccessToken(account: FcmServiceAccount): Promise<string> {
  const cached = accessTokenCache.get(account.client_email);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }
  const assertion = buildFcmJwt(account);
  let response: { data?: { access_token?: unknown; expires_in?: unknown; error?: unknown; error_description?: unknown } };
  try {
    response = await axios.post(
      OAUTH_TOKEN_URL,
      new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 },
    );
  } catch (error) {
    const data = (error as { response?: { data?: { error?: unknown; error_description?: unknown } } }).response?.data;
    const providerError = data?.error_description || data?.error;
    throw new Error(`FCM OAuth 认证失败: ${providerError ? String(providerError) : (error as Error).message}`);
  }
  const token = response.data?.access_token;
  if (typeof token !== 'string' || !token) {
    throw new Error('FCM OAuth 响应缺少 access_token');
  }
  const expiresIn = Number(response.data?.expires_in) || 3600;
  accessTokenCache.set(account.client_email, {
    token,
    expiresAt: Date.now() + Math.max(60, expiresIn - 300) * 1000,
  });
  return token;
}

function buildMessageTarget(chatId: string): { token: string } | { topic: string } {
  const target = String(chatId || '').trim();
  if (!target) {
    throw new Error('FCM 收件目标不能为空：请填写设备注册令牌或 topic:<主题名>');
  }
  if (/^topic:/i.test(target)) {
    const topic = target.slice(6).trim();
    if (!topic) {
      throw new Error('FCM topic 目标不能为空：请填写 topic:<主题名>');
    }
    return { topic };
  }
  return { token: target };
}

/** Low-level sender shared by the channel and the connection test (`validateOnly`). */
export async function sendFcmMessage(
  serviceAccountJson: string,
  chatId: string,
  payload: { title: string; body: string; data?: Record<string, string> },
  options?: { validateOnly?: boolean },
): Promise<void> {
  const account = parseFcmServiceAccount(serviceAccountJson);
  const target = buildMessageTarget(chatId);
  const accessToken = await getFcmAccessToken(account);
  const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`;
  const body: Record<string, unknown> = {
    message: {
      ...target,
      notification: { title: payload.title, body: payload.body },
      ...(payload.data ? { data: payload.data } : {}),
    },
  };
  if (options?.validateOnly) {
    body.validate_only = true;
  }
  let response: { status: number; data?: { error?: { message?: string; status?: string } ; name?: string } };
  try {
    response = await axios.post(url, body, {
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      timeout: 10000,
    });
  } catch (error) {
    const apiError = (error as { response?: { data?: { error?: { message?: string; status?: string } } } }).response?.data?.error;
    if (apiError) {
      throw new Error(`FCM 发送失败: ${apiError.message || apiError.status || '未知错误'}`);
    }
    throw new Error(`FCM 请求失败: ${(error as Error).message}`);
  }
  if (response.data?.error) {
    throw new Error(`FCM 发送失败: ${response.data.error.message || response.data.error.status || '未知错误'}`);
  }
}

function buildTitleAndBody(event: Record<string, unknown>): { title: string; body: string } {
  const title = `📅 ${String(event.name ?? '')}`;
  if (event.customMessage) {
    return { title, body: String(event.customMessage) };
  }
  const reminderConfig = event.reminderConfig as { customMessage?: string } | undefined;
  const blessing = getBlessing(
    String(event.type || 'other'),
    reminderConfig?.customMessage,
    event.personName as string | undefined,
    event.reminderRecipientName as string | undefined,
  );
  return {
    title,
    body: `📆 日期: ${String(event.date ?? '')}\n🏷️ 类型: ${String(event.type ?? '')}\n\n🎉 ${blessing}`,
  };
}

export async function sendFcmNotification(
  event: Record<string, unknown>,
  serviceAccountJson: string,
  chatId: string,
): Promise<void> {
  const { title, body } = buildTitleAndBody(event);
  await sendFcmMessage(serviceAccountJson, chatId, {
    title,
    body,
    data: {
      date: String(event.date ?? ''),
      type: String(event.type ?? ''),
      eventId: String(event.id ?? ''),
    },
  });
}
