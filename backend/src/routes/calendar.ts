import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { getEventsByUserId } from '../services/event.service.js';
import { query } from '../db/index.js';
import { isSafePublicUrl } from '../utils/url-safety.js';
import type { User } from '@timemark/shared';

const calendar = new Hono<{ Variables: { user: User } }>();

calendar.use('*', authMiddleware);

/**
 * 导出事件为 .ics 文件
 * GET /api/calendar/export.ics
 */
calendar.get('/export.ics', async (c) => {
  const user = c.get('user');
  const events = await getEventsByUserId(user.id);

  // 生成 iCalendar 格式
  const icsContent = generateICS(events);

  return new Response(icsContent, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'attachment; filename="timemark-events.ics"',
    },
  });
});

/**
 * 生成 Google Calendar 订阅链接
 * GET /api/calendar/google
 */
calendar.get('/google', async (c) => {
  const user = c.get('user');
  const events = await getEventsByUserId(user.id);

  // 生成 Google Calendar 导入链接
  const googleLinks = events.map(event => {
    const startDate = parseDate(event.date);
    if (!startDate) return null;

    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 1);

    const params = new URLSearchParams({
      action: 'TEMPLATE',
      text: event.name,
      dates: `${formatDateForGoogle(startDate)}/${formatDateForGoogle(endDate)}`,
      details: generateEventDescription(event),
    });

    return {
      id: event.id,
      name: event.name,
      link: `https://calendar.google.com/calendar/render?${params.toString()}`,
    };
  }).filter(Boolean);

  return c.json({ success: true, data: googleLinks });
});

/**
 * 生成 Apple Calendar 订阅链接
 * GET /api/calendar/apple
 */
calendar.get('/apple', async (c) => {
  // Apple Calendar 使用 webcal:// 协议订阅
  // 这里返回 .ics 文件的 URL，用户可以订阅
  const host = c.req.header('Host') || 'localhost:3000';
  const protocol = c.req.header('X-Forwarded-Proto') || 'http';
  const icsUrl = `${protocol}://${host}/api/calendar/export.ics`;

  return c.json({
    success: true,
    data: {
      subscribeUrl: `webcal://${host}/api/calendar/export.ics`,
      directUrl: icsUrl,
    },
  });
});

/**
 * CalDAV 回写开关（checkbox 86）
 * GET  /api/calendar/caldav-writeback  读取当前状态（默认关闭）
 * POST /api/calendar/caldav-writeback  更新开关 / 目标集合 URL
 *
 * 回写只写入用户显式配置的 CalDAV 集合，复用既有的 Basic Auth 凭据；
 * 实体来源为外部同步（importSource）或目标集合与导入 URL 相同时会被
 * caldav-sync 的循环守卫跳过。
 */
calendar.get('/caldav-writeback', async (c) => {
  const user = c.get('user');
  const res = await query(
    `SELECT caldav_writeback_enabled, caldav_writeback_url, caldav_username, caldav_password_encrypted
       FROM user_configs WHERE user_id = $1`,
    [Number(user.id)],
  );
  const row = (res.rows[0] as Record<string, unknown> | undefined) ?? {};
  return c.json({
    success: true,
    data: {
      enabled: row.caldav_writeback_enabled === true,
      url: typeof row.caldav_writeback_url === 'string' ? row.caldav_writeback_url : null,
      hasCredentials: Boolean(row.caldav_username) || Boolean(row.caldav_password_encrypted),
    },
  });
});

calendar.post('/caldav-writeback', async (c) => {
  const user = c.get('user');
  const body = await c.req.json<Record<string, unknown>>().catch((): Record<string, unknown> => ({}));
  const userId = Number(user.id);

  const current = await query(
    `SELECT caldav_writeback_enabled, caldav_writeback_url FROM user_configs WHERE user_id = $1`,
    [userId],
  );
  const currentRow = (current.rows[0] as Record<string, unknown> | undefined) ?? {};

  let enabled = currentRow.caldav_writeback_enabled === true;
  if ('enabled' in body) {
    if (typeof body.enabled !== 'boolean') {
      return c.json({ success: false, error: 'enabled 必须是布尔值' }, 400);
    }
    enabled = body.enabled;
  }

  let url = typeof currentRow.caldav_writeback_url === 'string' ? currentRow.caldav_writeback_url : '';
  if ('url' in body) {
    if (body.url !== null && typeof body.url !== 'string') {
      return c.json({ success: false, error: 'url 必须是字符串' }, 400);
    }
    url = typeof body.url === 'string' ? body.url.trim() : '';
    if (url) {
      const safe = await isSafePublicUrl(url);
      if (!safe.safe) {
        return c.json({ success: false, error: safe.reason || 'URL 不安全' }, 400);
      }
    }
  }

  if (enabled && !url) {
    return c.json({ success: false, error: '启用回写前请先配置 CalDAV 日历集合 URL' }, 400);
  }

  await query(
    `INSERT INTO user_configs (user_id, caldav_writeback_enabled, caldav_writeback_url)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET
       caldav_writeback_enabled = EXCLUDED.caldav_writeback_enabled,
       caldav_writeback_url = EXCLUDED.caldav_writeback_url`,
    [userId, enabled, url || null],
  );

  return c.json({ success: true, data: { enabled, url: url || null } });
});

/**
 * 生成 iCalendar 格式内容
 */
function generateICS(events: any[]): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//TimeMark//TimeMark Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:TimeMark Events',
    'X-WR-TIMEZONE:Asia/Shanghai',
  ];

  for (const event of events) {
    const startDate = parseDate(event.date);
    if (!startDate) continue;

    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 1);

    const now = new Date();
    const uid = `timemark-${event.id}-${Date.now()}@timemark.app`;

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${uid}`);
    lines.push(`DTSTAMP:${formatDateForICS(now)}`);
    lines.push(`DTSTART;VALUE=DATE:${formatDateOnlyForICS(startDate)}`);
    lines.push(`DTEND;VALUE=DATE:${formatDateOnlyForICS(endDate)}`);
    lines.push(`SUMMARY:${escapeICS(event.name)}`);
    lines.push(`DESCRIPTION:${escapeICS(generateEventDescription(event))}`);
    lines.push(`CATEGORIES:${getEventTypeLabel(event.type)}`);

    // 添加提醒
    if (event.reminderConfig?.enabled && event.reminderConfig?.daysBeforeList) {
      for (const days of event.reminderConfig.daysBeforeList) {
        lines.push('BEGIN:VALARM');
        lines.push('ACTION:DISPLAY');
        lines.push(`DESCRIPTION:TimeMark 提醒: ${escapeICS(event.name)}`);
        lines.push(`TRIGGER:-P${days}D`);
        lines.push('END:VALARM');
      }
    }

    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

/**
 * 生成事件描述
 */
function generateEventDescription(event: any): string {
  const parts = [
    `事件类型: ${getEventTypeLabel(event.type)}`,
    `日期: ${event.date}`,
  ];

  if (event.personName) {
    parts.push(`被提醒人: ${event.personName}`);
  }

  if (event.reminderRecipientName) {
    parts.push(`提醒人: ${event.reminderRecipientName}`);
  }

  if (event.reminderConfig?.enabled) {
    const days = event.reminderConfig.daysBeforeList?.join(', ') || '无';
    parts.push(`提前提醒: ${days} 天`);
  }

  parts.push('由 TimeMark 智能事件提醒系统生成');

  return parts.join('\\n');
}

/**
 * 获取事件类型标签
 */
function getEventTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    birthday: '生日',
    exam: '考试',
    anniversary: '纪念日',
    holiday: '节日',
    other: '其他',
  };
  return labels[type] || type;
}

/**
 * 解析日期字符串
 */
function parseDate(dateStr: string): Date | null {
  try {
    const date = new Date(dateStr + 'T00:00:00');
    return isNaN(date.getTime()) ? null : date;
  } catch {
    return null;
  }
}

/**
 * 格式化日期为 iCalendar 格式
 */
function formatDateForICS(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * 格式化日期为 iCalendar 日期格式（仅日期）
 */
function formatDateOnlyForICS(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

/**
 * 格式化日期为 Google Calendar 格式
 */
function formatDateForGoogle(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * 转义 iCalendar 特殊字符
 */
function escapeICS(text: string): string {
  if (!text) return '';
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

export default calendar;
