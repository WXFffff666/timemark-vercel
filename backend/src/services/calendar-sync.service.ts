import { query } from '../db/index.js';
import { createEvent } from './event.service.js';
import { parseIcsEvents } from '../utils/ics-parser.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('calendar-sync');

async function fetchIcsText(url: string): Promise<string> {
  const normalized = url.replace(/^webcal:\/\//i, 'https://');
  const res = await fetch(normalized, {
    headers: { 'User-Agent': 'TimeMark/2.12 CalendarSync' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export async function syncExternalCalendarsForUser(userId: number): Promise<{ imported: number; errors: string[] }> {
  const cfg = await query(
    'SELECT external_calendar_urls FROM user_configs WHERE user_id = $1',
    [userId],
  );
  const raw = cfg.rows[0]?.external_calendar_urls;
  const urls: string[] = Array.isArray(raw)
    ? raw.filter((u): u is string => typeof u === 'string' && u.length > 0)
    : [];

  let imported = 0;
  const errors: string[] = [];

  for (const url of urls.slice(0, 5)) {
    try {
      const ics = await fetchIcsText(url);
      const parsed = parseIcsEvents(ics);
      for (const ev of parsed.slice(0, 100)) {
        const dup = await query(
          `SELECT id FROM events WHERE user_id = $1 AND name = $2 AND date::text LIKE $3 || '%' LIMIT 1`,
          [userId, ev.name, ev.date],
        );
        if (dup.rows.length) continue;

        await createEvent(String(userId), {
          name: ev.name,
          type: 'other',
          date: ev.date,
          calendarType: 'gregorian',
          reminderConfig: {
            enabled: false,
            daysBeforeList: [],
            emailRecipients: [],
            channels: [],
            accountIds: [],
          },
        });
        imported++;
      }
    } catch (e) {
      errors.push(`${url}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { imported, errors };
}

export async function syncAllExternalCalendars(): Promise<void> {
  const users = await query(
    `SELECT user_id FROM user_configs
     WHERE external_calendar_urls IS NOT NULL
       AND jsonb_array_length(external_calendar_urls) > 0`,
  );
  for (const row of users.rows as Array<{ user_id: number }>) {
    try {
      const r = await syncExternalCalendarsForUser(row.user_id);
      if (r.imported > 0) {
        log.info({ userId: row.user_id, imported: r.imported }, 'External calendar sync');
      }
    } catch (e) {
      log.warn({ userId: row.user_id, err: e }, 'Calendar sync failed');
    }
  }
}
