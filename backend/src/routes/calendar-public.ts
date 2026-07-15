import { Hono } from 'hono';
import { query } from '../db/index.js';
import { getEventsByUserId } from '../services/event.service.js';
import { getUserConfig } from '../services/config.service.js';

const calendarPublic = new Hono();

function escapeICS(text: string): string {
  if (!text) return '';
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function generateICS(events: Array<Record<string, unknown>>, timezone: string): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//TimeMark//Feed//EN',
    'CALSCALE:GREGORIAN',
    `X-WR-TIMEZONE:${timezone}`,
  ];

  for (const event of events) {
    const dateStr = String(event.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;
    const ymd = dateStr.replace(/-/g, '');
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:timemark-${event.id}@timemark.app`);
    lines.push(`DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`);
    lines.push(`DTSTART;VALUE=DATE:${ymd}`);
    lines.push(`SUMMARY:${escapeICS(String(event.name || ''))}`);
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

calendarPublic.get('/feed/:token.ics', async (c) => {
  const token = c.req.param('token');
  const row = await query(
    'SELECT user_id FROM user_configs WHERE calendar_feed_token = $1',
    [token],
  );
  if (!row.rows.length) {
    return c.text('Not found', 404);
  }

  const userId = String(row.rows[0].user_id);
  const config = await getUserConfig(Number(userId));
  const events = await getEventsByUserId(userId);
  const tz = config?.timezone || 'Asia/Shanghai';
  const ics = generateICS(events as unknown as Array<Record<string, unknown>>, tz);

  return new Response(ics, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Cache-Control': 'private, max-age=300',
    },
  });
});

export default calendarPublic;
