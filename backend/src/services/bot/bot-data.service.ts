import { query } from '../../db/index.js';
import { dateStringInTimeZone } from '@timemark/shared/habit-schedule';
import { createEvent } from '../event.service.js';
import { markTodoComplete } from '../todo.service.js';
import { getMedicationTimezone, getTodayDoses } from '../medication.service.js';
import { listUpcomingExpiryItems } from '../expiry.service.js';
import { listHabits } from '../habit.service.js';
import { listProfiles } from '../profile.service.js';
import { getUserConfig, saveUserConfig } from '../config.service.js';
import { refreshUserEventCache } from '../event-cache.service.js';
import { setBotLinkActiveProfile } from './linking.service.js';
import type {
  BotAddInput,
  BotAddResult,
  BotDataProvider,
  BotDoseItem,
  BotExpiryItem,
  BotHabitItem,
  BotPendingItem,
  BotProfileItem,
  BotQuietHoursWriter,
  BotSettings,
  BotSnoozeResult,
} from './dispatcher.js';
import type { BotCallbackProvider, BotTodoLookup } from './callback-handler.js';

/**
 * Local `HH:mm` of an absolute instant in an IANA timezone ('' when unparseable).
 *
 * Exists because `medication.service.ts` serialises `scheduled_for` with `toISOString()`
 * (UTC), so slicing the ISO string would render the UTC clock, not the user's clock
 * (defect D4). Kept local to this file: `shared/` is frozen for the D1 date-helper lane.
 */
function hhmmInTimeZone(iso: string, timeZone: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(ms));
}

/** User timezone (with the same default fallback the reminder job uses). */
async function resolveUserTimezone(userId: number): Promise<string> {
  const config = (await getUserConfig(userId)) as Record<string, unknown> | null;
  return typeof config?.timezone === 'string' && config.timezone ? config.timezone : 'Asia/Shanghai';
}

/**
 * Default BotDataProvider implementation backed by the real services (checkbox 92).
 *
 * The dispatcher only ever sees this through the `BotDataProvider` interface, so tests can
 * inject a stub. `/list` ordering is explicit and deterministic: `date ASC, id ASC`.
 */

function daysBetweenYmd(fromYmd: string, toYmd: string): number {
  const from = Date.UTC(Number(fromYmd.slice(0, 4)), Number(fromYmd.slice(5, 7)) - 1, Number(fromYmd.slice(8, 10)));
  const to = Date.UTC(Number(toYmd.slice(0, 4)), Number(toYmd.slice(5, 7)) - 1, Number(toYmd.slice(8, 10)));
  return Math.round((to - from) / 86_400_000);
}

export async function listPendingItems(
  userId: number,
  profileId: number | null,
): Promise<BotPendingItem[]> {
  // Deterministic ordering: earliest occurrence first, then id. Completed occurrences are
  // excluded so `/done <n>` and `/list` agree on the same index positions.
  const result = await query(
    `SELECT e.id, e.name, e.date::text AS date
     FROM events e
     WHERE e.user_id = $1
       AND ($2::int IS NULL OR e.profile_id = $2)
       AND NOT EXISTS (
         SELECT 1 FROM todo_completions tc
         WHERE tc.user_id = e.user_id AND tc.event_id = e.id AND tc.occurrence_date = e.date::date
       )
     ORDER BY e.date ASC, e.id ASC
     LIMIT 100`,
    [userId, profileId],
  );
  return result.rows.map((row) => ({
    eventId: Number(row.id),
    title: String(row.name ?? ''),
    date: String(row.date ?? '').slice(0, 10),
  }));
}

/** Look up a todo (event) by id for an inline-button callback, including its completion state. */
export async function findTodoForCallback(userId: number, eventId: number): Promise<BotTodoLookup | null> {
  // The completion flag is read from `todo_completions` (the same store `listPendingItems`
  // filters on), which is what makes a repeated "done" tap a no-op instead of a second row.
  const result = await query(
    `SELECT e.id, e.name, e.date::text AS date,
            EXISTS (
              SELECT 1 FROM todo_completions tc
              WHERE tc.user_id = e.user_id AND tc.event_id = e.id AND tc.occurrence_date = e.date::date
            ) AS completed
     FROM events e
     WHERE e.user_id = $1 AND e.id = $2`,
    [userId, eventId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    eventId: Number(row.id),
    title: String(row.name ?? ''),
    date: String(row.date ?? '').slice(0, 10),
    completed: row.completed === true,
  };
}

export const defaultBotDataProvider: BotDataProvider = {
  listPending: listPendingItems,

  async addItem(userId: number, _profileId: number | null, input: BotAddInput): Promise<BotAddResult> {
    const event = await createEvent(String(userId), {
      name: input.title,
      type: 'other',
      date: input.date,
      calendarType: 'gregorian',
      reminderConfig: {
        enabled: true,
        daysBeforeList: [1, 3, 7],
        emailRecipients: [],
        channels: [],
        accountIds: [],
      },
    });
    return { eventId: Number(event.id), title: input.title, date: input.date, time: input.time };
  },

  async completeTodo(userId: number, eventId: number, occurrenceDate: string): Promise<void> {
    await markTodoComplete(userId, eventId, occurrenceDate);
  },

  async snoozeTodo(userId: number, eventId: number, minutes: number): Promise<BotSnoozeResult> {
    // Checkbox 97 (defect D2). `events.next_occurrence` is a DATE column, so a minute-level
    // increment is truncated on write and the old UPDATE silently stored the same day.
    // The explicit deadline therefore lives in `events.snoozed_until` (migration v51):
    //
    //   semantics: snoozed_until = NOW() + N minutes - i.e. N minutes FROM THE REQUEST
    //   INSTANT, not from the original target time. A repeated tap re-arms the deadline
    //   from its own request time instead of compounding; the reminder job fires once when
    //   the deadline enters its ±2-minute window and suppresses the event until then.
    //
    // `date` / `next_occurrence` are deliberately NOT touched: they stay canonical, the
    // snooze stays reversible, and the schedule can never be corrupted by it.
    const result = await query(
      `UPDATE events
          SET snoozed_until = NOW() + ($3::int * INTERVAL '1 minute')
        WHERE id = $1 AND user_id = $2
        RETURNING snoozed_until`,
      [eventId, userId, minutes],
    );
    const raw = result.rows[0]?.snoozed_until;
    const snoozedUntil = raw instanceof Date ? raw.toISOString() : typeof raw === 'string' ? raw : null;
    if (!snoozedUntil) return { status: 'not_found' };
    // Refresh the cron's cached payload so the deadline is honoured on the very next tick
    // (the cache is what `sendReminders` reads for a warm user). Best-effort: a failed
    // refresh must never turn a persisted snooze into a failed command.
    await refreshUserEventCache(userId).catch(() => undefined);
    return {
      status: 'ok',
      snoozedUntil,
      localTime: hhmmInTimeZone(snoozedUntil, await resolveUserTimezone(userId)),
    };
  },

  async listTodayDoses(userId: number, profileId: number | null): Promise<BotDoseItem[]> {
    const doses = await getTodayDoses(userId, { profileId });
    // Doses are materialised in the profile-or-user timezone (medication.service
    // `getMedicationTimezone`), so render the local clock in that SAME timezone - the
    // previous `slice(11, 16)` on the UTC ISO string showed 01:00 for a 09:00 (+08) dose.
    const timezone = await getMedicationTimezone(userId, profileId);
    return doses.map((dose) => ({
      id: dose.id,
      medicationName: dose.medication.name,
      scheduledFor: dose.scheduled_for,
      localTime: hhmmInTimeZone(dose.scheduled_for, timezone),
      status: dose.status,
    }));
  },

  async listExpiring(userId: number, days: number, profileId: number | null): Promise<BotExpiryItem[]> {
    const items = await listUpcomingExpiryItems(userId, days);
    const config = (await getUserConfig(userId)) as Record<string, unknown> | null;
    const timezone = typeof config?.timezone === 'string' && config.timezone ? config.timezone : 'Asia/Shanghai';
    const today = dateStringInTimeZone(new Date(), timezone);
    return items
      .filter((item) => profileId === null || item.profile_id === profileId)
      .map((item) => ({
        id: item.id,
        title: item.title,
        expiresOn: item.next_due_date,
        daysUntil: item.next_due_date ? daysBetweenYmd(today, item.next_due_date) : null,
      }));
  },

  async listHabits(userId: number, profileId: number | null): Promise<BotHabitItem[]> {
    const habits = await listHabits(userId, { active: true, profileId });
    return habits.map((habit) => ({
      id: habit.id,
      name: habit.name,
      currentStreak: habit.streak.current,
      targetMet: habit.streak.targetMet,
    }));
  },

  async listProfiles(userId: number): Promise<BotProfileItem[]> {
    const profiles = await listProfiles(userId, { active: true });
    return profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      isDefault: profile.kind === 'self',
    }));
  },

  async getSettings(userId: number): Promise<BotSettings> {
    const config = (await getUserConfig(userId)) as Record<string, unknown> | null;
    const timezone = typeof config?.timezone === 'string' && config.timezone ? config.timezone : 'Asia/Shanghai';
    const quietHoursStart = typeof config?.quiet_hours_start === 'string' ? config.quiet_hours_start : null;
    const quietHoursEnd = typeof config?.quiet_hours_end === 'string' ? config.quiet_hours_end : null;
    return {
      timezone,
      quietHoursStart,
      quietHoursEnd,
      remindersEnabled: config?.reminders_enabled !== false,
      digestEnabled: config?.digest_enabled !== false,
    };
  },

  async setActiveProfile(userId: number, profileId: number | null, chat) {
    // Checkbox 97 (defect D3): checkbox 94 DID create `bot_links`, so the switch must
    // persist on the caller's link row - the empty seam is gone. The target profile is
    // validated (belongs to the user AND is active) inside the same atomic statement that
    // writes the row, and a missing/revoked link is reported distinctly instead of claiming
    // success. The next message's `resolveActingChatContext` then scopes /list & friends.
    if (profileId == null || !Number.isInteger(profileId) || profileId <= 0) return 'invalid_profile';
    return setBotLinkActiveProfile({
      platform: chat.platform,
      chatId: chat.chatId,
      userId,
      profileId,
    });
  },
};

/** Callback-action data seam (checkbox 93): reuses the same provider for complete/snooze. */
export const defaultBotCallbackProvider: BotCallbackProvider = {
  ...defaultBotDataProvider,
  findTodo: findTodoForCallback,
};

/**
 * `/quiet` writer (checkbox 95): persists through the EXISTING `quiet_hours_start` /
 * `quiet_hours_end` user-config columns - the same pair `sendNotifications` reads before
 * dispatching (`isInQuietHours`). No parallel setting is introduced.
 */
export const defaultBotQuietHoursWriter: BotQuietHoursWriter = async (userId, start, end) => {
  await saveUserConfig(userId, { quiet_hours_start: start, quiet_hours_end: end });
};
