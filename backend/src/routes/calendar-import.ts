import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { query } from '../db/index.js';
import { createEvent } from '../services/event.service.js';
import type { User } from '@timemark/shared';
import { parseIcsEvents } from '../utils/ics-parser.js';

const calendarImport = new Hono<{ Variables: { user: User } }>();
calendarImport.use('*', authMiddleware);

calendarImport.post('/import-ics', async (c) => {
  const user = c.get('user');
  const body = await c.req.text();
  if (!body || body.length > 2_000_000) {
    return c.json({ success: false, error: 'ICS 文件过大或为空' }, 400);
  }

  const parsed = parseIcsEvents(body);
  if (!parsed.length) {
    return c.json({ success: false, error: '未解析到有效事件' }, 400);
  }

  let imported = 0;
  const errors: string[] = [];
  for (const ev of parsed.slice(0, 200)) {
    try {
      await createEvent(user.id, {
        name: ev.name,
        type: 'other',
        date: ev.date,
        calendarType: 'gregorian',
        reminderConfig: {
          enabled: true,
          daysBeforeList: [1, 3, 7],
          emailRecipients: [],
          channels: [],
          accountIds: [],
        },
      });
      imported++;
    } catch (e) {
      errors.push(ev.name);
    }
  }

  return c.json({ success: true, data: { imported, total: parsed.length, errors } });
});

/** Token-based WebCal subscribe URL helper */
calendarImport.get('/webcal-url', async (c) => {
  const user = c.get('user');
  const row = await query(
    'SELECT calendar_feed_token FROM user_configs WHERE user_id = $1',
    [Number(user.id)],
  );
  const token = row.rows[0]?.calendar_feed_token as string | undefined;
  const host = c.req.header('Host') || 'localhost';
  const protocol = c.req.header('X-Forwarded-Proto') || 'https';
  const feedPath = token ? `/api/calendar/feed/${token}.ics` : '/api/calendar/export.ics';
  return c.json({
    success: true,
    data: {
      webcalUrl: `webcal://${host}${feedPath}`,
      httpsUrl: `${protocol}://${host}${feedPath}`,
      usesToken: !!token,
    },
  });
});

calendarImport.get('/integrations', async (c) => {
  const user = c.get('user');
  const row = await query(
    `SELECT webhook_inbound_token, calendar_feed_token, external_calendar_urls
     FROM user_configs WHERE user_id = $1`,
    [Number(user.id)],
  );
  const r = row.rows[0] || {};
  const host = c.req.header('Host') || 'localhost';
  const protocol = c.req.header('X-Forwarded-Proto') || 'https';
  const webhookToken = r.webhook_inbound_token as string | undefined;
  const feedToken = r.calendar_feed_token as string | undefined;
  return c.json({
    success: true,
    data: {
      webhookUrl: webhookToken ? `${protocol}://${host}/api/webhook/receive/${webhookToken}` : null,
      calendarFeedUrl: feedToken ? `${protocol}://${host}/api/calendar/feed/${feedToken}.ics` : null,
      externalCalendarUrls: Array.isArray(r.external_calendar_urls) ? r.external_calendar_urls : [],
    },
  });
});

calendarImport.post('/integrations', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const urls = Array.isArray(body.externalCalendarUrls)
    ? body.externalCalendarUrls.map((u: unknown) => String(u).trim()).filter(Boolean).slice(0, 5)
    : undefined;
  if (urls) {
    await query(
      `INSERT INTO user_configs (user_id, external_calendar_urls)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (user_id) DO UPDATE SET external_calendar_urls = $2::jsonb`,
      [Number(user.id), JSON.stringify(urls)],
    );
  }
  return c.json({ success: true });
});

calendarImport.post('/sync-external', async (c) => {
  const user = c.get('user');
  const { syncExternalCalendarsForUser } = await import('../services/calendar-sync.service.js');
  const result = await syncExternalCalendarsForUser(Number(user.id));
  return c.json({ success: true, data: result });
});

export default calendarImport;
