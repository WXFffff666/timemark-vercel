import axios from 'axios';
import { getBlessing } from '@timemark/shared/blessings';

/**
 * Chanify (self-hostable iOS push).
 * `POST {base}/v1/sender/{token}` with form body `text=` and query `title`/`sound`.
 * The base URL must be a bare origin: a base that already contains a path (e.g. `/v1`)
 * is rejected instead of blindly producing `/v1/v1`.
 */
export const CHANIFY_DEFAULT_BASE_URL = 'https://api.chanify.net';

export function normalizeChanifyBaseUrl(raw?: string): string {
  const value = String(raw || '').trim() || CHANIFY_DEFAULT_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Chanify 服务器地址格式无效，请填写完整地址（默认 https://api.chanify.net）');
  }
  if (parsed.pathname.replace(/\/+$/, '')) {
    throw new Error('Chanify 服务器地址只填域名（默认 https://api.chanify.net），不要包含 /v1/sender 等路径');
  }
  return parsed.origin;
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

export async function sendChanifyNotification(
  event: Record<string, unknown>,
  baseUrl: string | undefined,
  token: string,
): Promise<void> {
  const base = normalizeChanifyBaseUrl(baseUrl);
  const { title, body } = buildTitleAndBody(event);
  const url = `${base}/v1/sender/${encodeURIComponent(token)}?title=${encodeURIComponent(title)}&sound=1`;
  await axios.post(url, new URLSearchParams({ text: body }), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 10000,
  });
}
