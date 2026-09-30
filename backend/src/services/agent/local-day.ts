/**
 * User-local calendar-day helpers shared by the tasks 153/154/155 services.
 *
 * Pure: no DB and no user config access. The caller resolves the IANA timezone
 * (the routes reuse the existing `getUserTimezone()` plumbing from
 * services/agent/routines/routine.ts, which defaults to Asia/Shanghai).
 */

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidYmd(value: unknown): value is string {
  if (typeof value !== 'string' || !YMD_RE.test(value)) return false;
  return Number.isFinite(Date.parse(`${value}T00:00:00Z`));
}

/** The user-local calendar day (YYYY-MM-DD) for an instant + IANA timezone. */
export function ymdFromInstant(instant: Date, timezone?: string | null): string {
  if (timezone) {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(instant);
    } catch {
      // Unknown timezone: fall back to UTC rather than throwing mid-request.
    }
  }
  return instant.toISOString().slice(0, 10);
}

/** Alias kept parallel to the routine helper with the same name. */
export const localDateIn = ymdFromInstant;

export function addDaysYmd(ymd: string, days: number): string {
  const base = new Date(`${ymd}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/** Signed calendar-day difference: `to - from` (both YYYY-MM-DD). */
export function ymdDiffDays(fromYmd: string, toYmd: string): number {
  return Math.round(
    (Date.parse(`${toYmd}T00:00:00Z`) - Date.parse(`${fromYmd}T00:00:00Z`)) / 86_400_000,
  );
}

/** Monday of the week containing `ymd`. */
export function startOfWeekYmd(ymd: string): string {
  const date = new Date(`${ymd}T00:00:00Z`);
  const mondayOffset = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - mondayOffset);
  return date.toISOString().slice(0, 10);
}

function zoneOffsetMs(timezone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const get = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  let hour = get('hour');
  if (hour === 24) hour = 0;
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  return asUtc - at.getTime();
}

/**
 * UTC instant (ms) of local midnight for `ymd` in `timezone`. The offset is
 * resolved from the instant itself and iterated twice so DST transitions land
 * on the correct side; unknown timezones degrade to plain UTC midnight.
 */
export function localMidnightMs(ymd: string, timezone: string): number {
  const base = Date.parse(`${ymd}T00:00:00Z`);
  let guess = base;
  for (let i = 0; i < 2; i += 1) {
    guess = base - zoneOffsetMs(timezone, new Date(guess));
  }
  return guess;
}

/** pg DATE may arrive as a JS Date (local midnight) or a string; normalize to YYYY-MM-DD. */
export function toYmdString(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) {
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${value.getFullYear()}-${month}-${day}`;
  }
  return null;
}

/** pg TIMESTAMPTZ arrives as a JS Date; normalize to an ISO string. */
export function toIsoString(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
