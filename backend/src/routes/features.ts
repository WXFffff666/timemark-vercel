import { Hono } from 'hono';
import { randomBytes } from 'crypto';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { query } from '../db/index.js';
import { getBlessing } from '@timemark/shared';
import { getRecommendedDaysBefore, getRecommendedDaysFromHistory } from '../services/recommendations.js';
import { getServerlessFeatureReport } from '../utils/serverless-suitability.js';
import type { User } from '@timemark/shared';

const features = new Hono<{ Variables: { user: User } }>();

features.get('/share/:token', async (c) => {
  const token = c.req.param('token');
  const result = await query(
    `SELECT name, type, date, calendar_type, person_name, tags
     FROM events WHERE share_token = $1 LIMIT 1`,
    [token],
  );
  if (result.rows.length === 0) {
    return c.json({ success: false, error: 'Not found' }, 404);
  }
  return c.json({ success: true, data: result.rows[0] });
});

features.use('*', authMiddleware);

features.get('/annual-report', async (c) => {
  const userId = Number(c.get('user').id);
  const year = parseInt(c.req.query('year') || String(new Date().getFullYear()), 10);

  const [events, triggers, channels, monthly, channelStats] = await Promise.all([
    query('SELECT COUNT(*)::int AS total FROM events WHERE user_id = $1', [userId]),
    query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'success')::int AS success,
              COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
       FROM event_trigger_logs WHERE user_id = $1 AND EXTRACT(YEAR FROM trigger_date) = $2`,
      [userId, year],
    ),
    query('SELECT COUNT(*)::int AS total FROM notification_accounts WHERE user_id = $1 AND is_active = TRUE', [userId]),
    query(
      `SELECT EXTRACT(MONTH FROM date)::int AS month, COUNT(*)::int AS count
       FROM events WHERE user_id = $1 AND EXTRACT(YEAR FROM date) = $2
       GROUP BY 1 ORDER BY 1`,
      [userId, year],
    ),
    query(
      `SELECT channel_type AS channel,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'success')::int AS success
       FROM event_trigger_logs
       WHERE user_id = $1 AND EXTRACT(YEAR FROM trigger_date) = $2 AND channel_type IS NOT NULL
       GROUP BY channel_type`,
      [userId, year],
    ),
  ]);

  const byType = await query(
    `SELECT type, COUNT(*)::int AS count FROM events WHERE user_id = $1 GROUP BY type ORDER BY count DESC`,
    [userId],
  );

  const heatmap = Array.from({ length: 12 }, (_, i) => {
    const month = i + 1;
    const found = monthly.rows.find((r: { month: number }) => Number(r.month) === month);
    return { month, count: found?.count ?? 0 };
  });

  return c.json({
    success: true,
    data: {
      year,
      totalEvents: events.rows[0]?.total ?? 0,
      notificationsSent: triggers.rows[0]?.total ?? 0,
      notificationsSuccess: triggers.rows[0]?.success ?? 0,
      notificationsFailed: triggers.rows[0]?.failed ?? 0,
      activeChannels: channels.rows[0]?.total ?? 0,
      eventsByType: byType.rows,
      monthlyHeatmap: heatmap,
      channelSuccessRates: channelStats.rows.map((r: { channel: string; total: number; success: number }) => ({
        channel: r.channel,
        total: r.total,
        success: r.success,
        rate: r.total > 0 ? Math.round((r.success / r.total) * 100) : 0,
      })),
    },
  });
});

features.get('/conflicts', async (c) => {
  const userId = Number(c.get('user').id);
  const result = await query(
    `SELECT date, COUNT(*)::int AS count, array_agg(name) AS names
     FROM events WHERE user_id = $1
     GROUP BY date HAVING COUNT(*) > 1
     ORDER BY date`,
    [userId],
  );
  return c.json({ success: true, data: result.rows });
});

features.get('/smart-days/:type', async (c) => {
  const type = c.req.param('type');
  const userId = Number(c.get('user').id);
  const fromHistory = await getRecommendedDaysFromHistory(userId, type);
  return c.json({ success: true, data: { daysBefore: fromHistory.length ? fromHistory : getRecommendedDaysBefore(type), source: fromHistory.length ? 'history' : 'preset' } });
});

features.get('/blessing', (c) => {
  const type = c.req.query('type') || 'birthday';
  const personName = c.req.query('personName') || undefined;
  const recipientName = c.req.query('recipientName') || undefined;
  const blessing = getBlessing(type, undefined, personName, recipientName);
  return c.json({ success: true, data: { blessing, source: 'preset' } });
});

features.get('/serverless-suitability', (c) => {
  return c.json({ success: true, data: { features: getServerlessFeatureReport() } });
});

features.get('/serverless-check', (c) => {
  return c.json({ success: true, data: { features: getServerlessFeatureReport() } });
});

features.post('/events/:id/share', async (c) => {
  const userId = Number(c.get('user').id);
  const eventId = parseInt(c.req.param('id'), 10);
  if (isNaN(eventId)) return c.json({ success: false, error: 'Invalid event ID' }, 400);

  const token = randomBytes(16).toString('hex');
  const result = await query(
    `UPDATE events SET share_token = $1 WHERE id = $2 AND user_id = $3 RETURNING id, share_token`,
    [token, eventId, userId],
  );
  if (result.rows.length === 0) {
    return c.json({ success: false, error: 'Event not found' }, 404);
  }
  return c.json({ success: true, data: { shareToken: token } });
});

export default features;
