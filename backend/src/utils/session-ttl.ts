/**
 * The single source of truth for session lifetime.
 *
 * Five clocks used to govern this independently — the access cookie, the refresh
 * cookie, the access JWT, the refresh JWT, and `sessions.expires_at` — and they
 * disagreed. Notably the refresh JWT was always 30 days even for an 8-hour session,
 * and the access cookie was 1h while the access JWT was 15 minutes.
 *
 * Two user-visible modes:
 * - **not remembered** (default): browser-session cookies, an 8-hour server deadline.
 * - **remembered**: persistent cookies, a 30-day server deadline.
 *
 * `remember_me` travels on the signed refresh token, so a refresh never has to
 * re-derive the mode from the remaining lifetime — doing that silently downgraded a
 * 30-day session once it had less than 24h left.
 *
 * ponytail: absolute timeout only; there is no idle timeout. Adding one needs a
 * `sessions.last_active_at` column plus sliding renewal capped by these deadlines,
 * which is a migration and a behaviour change. OWASP wants both — see the note in
 * `session.service.ts`.
 */
export const SESSION_TTL = Object.freeze({
  /** Access token lifetime when the user did not ask to stay signed in. */
  accessShortSeconds: 15 * 60,
  /** Access token lifetime for a remembered session. */
  accessRememberSeconds: 60 * 60,
  /** Server-side session deadline when not remembered. */
  sessionShortSeconds: 8 * 60 * 60,
  /** Server-side session deadline for a remembered session (the "30 days" in the UI). */
  sessionRememberSeconds: 30 * 24 * 60 * 60,
  /** Hard ceiling for the refresh cookie, regardless of mode. */
  refreshCookieSeconds: 30 * 24 * 60 * 60,
});