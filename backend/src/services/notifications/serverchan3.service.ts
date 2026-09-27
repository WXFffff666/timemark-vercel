import axios from 'axios';
import { getBlessing } from '@timemark/shared/blessings';

/**
 * Server酱³ (SC3) — the successor product of ServerChan Turbo.
 * SendKey has the shape `sctp<uid>t<secret>`; the delivery host is `{uid}.push.ft07.com`.
 * The UID can be overridden by the account's `webhook` field, otherwise it is derived from the key.
 */
export function deriveServerChan3Uid(sendKey: string): string | null {
  const match = String(sendKey || '').trim().match(/^sctp(\d+)t/i);
  return match?.[1] ?? null;
}

export function buildServerChan3Url(sendKey: string, uidOverride?: string): string {
  const uid = String(uidOverride || '').trim() || deriveServerChan3Uid(sendKey);
  if (!uid) {
    throw new Error('无法从 SendKey 推导 UID（SC3 SendKey 形如 sctp<UID>t...），请在渠道配置的 UID 字段手动填写');
  }
  return `https://${uid}.push.ft07.com/send/${sendKey}.send`;
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

export async function sendServerChan3Notification(
  event: Record<string, unknown>,
  sendKey: string,
  uidOverride?: string,
): Promise<void> {
  const { title, body } = buildTitleAndBody(event);
  const url = buildServerChan3Url(sendKey, uidOverride);
  const response = await axios.post(url, new URLSearchParams({ title, desp: body }), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 10000,
  });
  if (response.data?.code !== 0) {
    // Live fixture (2026-09): HTTP 200 {"error":"sendkey not found","code":10003} — surface it.
    const providerMessage = response.data?.error || response.data?.message || response.data?.msg;
    throw new Error(`Server酱³ 发送失败: ${providerMessage || '未知错误'}`);
  }
}
