import { Hono } from 'hono';
import { query } from '../db/index.js';
import type { User } from '@timemark/shared';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { createLogger } from '../utils/logger.js';
import {
  EXPORT_CONTENT_TYPE,
  buildCalendarPrintView,
  buildContactsPrintView,
  buildReportPrintView,
  renderCalendarPrintHtml,
  renderContactsPrintHtml,
  renderReportPrintHtml,
} from '../services/export.service.js';

/**
 * Task 147 — print & export. Default Hono router mounted at `/api/export`.
 *
 * Routes are named `*.pdf` because the deliverable is a PDF via the browser's
 * print dialog, but the response body is self-contained print-ready HTML
 * (`text/html; charset=utf-8`) — never a remote asset, never a font/CDN request.
 */
const exportRoutes = new Hono<{ Variables: { user: User } }>();
exportRoutes.use('*', authMiddleware);
const log = createLogger('export');

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function shiftDays(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

function htmlResponse(c: Parameters<typeof authMiddleware>[0], html: string, filename: string) {
  return c.body(html, 200, {
    'Content-Type': EXPORT_CONTENT_TYPE,
    'Cache-Control': 'no-store',
    'Content-Disposition': `inline; filename="${filename}"`,
    'X-Robots-Tag': 'noindex, nofollow',
  });
}

exportRoutes.get('/calendar.pdf', async (c) => {
  const userId = Number(c.get('user').id);
  const month = c.req.query('month') ?? new Date().toISOString().slice(0, 7);
  if (!MONTH_RE.test(month)) {
    return c.json({ success: false, error: 'month 必须是 YYYY-MM' }, 400);
  }
  try {
    const view = await buildCalendarPrintView(userId, month);
    return htmlResponse(c, renderCalendarPrintHtml(view), `timemark-calendar-${month}.html`);
  } catch (error) {
    log.error({ event: 'export.calendar_failed', err: error }, 'Calendar export failed');
    return c.json({ success: false, error: '日历导出失败' }, 500);
  }
});

exportRoutes.get('/contacts.pdf', async (c) => {
  const userId = Number(c.get('user').id);
  try {
    const view = await buildContactsPrintView(userId);
    return htmlResponse(c, renderContactsPrintHtml(view), 'timemark-contacts.html');
  } catch (error) {
    log.error({ event: 'export.contacts_failed', err: error }, 'Contacts export failed');
    return c.json({ success: false, error: '联系人导出失败' }, 500);
  }
});

exportRoutes.get('/report.pdf', async (c) => {
  const userId = Number(c.get('user').id);
  const to = c.req.query('to') ?? todayUtc();
  const from = c.req.query('from') ?? shiftDays(to, -29);
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    return c.json({ success: false, error: 'from/to 必须是 YYYY-MM-DD' }, 400);
  }
  if (from > to) {
    return c.json({ success: false, error: 'from 不能晚于 to' }, 400);
  }
  try {
    const view = await buildReportPrintView(userId, from, to);
    return htmlResponse(c, renderReportPrintHtml(view), `timemark-report-${from}_${to}.html`);
  } catch (error) {
    log.error({ event: 'export.report_failed', err: error }, 'Report export failed');
    return c.json({ success: false, error: '报告导出失败' }, 500);
  }
});

export default exportRoutes;

/**
 * v2.27 E-4：事件 CSV 导出（与 trigger-logs 的 export.csv 同款响应写法）。
 */
exportRoutes.get('/events.csv', async (c) => {
  const userId = Number(c.get('user').id);
  const result = await query(
    `SELECT e.id, e.name, e.type, e.date, e.person_name, e.next_occurrence::text AS next_occurrence
     FROM events e WHERE e.user_id = $1 ORDER BY e.date ASC, e.id ASC`,
    [userId],
  );
  const header = 'id,name,type,date,person_name,next_occurrence';
  const lines = result.rows.map((row: Record<string, unknown>) => {
    const r = row as Record<string, unknown>;
    const esc = (v: unknown) => {
      const str = v == null ? '' : String(v);
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };
    return [r.id, r.name, r.type, r.date, r.person_name, r.next_occurrence].map(esc).join(',');
  });
  const csv = `\uFEFF${[header, ...lines].join('\n')}`;
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="events-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
});
