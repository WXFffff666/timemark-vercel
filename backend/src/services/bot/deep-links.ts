/**
 * Deep links into the web app (checkbox 95).
 *
 * The base URL comes from `APP_BASE_URL` - the same variable `routes/bot.ts` uses for the
 * webhook URL. When it is not configured (or is not a usable http(s) URL) every builder
 * returns `null`, and the caller omits the link entirely: a relative or broken URL is
 * worse than no link.
 */

/** Resolve the configured app base URL, or null when unset/invalid. */
export function getAppBaseUrl(): string | null {
  const raw = process.env.APP_BASE_URL;
  if (!raw) return null;
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s]+$/i.test(trimmed)) return null;
  return trimmed;
}

function appUrl(path: string): string | null {
  const base = getAppBaseUrl();
  return base === null ? null : `${base}${path}`;
}

/** `/todos#item-<id>` - the pending-items list, scrolled to one row. */
export function todoDeepLink(eventId: number): string | null {
  return appUrl(`/todos#item-${eventId}`);
}

/** `/expiry#<id>` - the expiry centre, scrolled to one item. */
export function expiryDeepLink(itemId: number): string | null {
  return appUrl(`/expiry#${itemId}`);
}

/** `/medications` - today's medication page. */
export function medicationsDeepLink(): string | null {
  return appUrl('/medications');
}
