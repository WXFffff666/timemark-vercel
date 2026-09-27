import { Hono } from 'hono';
import {
  buildIcsCalendar,
  collectFeedItems,
  defaultIcsFeedName,
  getActiveIcsFeedByToken,
  touchIcsFeedAccess,
} from '../services/ics-feed.service.js';

const publicIcs = new Hono();

/**
 * Tokenised public ICS subscription feed (checkbox 89).
 * GET /api/public/ics/:token.ics
 *
 * - the raw token is compared by SHA-256 hash; unknown, revoked, too short or
 *   oversized tokens all return 404 (never data, never a 500)
 * - the calendar is regenerated on read, so revoking a feed takes effect on the
 *   very next request (no cached 200)
 * - only VEVENT summaries are exposed: no document numbers, notes or amounts
 */
publicIcs.get('/:file{.+\\.ics}', async (c) => {
  // The regex-constrained param captures the whole `name.ics` segment (a bare
  // `:token.ics` would make `token.ics` the param NAME in Hono). Strip the
  // suffix, then let the service length-check and hash-compare the raw token.
  const file = c.req.param('file') ?? '';
  const token = file.endsWith('.ics') ? file.slice(0, -4) : '';
  const feed = await getActiveIcsFeedByToken(token);
  if (!feed) {
    return c.text('Not found', 404);
  }

  const items = await collectFeedItems(feed.userId, feed.filter);
  const body = buildIcsCalendar(items, feed.name || defaultIcsFeedName(feed.filter));

  try {
    await touchIcsFeedAccess(feed.id);
  } catch (error) {
    // A failed access stamp must never withhold the calendar from a valid subscriber.
    console.error('[public-ics] last_access_at update failed:', error);
  }

  return new Response(body, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Cache-Control': 'private, max-age=300',
      'X-Robots-Tag': 'noindex',
    },
  });
});

export default publicIcs;
