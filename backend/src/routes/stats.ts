import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { query } from '../db/index.js';
import { sendReminders } from '../jobs/tasks.js';
import { getExpiryCosts, getExpirySummary } from '../services/expiry.service.js';
import { getAgentObservabilitySummary } from '../services/agent/run-observability.service.js';
import type { User } from '@timemark/shared';

const stats = new Hono<{ Variables: { user: User } }>();
stats.use('*', authMiddleware);

/** 「N 年前的今天」日历日匹配与年差（checkbox 82）。纯函数，便于单测。 */
export interface Ymd {
  year: number;
  month: number;
  day: number;
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 严格校验 YYYY-MM-DD（拒绝 2026-02-30 之类的非法日历日）。 */
export function parseYmd(value: string | null | undefined): Ymd | null {
  if (!value || !YMD_RE.test(value)) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * 参考日期要匹配的 `MM-DD` 候选集合。
 * 非闰年的 2 月 28 日额外纳入 2 月 29 日（闰日纪念日顺延到 2/28），
 * 否则闰日事件在平年会整年消失。
 */
export function memoryMonthDays(ref: Ymd): string[] {
  const mm = String(ref.month).padStart(2, '0');
  const dd = String(ref.day).padStart(2, '0');
  const days = [`${mm}-${dd}`];
  if (ref.month === 2 && ref.day === 28 && !isLeapYear(ref.year)) {
    days.push('02-29');
  }
  return days;
}

/** 年差（只对更早的年份有意义）；用于「N 年前」文案。 */
export function yearsAgoValue(refYear: number, occurredYear: number): number {
  return Math.max(0, refYear - occurredYear);
}

export interface OnThisDayItem {
  kind: 'event' | 'interaction';
  id: number;
  title: string;
  detail: string | null;
  occurredOn: string;
  yearsAgo: number;
  sourcePath: string;
  sourceLabel: string;
}

const MAX_MEMORY_ITEMS = 50;

stats.get('/', async (c) => {
  const user = c.get('user');
  const userId = Number(user.id);
  
  const [events, triggers, accounts, monthlyTriggers, eventsByType, upcoming, expirySummary, expiryCosts, agentObservability] = await Promise.all([
    query('SELECT COUNT(*) as count FROM events WHERE user_id = $1', [userId]),
    query(`SELECT status, COUNT(*) as count FROM event_trigger_logs 
           WHERE user_id = $1 AND created_at > NOW() - INTERVAL '30 days' 
           GROUP BY status`, [userId]),
    query('SELECT type, COUNT(*) as count FROM notification_accounts WHERE user_id = $1 AND is_active = TRUE GROUP BY type', [userId]),
    query(`SELECT TO_CHAR(created_at, 'YYYY-MM') as month, status, COUNT(*)::int as count
           FROM event_trigger_logs
           WHERE user_id = $1 AND created_at > NOW() - INTERVAL '6 months'
           GROUP BY month, status
           ORDER BY month`, [userId]),
    query(`SELECT type, COUNT(*)::int as count FROM events WHERE user_id = $1 GROUP BY type`, [userId]),
    // v2.27 D-5：activeEvents 口径修正——此前与 totalEvents 是同一条 COUNT，恒相等；
    // 现在按"仍有下一次触发"统计。
    query('SELECT COUNT(*)::int as count FROM events WHERE user_id = $1 AND next_occurrence IS NOT NULL', [userId]),
    // 到期中心（D1）：计数 + 周期成本（按货币分组，绝不跨货币求和）
    getExpirySummary(userId),
    getExpiryCosts(userId, { granularity: 'month' }),
    // checkbox 130: per-run records + rolling cost ledger + projection for the background AI.
    getAgentObservabilitySummary(userId),
  ]);
  
  return c.json({
    success: true,
    data: {
      totalEvents: Number(events.rows[0]?.count || 0),
      activeEvents: Number(upcoming.rows[0]?.count || 0),
      triggerStats: triggers.rows,
      channelUsage: accounts.rows,
      monthlyTriggers: monthlyTriggers.rows,
      eventsByType: eventsByType.rows,
      expiry: {
        ...expirySummary,
        costs: expiryCosts,
      },
      // checkbox 130: recent background-AI runs, rolling day/month cost ledger with a
      // month-to-date projection, and the 24h degraded count. Reads never throw.
      agent: agentObservability,
    },
  });
});

stats.get('/scheduler', async (c) => {
  // Local/Docker only; Vercel uses Cron Jobs instead
  if (!process.env.VERCEL) {
    // @ts-expect-error - scheduler.ts deleted in Vercel migration; guarded by !process.env.VERCEL
    const { getSchedulerStatus } = await import('../queue/scheduler.js');
    const status = getSchedulerStatus();
    return c.json({ success: true, data: status });
  }
  return c.json({ success: false, message: 'Scheduler not available in Vercel environment' });
});

stats.post('/trigger-reminders', async (c) => {
  try {
    await sendReminders();
    return c.json({ success: true, message: 'Reminders triggered successfully' });
  } catch (error) {
    return c.json({ success: false, message: `Trigger failed: ${String(error)}` }, 500);
  }
});

/**
 * `GET /api/stats/on-this-day`（checkbox 82）：只读的「N 年前的今天」。
 *
 * - 完全按 user_id 限定，跨用户的行永远不出现在结果里。
 * - 纯按需单次查询，无任何新的常驻计算 / 定时任务 / 物化表。
 * - 匹配规则：`events.date` 与 `interactions.occurred_at` 的 `MM-DD` 命中参考日，
 *   且年份严格早于参考年（未来的 occurred_at / 未来的事件不会被当成回忆）。
 * - `?date=YYYY-MM-DD` 仅用于测试与历史回看；缺省 = 数据库当前日期。
 *
 * 注意：`interactions.occurred_at` 是 TIMESTAMPTZ，`TO_CHAR` 使用数据库会话时区
 * （生产默认按应用时区），边界只在跨日午夜附近有理论偏差。
 */
stats.get('/on-this-day', async (c) => {
  const userId = Number(c.get('user').id);
  const rawDate = c.req.query('date');

  let ref: Ymd | null;
  if (rawDate === undefined) {
    const today = await query(`SELECT TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD') AS today`);
    ref = parseYmd(today.rows[0]?.today == null ? null : String(today.rows[0].today));
  } else {
    ref = parseYmd(rawDate);
    if (!ref) return c.json({ success: false, error: '日期格式必须为 YYYY-MM-DD' }, 400);
  }
  if (!ref) return c.json({ success: false, error: '无法确定参考日期' }, 500);

  const monthDays = memoryMonthDays(ref);
  const [eventRows, interactionRows] = await Promise.all([
    query(
      `SELECT id, name, type, TO_CHAR(date, 'YYYY-MM-DD') AS occurred_on,
              EXTRACT(YEAR FROM date)::int AS occurred_year
       FROM events
       WHERE user_id = $1
         AND TO_CHAR(date, 'MM-DD') = ANY($2::text[])
         AND EXTRACT(YEAR FROM date)::int < $3
       ORDER BY date DESC, id DESC
       LIMIT $4`,
      [userId, monthDays, ref.year, MAX_MEMORY_ITEMS],
    ),
    query(
      `SELECT i.id, i.kind, i.summary, i.contact_id, fc.name AS contact_name,
              TO_CHAR(i.occurred_at, 'YYYY-MM-DD') AS occurred_on,
              EXTRACT(YEAR FROM i.occurred_at)::int AS occurred_year
       FROM interactions i
       LEFT JOIN fixed_contacts fc ON fc.id = i.contact_id AND fc.user_id = i.user_id
       WHERE i.user_id = $1
         AND TO_CHAR(i.occurred_at, 'MM-DD') = ANY($2::text[])
         AND EXTRACT(YEAR FROM i.occurred_at)::int < $3
       ORDER BY i.occurred_at DESC, i.id DESC
       LIMIT $4`,
      [userId, monthDays, ref.year, MAX_MEMORY_ITEMS],
    ),
  ]);

  const events: OnThisDayItem[] = eventRows.rows.map((row) => ({
    kind: 'event',
    id: Number(row.id),
    title: String(row.name ?? ''),
    detail: row.type == null ? null : String(row.type),
    occurredOn: String(row.occurred_on ?? ''),
    yearsAgo: yearsAgoValue(ref.year, Number(row.occurred_year)),
    sourcePath: '/calendar',
    sourceLabel: '在日历中查看',
  }));

  const interactions: OnThisDayItem[] = interactionRows.rows.map((row) => {
    const contactName = row.contact_name == null ? null : String(row.contact_name);
    const kind = row.kind == null ? null : String(row.kind);
    const summary = row.summary == null ? null : String(row.summary);
    return {
      kind: 'interaction',
      id: Number(row.id),
      title: summary || contactName || kind || '互动记录',
      detail: contactName,
      occurredOn: String(row.occurred_on ?? ''),
      yearsAgo: yearsAgoValue(ref.year, Number(row.occurred_year)),
      sourcePath: '/contacts',
      sourceLabel: '查看联系记录',
    };
  });

  const items = [...events, ...interactions]
    .sort((a, b) => a.yearsAgo - b.yearsAgo || (a.kind === b.kind ? b.id - a.id : a.kind === 'event' ? -1 : 1))
    .slice(0, MAX_MEMORY_ITEMS);

  const refYmd = `${String(ref.year).padStart(4, '0')}-${String(ref.month).padStart(2, '0')}-${String(ref.day).padStart(2, '0')}`;
  return c.json({ success: true, data: { date: refYmd, items } });
});

export default stats;
