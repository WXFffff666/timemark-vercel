import axios from 'axios';
import { getBlessing } from '@timemark/shared/blessings';

/** 息知 (XiZhi) push — `POST https://xizhi.qqoq.net/{key}.send` with `title`/`content`. */
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

export function buildXizhiUrl(key: string): string {
  return `https://xizhi.qqoq.net/${encodeURIComponent(key)}.send`;
}

export async function sendXizhiNotification(event: Record<string, unknown>, key: string): Promise<void> {
  const { title, body } = buildTitleAndBody(event);
  const response = await axios.post(buildXizhiUrl(key), new URLSearchParams({ title, content: body }), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 10000,
  });
  // Live-probed 2026-09-27: success is `{"code":200}`; an invalid key answers `{"code":10000,"msg":"..."}` with HTTP 200.
  if (response.data?.code !== 200) {
    throw new Error(`息知发送失败: ${response.data?.msg || response.data?.message || '未知错误'}`);
  }
}
