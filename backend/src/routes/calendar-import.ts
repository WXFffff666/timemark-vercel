import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { query } from '../db/index.js';
import { createEvent } from '../services/event.service.js';
import type { User } from '@timemark/shared';

const calendarImport = new Hono<{ Variables: { user: User } }>();
calendarImport.use('*', authMiddleware);

/** Parse minimal ICS VEVENT blocks into events */
function parseIcsEvents(icsText: string): Array<{ name: string; date: string; description?: string }> {
  const events: Array<{ name: string; date: string; description?: string }> = [];
  const blocks = icsText.split(/BEGIN:VEVENT/i);
  for (const block of blocks.slice(1)) {
    const summary = block.match(/SUMMARY[^:]*:(.+)/i)?.[1]?.trim();
    const dtstart = block.match(/DTSTART[^:]*:(\d{8})/i)?.[1];
    const desc = block.match(/DESCRIPTION[^:]*:(.+)/i)?.[1]?.trim();
    if (!summary || !dtstart) continue;
    const date = `${dtstart.slice(0, 4)}-${dtstart.slice(4, 6)}-${dtstart.slice(6, 8)}`;
    events.push({ name: summary.replace(/\\n/g, ' '), date, description: desc });
  }
  return events;
}

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
  const host = c.req.header('Host') || 'localhost';
  const protocol = c.req.header('X-Forwarded-Proto') || 'https';
  return c.json({
    success: true,
    data: {
      webcalUrl: `webcal://${host}/api/calendar/export.ics`,
      httpsUrl: `${protocol}://${host}/api/calendar/export.ics`,
    },
  });
});

export default calendarImport;
