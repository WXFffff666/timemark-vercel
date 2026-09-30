import { query } from '../db/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('export');

/**
 * Task 147 — print & export.
 *
 * Every renderer here produces a SINGLE self-contained HTML document:
 *   - no external stylesheet, no CDN, no remote font, no image URL, no JS import;
 *   - the only network request is the one the browser already made to this API;
 *   - the CJK-capable font stack is a list of fonts that ship with the OS.
 * The `@media print` block turns the page into a print-ready A4 document, so the
 * user's browser "Print to PDF" produces the artefact with zero server egress.
 */

export const PRINT_FONT_STACK =
  'system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", "WenQuanYi Micro Hei", sans-serif';

export const EXPORT_CONTENT_TYPE = 'text/html; charset=utf-8';

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const TYPE_LABELS: Record<string, string> = {
  birthday: '生日',
  exam: '考试',
  anniversary: '纪念日',
  holiday: '节日',
  meeting: '会议',
  deadline: '截止',
  travel: '旅行',
  graduation: '毕业',
  wedding: '婚礼',
  medical: '医疗',
  other: '其他',
};

function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type;
}

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

function baseCss(): string {
  return `
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font-family: ${PRINT_FONT_STACK}; color: #1e293b; background: #f1f5f9; font-size: 13px; line-height: 1.5; }
  .sheet { max-width: 900px; margin: 0 auto; background: #ffffff; padding: 28px 32px 40px; }
  .toolbar { max-width: 900px; margin: 16px auto 0; display: flex; gap: 10px; align-items: center; justify-content: flex-end; }
  .toolbar button { font: inherit; padding: 8px 18px; border-radius: 999px; border: 1px solid #cbd5e1; background: #2563eb; color: #fff; cursor: pointer; }
  .toolbar .hint { margin-right: auto; color: #64748b; font-size: 12px; }
  h1 { font-size: 22px; margin: 0 0 2px; }
  h2 { font-size: 15px; margin: 24px 0 10px; border-left: 4px solid #2563eb; padding-left: 8px; }
  .subtitle { color: #64748b; font-size: 12px; margin-bottom: 6px; }
  .meta { color: #94a3b8; font-size: 11px; margin-bottom: 18px; }
  .grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; }
  .dow { text-align: center; font-weight: 700; color: #475569; padding: 4px 0; }
  .cell { border: 1px solid #e2e8f0; border-radius: 6px; min-height: 74px; padding: 4px 5px; background: #fff; break-inside: avoid; }
  .cell.empty { background: #f8fafc; border-style: dashed; }
  .cell .daynum { font-weight: 700; color: #334155; font-size: 12px; }
  .chip { display: block; margin-top: 3px; padding: 1px 5px; border-radius: 4px; background: #eff6ff; border: 1px solid #bfdbfe; color: #1e3a8a; font-size: 11px; overflow-wrap: anywhere; }
  .chip .time { color: #2563eb; font-weight: 700; margin-right: 3px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { border: 1px solid #e2e8f0; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #f1f5f9; font-size: 12px; }
  .cards { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
  .card { border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 14px; break-inside: avoid; }
  .card .name { font-size: 15px; font-weight: 700; }
  .card .rel { color: #2563eb; font-size: 12px; }
  .card dl { margin: 8px 0 0; display: grid; grid-template-columns: auto 1fr; gap: 2px 8px; }
  .card dt { color: #64748b; }
  .card dd { margin: 0; overflow-wrap: anywhere; }
  .stats { display: flex; gap: 12px; flex-wrap: wrap; }
  .stat { flex: 1 1 150px; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; }
  .stat .value { font-size: 24px; font-weight: 800; color: #2563eb; }
  .stat .label { color: #64748b; font-size: 12px; }
  .empty-note { color: #94a3b8; font-size: 12px; }
  @media screen { body { padding: 0 0 40px; } }
  @media print {
    @page { size: A4 portrait; margin: 12mm; }
    body { background: #fff; font-size: 11.5px; }
    .sheet { max-width: none; margin: 0; padding: 0; }
    .toolbar, .no-print { display: none !important; }
    .cell, .card, tr { break-inside: avoid; }
    h2 { break-after: avoid; }
  }`;
}

interface ShellOptions {
  title: string;
  subtitle: string;
  bodyHtml: string;
  autoPrint?: boolean;
}

function renderShell(options: ShellOptions): string {
  const script = options.autoPrint
    ? '<script>window.addEventListener("load",function(){window.setTimeout(function(){window.print();},200);});</script>'
    : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(options.title)}</title>
<style>${baseCss()}</style>
</head>
<body>
<div class="toolbar">
  <span class="hint">按 Ctrl/⌘ + P 打印或另存为 PDF</span>
  <button type="button" onclick="window.print()">打印 / 导出 PDF</button>
</div>
<div class="sheet">
  <h1>${escapeHtml(options.title)}</h1>
  <div class="subtitle">${escapeHtml(options.subtitle)}</div>
  <div class="meta">由 TimeMark 生成 · ${escapeHtml(new Date().toISOString().slice(0, 16).replace('T', ' '))} UTC · 本文件自包含，无外部资源</div>
  ${options.bodyHtml}
</div>
${script}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface CalendarPrintView {
  month: string;
  monthLabel: string;
  weekdayOffset: number;
  days: Array<{ day: number; date: string; events: Array<{ name: string; type: string; time: string | null }> }>;
  eventCount: number;
}

export async function buildCalendarPrintView(userId: number, month: string): Promise<CalendarPrintView> {
  const [yearStr, monthStr] = month.split('-');
  const year = Number(yearStr);
  const monthIndex = Number(monthStr) - 1;
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const weekdayOffset = (first.getUTCDay() + 6) % 7; // Monday-first
  const nextMonth = monthIndex === 11 ? `${year + 1}-01-01` : `${year}-${String(monthIndex + 2).padStart(2, '0')}-01`;
  const from = `${year}-${String(monthIndex + 1).padStart(2, '0')}-01`;

  const result = await query(
    `SELECT name, type, date::text AS date, NULLIF(reminder_time::text, '') AS time
     FROM events
     WHERE user_id = $1 AND date >= $2::date AND date < $3::date
     ORDER BY date ASC, reminder_time ASC NULLS LAST, id ASC`,
    [userId, from, nextMonth],
  );

  const byDate = new Map<string, Array<{ name: string; type: string; time: string | null }>>();
  for (const row of result.rows as Array<{ name: string; type: string; date: string; time: string | null }>) {
    const list = byDate.get(row.date) ?? [];
    list.push({ name: row.name, type: row.type, time: row.time ? row.time.slice(0, 5) : null });
    byDate.set(row.date, list);
  }

  const days: CalendarPrintView['days'] = [];
  for (let day = 1; day <= lastDay; day += 1) {
    const date = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    days.push({ day, date, events: byDate.get(date) ?? [] });
  }

  return {
    month,
    monthLabel: `${year} 年 ${monthIndex + 1} 月`,
    weekdayOffset,
    days,
    eventCount: result.rows.length,
  };
}

export function renderCalendarPrintHtml(view: CalendarPrintView): string {
  const cells: string[] = [];
  for (let i = 0; i < view.weekdayOffset; i += 1) cells.push('<div class="cell empty"></div>');
  for (const day of view.days) {
    const chips = day.events
      .map((event) => {
        const time = event.time ? `<span class="time">${escapeHtml(event.time)}</span>` : '';
        const label = event.time ? '' : `<span class="time">${escapeHtml(typeLabel(event.type))}</span>`;
        return `<span class="chip">${time}${label}${escapeHtml(event.name)}</span>`;
      })
      .join('');
    cells.push(`<div class="cell"><div class="daynum">${day.day}</div>${chips}</div>`);
  }
  const header = WEEKDAYS.map((label) => `<div class="dow">${label}</div>`).join('');
  const bodyHtml = `
  <h2>${escapeHtml(view.monthLabel)} · 共 ${view.eventCount} 项</h2>
  <div class="grid">${header}${cells.join('')}</div>`;
  return renderShell({
    title: `${view.monthLabel} 日历`,
    subtitle: '月视图（周一起始）',
    bodyHtml,
  });
}

export interface ContactPrintCard {
  name: string;
  relationship: string | null;
  nickname: string | null;
  emails: string[];
  phones: string[];
  notes: string | null;
  cadenceDays: number | null;
  lastContactAt: string | null;
}

function pickMethods(raw: unknown, wanted: string): string[] {
  const out: string[] = [];
  const push = (value: unknown): void => {
    const text = String(value ?? '').trim();
    if (text) out.push(text);
  };
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>;
        const kind = String(record.type ?? record.kind ?? record.label ?? '').toLowerCase();
        if (kind === wanted || kind === '') push(record.value ?? record.address ?? record.number);
      } else {
        push(item);
      }
    }
  } else if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key.toLowerCase().includes(wanted)) push(record[key]);
    }
  }
  return out;
}

export async function buildContactsPrintView(userId: number): Promise<{ cards: ContactPrintCard[] }> {
  const result = await query(
    `SELECT name, nickname, relationship, email, phone, notes, cadence_days, last_contact_at, contact_methods
     FROM fixed_contacts WHERE user_id = $1 ORDER BY name ASC, id ASC LIMIT 500`,
    [userId],
  );
  const cards: ContactPrintCard[] = [];
  for (const row of result.rows as Array<Record<string, unknown>>) {
    const emails = new Set<string>();
    const phones = new Set<string>();
    if (row.email) emails.add(String(row.email));
    if (row.phone) phones.add(String(row.phone));
    for (const email of pickMethods(row.contact_methods, 'email')) emails.add(email);
    for (const phone of pickMethods(row.contact_methods, 'phone')) phones.add(phone);
    cards.push({
      name: String(row.name ?? '未命名联系人'),
      relationship: row.relationship ? String(row.relationship) : null,
      nickname: row.nickname ? String(row.nickname) : null,
      emails: [...emails],
      phones: [...phones],
      notes: row.notes ? String(row.notes) : null,
      cadenceDays: row.cadence_days == null ? null : Number(row.cadence_days),
      lastContactAt: row.last_contact_at ? String(row.last_contact_at).slice(0, 10) : null,
    });
  }
  return { cards };
}

export function renderContactsPrintHtml(view: { cards: ContactPrintCard[] }): string {
  const cards = view.cards
    .map((card) => {
      const rows: string[] = [];
      if (card.relationship) rows.push(`<dt>关系</dt><dd>${escapeHtml(card.relationship)}</dd>`);
      if (card.nickname) rows.push(`<dt>昵称</dt><dd>${escapeHtml(card.nickname)}</dd>`);
      for (const email of card.emails) rows.push(`<dt>邮箱</dt><dd>${escapeHtml(email)}</dd>`);
      for (const phone of card.phones) rows.push(`<dt>电话</dt><dd>${escapeHtml(phone)}</dd>`);
      if (card.cadenceDays != null) rows.push(`<dt>联系节奏</dt><dd>${card.cadenceDays} 天</dd>`);
      if (card.lastContactAt) rows.push(`<dt>最近联系</dt><dd>${escapeHtml(card.lastContactAt)}</dd>`);
      if (card.notes) rows.push(`<dt>备注</dt><dd>${escapeHtml(card.notes.slice(0, 500))}</dd>`);
      return `<div class="card"><div class="name">${escapeHtml(card.name)}</div>${rows.length ? `<dl>${rows.join('')}</dl>` : '<div class="empty-note">无联系方式</div>'}</div>`;
    })
    .join('');
  const bodyHtml = view.cards.length
    ? `<h2>联系人卡片 · 共 ${view.cards.length} 人</h2><div class="cards">${cards}</div>`
    : '<h2>联系人卡片</h2><p class="empty-note">暂无联系人。</p>';
  return renderShell({ title: '联系人卡片', subtitle: '通讯录打印视图', bodyHtml });
}

export interface ReportPrintView {
  from: string;
  to: string;
  totalEvents: number;
  byType: Array<{ type: string; count: number }>;
  events: Array<{ name: string; type: string; date: string }>;
  triggerCount: number;
}

export async function buildReportPrintView(userId: number, from: string, to: string): Promise<ReportPrintView> {
  const events = await query(
    `SELECT name, type, date::text AS date FROM events
     WHERE user_id = $1 AND date >= $2::date AND date <= $3::date
     ORDER BY date ASC, id ASC LIMIT 1000`,
    [userId, from, to],
  );
  const rows = events.rows as Array<{ name: string; type: string; date: string }>;
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.type, (counts.get(row.type) ?? 0) + 1);
  const byType = [...counts.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count);

  let triggerCount = 0;
  try {
    const triggers = await query(
      `SELECT COUNT(*)::int AS count FROM event_trigger_logs
       WHERE user_id = $1 AND created_at >= $2::date AND created_at < ($3::date + INTERVAL '1 day')`,
      [userId, from, to],
    );
    triggerCount = Number((triggers.rows[0] as { count?: number } | undefined)?.count ?? 0);
  } catch (error) {
    // A missing/renamed logs table must never break the report itself.
    log.warn({ event: 'export.trigger_count_failed', err: error }, 'Trigger-count query failed; reporting 0');
  }

  return { from, to, totalEvents: rows.length, byType, events: rows, triggerCount };
}

export function renderReportPrintHtml(view: ReportPrintView): string {
  const stats = `
  <div class="stats">
    <div class="stat"><div class="value">${view.totalEvents}</div><div class="label">区间内事件</div></div>
    <div class="stat"><div class="value">${view.byType.length}</div><div class="label">事件类型</div></div>
    <div class="stat"><div class="value">${view.triggerCount}</div><div class="label">提醒触发记录</div></div>
  </div>`;

  const typeRows = view.byType
    .map((entry) => `<tr><td>${escapeHtml(typeLabel(entry.type))}</td><td>${entry.count}</td></tr>`)
    .join('');
  const eventRows = view.events
    .map((event) => `<tr><td>${escapeHtml(event.date)}</td><td>${escapeHtml(typeLabel(event.type))}</td><td>${escapeHtml(event.name)}</td></tr>`)
    .join('');

  const bodyHtml = `
  <h2>概览</h2>
  ${stats}
  <h2>按类型统计</h2>
  ${typeRows ? `<table><thead><tr><th>类型</th><th>数量</th></tr></thead><tbody>${typeRows}</tbody></table>` : '<p class="empty-note">区间内没有事件。</p>'}
  <h2>事件明细</h2>
  ${eventRows ? `<table><thead><tr><th>日期</th><th>类型</th><th>名称</th></tr></thead><tbody>${eventRows}</tbody></table>` : '<p class="empty-note">区间内没有事件。</p>'}`;

  return renderShell({ title: `报告 ${view.from} → ${view.to}`, subtitle: '事件与提醒统计报告', bodyHtml });
}
