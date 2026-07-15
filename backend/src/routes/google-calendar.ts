import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { query } from '../db/index.js';
import type { User } from '@timemark/shared';
import {
  isGoogleOAuthConfigured,
  getGoogleRedirectUri,
  buildOAuthState,
  verifyOAuthState,
  buildGoogleAuthUrl,
  exchangeCodeForTokens,
  encryptRefreshToken,
} from '../services/google-oauth.service.js';
import { syncGoogleCalendarForUser } from '../services/google-calendar-sync.service.js';

const googleCalendar = new Hono<{ Variables: { user: User } }>();

googleCalendar.get('/google-oauth/status', authMiddleware, async (c) => {
  const user = c.get('user');
  const row = await query(
    `SELECT google_oauth_email, google_calendar_id, google_oauth_connected_at
     FROM user_configs WHERE user_id = $1`,
    [Number(user.id)],
  );
  const r = row.rows[0] as {
    google_oauth_email?: string;
    google_calendar_id?: string;
    google_oauth_connected_at?: string;
  } | undefined;
  return c.json({
    success: true,
    data: {
      configured: isGoogleOAuthConfigured(),
      connected: !!r?.google_oauth_connected_at,
      email: r?.google_oauth_email || null,
      calendarId: r?.google_calendar_id || 'primary',
      connectedAt: r?.google_oauth_connected_at || null,
    },
  });
});

googleCalendar.get('/google-oauth/start', authMiddleware, async (c) => {
  if (!isGoogleOAuthConfigured()) {
    return c.json({ success: false, error: 'Google OAuth 未配置（需 GOOGLE_OAUTH_CLIENT_ID/SECRET）' }, 503);
  }
  const user = c.get('user');
  const protocol = c.req.header('X-Forwarded-Proto') || 'https';
  const host = c.req.header('Host') || 'localhost';
  const origin = `${protocol}://${host}`;
  const redirectUri = getGoogleRedirectUri(origin);
  const state = await buildOAuthState(Number(user.id));
  const authUrl = buildGoogleAuthUrl(state, redirectUri);
  return c.json({ success: true, data: { authUrl, redirectUri } });
});

googleCalendar.get('/google-oauth/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const oauthError = c.req.query('error');
  const protocol = c.req.header('X-Forwarded-Proto') || 'https';
  const host = c.req.header('Host') || 'localhost';
  const settingsUrl = `${protocol}://${host}/settings`;

  if (oauthError) {
    return c.redirect(`${settingsUrl}?google=error&reason=${encodeURIComponent(oauthError)}`);
  }
  if (!code || !state) {
    return c.redirect(`${settingsUrl}?google=error&reason=missing_params`);
  }

  const userId = await verifyOAuthState(state);
  if (!userId) {
    return c.redirect(`${settingsUrl}?google=error&reason=invalid_state`);
  }

  try {
    const origin = `${protocol}://${host}`;
    const redirectUri = getGoogleRedirectUri(origin);
    const tokens = await exchangeCodeForTokens(code, redirectUri);
    if (!tokens.refresh_token) {
      return c.redirect(`${settingsUrl}?google=error&reason=no_refresh_token`);
    }
    const enc = encryptRefreshToken(tokens.refresh_token);
    await query(
      `UPDATE user_configs SET
         google_oauth_refresh_token_encrypted = $1,
         google_oauth_email = $2,
         google_calendar_id = COALESCE(google_calendar_id, 'primary'),
         google_oauth_connected_at = CURRENT_TIMESTAMP
       WHERE user_id = $3`,
      [enc, tokens.email || null, userId],
    );
    return c.redirect(`${settingsUrl}?google=connected`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'oauth_failed';
    return c.redirect(`${settingsUrl}?google=error&reason=${encodeURIComponent(msg.slice(0, 120))}`);
  }
});

googleCalendar.delete('/google-oauth', authMiddleware, async (c) => {
  const user = c.get('user');
  await query(
    `UPDATE user_configs SET
       google_oauth_refresh_token_encrypted = NULL,
       google_oauth_email = NULL,
       google_oauth_connected_at = NULL
     WHERE user_id = $1`,
    [Number(user.id)],
  );
  return c.json({ success: true });
});

googleCalendar.post('/google-oauth/sync', authMiddleware, async (c) => {
  const user = c.get('user');
  const result = await syncGoogleCalendarForUser(Number(user.id));
  return c.json({ success: true, data: result });
});

export default googleCalendar;
