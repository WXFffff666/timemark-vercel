/**
 * 邮件组装：尽量像「自己手写的一封短信」，降低模板感与进垃圾箱概率。
 */

import { getEventTypeLabel } from './templates.js';

export { getEventTypeLabel };

export function getAppOrigin(): string {
  if (typeof process !== 'undefined' && process.env?.CORS_ORIGIN) {
    const first = process.env.CORS_ORIGIN.split(',')[0]?.trim();
    if (first && first.startsWith('https://')) return first.replace(/\/$/, '');
  }
  return 'https://timemark.the37777777.top';
}

/** 计算距事件天数（仅用于主题/文案，不精确到小时） */
export function daysUntilDate(dateStr: string): number | null {
  if (!dateStr) return null;
  const target = new Date(`${dateStr.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(target.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.ceil((target.getTime() - today.getTime()) / 86400000);
}

/**
 * 把「农历」标签并入公历日期（仅农历/双历事件）：`2026-10-05（农历八月十五）`。
 *
 * 公历事件（或没有可用农历标签）原样返回 `date` —— 这正是「公历输出逐字节不变」的
 * 回归护栏。农历标签必须是**已持久化**的 `events.lunar_date`（调用方原样传入），
 * 这里绝不重算，也绝不猜测。
 */
export function composeDualCalendarDate(
  date: string,
  lunarLabel?: string,
  calendarType?: string,
): string {
  const day = String(date || '');
  const lunar = String(lunarLabel || '').trim();
  if (!lunar || (calendarType !== 'lunar' && calendarType !== 'both')) return day;
  return day ? `${day}（${lunar}）` : lunar;
}

/** 像个人备忘一样的主题行，不含产品名 */
export function buildReminderSubject(
  eventName: string,
  eventType?: string,
  eventDate?: string,
  lunarLabel?: string,
  calendarType?: string,
): string {
  const name = String(eventName || '这件事').trim().slice(0, 100);
  const date = String(eventDate || '');
  const days = date ? daysUntilDate(date) : null;
  const lunar = String(lunarLabel || '').trim();
  const isDual = (calendarType === 'lunar' || calendarType === 'both') && lunar.length > 0;
  const dualText = isDual ? (date ? `${date}（${lunar}）` : lunar) : '';
  const withDual = (base: string) => (dualText ? `${base} · ${dualText}` : base);

  let base: string;
  if (eventType === 'birthday') {
    if (days === 0) base = `今天是${name}`;
    else if (days === 1) base = `明天是${name}`;
    else if (days != null && days > 1 && days <= 7) base = `快到了：${name}`;
    else base = name;
  } else if (eventType === 'exam') {
    if (days === 0) base = `今天：${name}`;
    else if (days === 1) base = `明天：${name}`;
    else base = `别忘了：${name}`;
  } else if (eventType === 'anniversary' || eventType === 'holiday') {
    if (days === 0) base = `今天：${name}`;
    else base = name;
  } else if (days === 0) {
    base = `今天：${name}`;
  } else if (days === 1) {
    base = `明天：${name}`;
  } else {
    base = name.length <= 40 ? `提醒：${name}` : name.slice(0, 40);
  }
  return withDual(base);
}

export function buildBroadcastSubject(subject: string): string {
  return String(subject || '你好')
    .trim()
    .replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+/u, '')
    .replace(/\[TimeMark\]/gi, '')
    .trim()
    .slice(0, 120);
}

export function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function softenBlessing(text: string): string {
  return text
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export interface ReminderEmailInput {
  name: string;
  date: string;
  type: string;
  /** 「农历」前缀标签（如 `农历八月十五`），农历/双历事件才有；由持久化的 lunar_date 得来。 */
  lunarDate?: string;
  /** `gregorian` | `lunar` | `both`。只有农历/双历才把农历并入正文。 */
  calendarType?: string;
  blessing?: string;
  customMessage?: string;
  showManageLink?: boolean;
  appOrigin?: string;
}

export function buildNaturalReminderText(input: ReminderEmailInput): string {
  const name = String(input.name || '').trim() || '这件事';
  const date = String(input.date || '').trim();
  const type = input.type || 'other';
  const days = date ? daysUntilDate(date) : null;
  const custom = String(input.customMessage || '').trim();
  const blessing = softenBlessing(String(input.blessing || '').trim());
  // 公历事件（或无农历标签）时 dateLabel === date —— 正文逐字节不变。
  const dateLabel = composeDualCalendarDate(date, input.lunarDate, input.calendarType);
  const dualNote = dateLabel === date ? '' : `（${dateLabel}）`;

  if (custom) {
    let body = custom.replace(/\*\*(.+?)\*\*/g, '$1');
    if (date && !body.includes(date.slice(0, 10)) && !body.includes(date)) {
      body += `\n日期：${dateLabel}`;
    }
    return body.trim();
  }

  const lines: string[] = [];

  if (type === 'birthday') {
    if (days === 0) lines.push(`${name}就是今天${dualNote}。`);
    else if (days === 1) lines.push(`${name}是明天（${dateLabel}）。`);
    else if (days != null && days > 0) lines.push(`${name}还有 ${days} 天，日期是 ${dateLabel}。`);
    else lines.push(`${name}，日期 ${dateLabel}。`);
    if (blessing) lines.push(blessing);
  } else if (type === 'exam') {
    if (days === 0) lines.push(`今天是 ${name}${dualNote}，加油。`);
    else if (days === 1) lines.push(`明天是 ${name}${dualNote}，记得准备一下。`);
    else if (days != null && days > 0) lines.push(`${name}还有 ${days} 天（${dateLabel}）。`);
    else lines.push(`${name}，${dateLabel}。`);
  } else {
    if (days === 0) lines.push(`今天是：${name}${dualNote}。`);
    else if (days === 1) lines.push(`明天是：${name}${dualNote}。`);
    else lines.push(`提醒你一下：${name}，${dateLabel}。`);
    if (blessing && blessing !== name) lines.push(blessing);
  }

  return lines.join('\n').trim();
}

export function buildReminderEmailBodies(input: ReminderEmailInput): { html: string; text: string } {
  const textCore = buildNaturalReminderText(input);
  const text =
    input.showManageLink && input.appOrigin
      ? `${textCore}\n\n—\n${input.appOrigin}`
      : textCore;

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.6;color:#222">
<p style="margin:0;white-space:pre-wrap">${escapeHtmlMinimal(textCore)}</p>
</body>
</html>`;

  return { html, text };
}

export function buildLightEmailFooter(): { html: string; text: string } {
  return { html: '', text: '' };
}

export function wrapSimpleHtmlBody(innerHtml: string): string {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"></head><body style="margin:0;padding:16px;font-family:sans-serif;font-size:15px;line-height:1.6;color:#222">${innerHtml}</body></html>`;
}

export function renderPlainMarkdownToHtml(template: string, vars: Record<string, string>): string {
  let text = template;
  for (const [key, value] of Object.entries(vars)) {
    text = text.split(`{{${key}}}`).join(value);
  }
  const plain = text.replace(/\*\*(.+?)\*\*/g, '$1');
  return wrapSimpleHtmlBody(
    `<p style="margin:0;line-height:1.6;white-space:pre-wrap">${escapeHtmlMinimal(plain)}</p>`,
  );
}

function escapeHtmlMinimal(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
