import { query } from '../../db/index.js';
import { dateStringInTimeZone } from '@timemark/shared/habit-schedule';
import { createEvent } from '../event.service.js';
import { markTodoComplete } from '../todo.service.js';
import { getTodayDoses } from '../medication.service.js';
import { listUpcomingExpiryItems } from '../expiry.service.js';
import { listHabits } from '../habit.service.js';
import { listProfiles } from '../profile.service.js';
import { getUserConfig } from '../config.service.js';
import type {
  BotAddInput,
  BotAddResult,
  BotDataProvider,
  BotDoseItem,
  BotExpiryItem,
  BotHabitItem,
  BotPendingItem,
  BotProfileItem,
  BotSettings,
} from './dispatcher.js';

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

  async snoozeTodo(userId: number, eventId: number, minutes: number): Promise<void> {
    // Shift the next fire time forward; the canonical event date is left untouched so the
    // snooze is reversible and never corrupts the schedule.
    await query(
      `UPDATE events
       SET next_occurrence = COALESCE(next_occurrence, date::timestamp) + ($2::int * INTERVAL '1 minute')
       WHERE id = $1 AND user_id = $3`,
      [eventId, minutes, userId],
    );
  },

  async listTodayDoses(userId: number, profileId: number | null): Promise<BotDoseItem[]> {
    const doses = await getTodayDoses(userId, { profileId });
    return doses.map((dose) => ({
      id: dose.id,
      medicationName: dose.medication.name,
      scheduledFor: dose.scheduled_for,
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

  async setActiveProfile(_userId: number, _profileId: number | null): Promise<void> {
    // Checkbox 94 seam: once `bot_links` exists, persist `active_profile_id` there.
    // Until then switching is a no-op (the chat has no link row to update).
  },
};
