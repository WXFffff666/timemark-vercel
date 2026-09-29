import type { AgentToolName, EventType, CalendarType } from '@timemark/shared';
import { dateStringInTimeZone } from '@timemark/shared/habit-schedule';
import { query } from '../../db/index.js';
import {
  createEvent,
  getEventsByUserIdPaginated,
  updateEvent,
  deleteEvent,
} from '../event.service.js';
import { markTodoComplete } from '../todo.service.js';
import { defaultBotDataProvider, listPendingItems } from '../bot/bot-data.service.js';
import { searchLocal } from '../search.service.js';
import { createExpiryItem, listUpcomingExpiryItems } from '../expiry.service.js';
import { createInteraction, listDueContacts } from '../contact-crm.service.js';
import { createDocument } from '../document.service.js';
import { getAdherence, getTodayDoses, logDose } from '../medication.service.js';
import { listHabits, logHabit } from '../habit.service.js';
import { listPatterns } from '../patterns.service.js';
import { sendDigestForUser } from '../digest.service.js';
import { getUserConfig } from '../config.service.js';

/**
 * Checkbox 102: the ONE place where a registry tool name (shared/src/agent-tools.ts) is bound
 * to an executable backend function. The dispatch service only ever looks a handler up HERE by
 * the registry name, so a client can never supply a handler name, a module path or an
 * arbitrary query/exec/command - the only inputs are the tool name and its typed arguments.
 *
 * Three registry bindings were marked `[planned]`; their thin adapters live here:
 *   - get_event  -> an ownership-checked single-row reader (no exported event.service getter)
 *   - get_today  -> an aggregator over pending todos + today's doses
 *   - get_week   -> the same aggregator over a 7-day window
 * Two other registry strings are stale (bot-data.service is really bot/bot-data.service and
 * `snoozeTodo` is a provider method); the adapter calls the real function.
 *
 * Every not-found/not-owned outcome maps to the same opaque 404 `目标已不存在` so a foreign id
 * is indistinguishable from a missing one (the SQL filters on user_id, so 403 would leak).
 */

export interface AgentToolContext {
  userId: number;
  args: Record<string, unknown>;
}

export type AgentToolResult =
  | { ok: true; data: unknown }
  | { ok: false; code: string; message: string; status: number };

export type AgentToolHandler = (ctx: AgentToolContext) => Promise<AgentToolResult>;

/** Opaque "the target is gone or was never yours" result - never reveals which. */
function notFound(): AgentToolResult {
  return { ok: false, code: 'target_not_found', message: '目标已不存在', status: 404 };
}

function ok(data: unknown): AgentToolResult {
  return { ok: true, data };
}

function invalid(message: string): AgentToolResult {
  return { ok: false, code: 'invalid_args', message, status: 400 };
}

function conflict(code: string, message: string): AgentToolResult {
  return { ok: false, code, message, status: 409 };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Calendar-day arithmetic on a plain YYYY-MM-DD at UTC midnight (never an instant slice). */
function addDaysYmd(ymd: string, days: number): string {
  const [year, month, day] = ymd.split('-').map((part) => Number(part));
  const dt = new Date(Date.UTC(year, (month ?? 1) - 1, day ?? 1));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

async function resolveTimezone(userId: number): Promise<string> {
  const config = (await getUserConfig(userId)) as Record<string, unknown> | null;
  return typeof config?.timezone === 'string' && config.timezone ? config.timezone : 'Asia/Shanghai';
}

export const AGENT_TOOL_HANDLERS: Readonly<Record<AgentToolName, AgentToolHandler>> = {
  async list_events({ userId, args }) {
    const limit = asNumber(args.limit) ?? 20;
    const type = asString(args.type);
    const from = asString(args.from);
    const to = asString(args.to);
    const page = await getEventsByUserIdPaginated(String(userId), limit, 0, null);
    const events = page.events.filter((event) => {
      const day = typeof event.date === 'string' ? event.date.slice(0, 10) : '';
      if (type && event.type !== type) return false;
      if (from && day < from) return false;
      if (to && day > to) return false;
      return true;
    });
    return ok({ events, total: page.total });
  },

  async get_event({ userId, args }) {
    const eventId = asNumber(args.eventId);
    if (eventId === undefined) return invalid('eventId is required');
    const result = await query(
      `SELECT id, name, type, date::text AS date, calendar_type, person_name, next_occurrence
       FROM events WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [eventId, userId],
    );
    const row = result.rows[0];
    if (!row) return notFound();
    return ok(row);
  },

  async create_event({ userId, args }) {
    const name = asString(args.name);
    const date = asString(args.date);
    if (!name || !date) return invalid('name and date are required');
    const type = (asString(args.type) ?? 'other') as EventType;
    const calendarType = (asString(args.calendarType) ?? 'gregorian') as CalendarType;
    const personName = asString(args.personName) ?? null;
    const event = await createEvent(String(userId), {
      name,
      date,
      type,
      calendarType,
      reminderConfig: {
        enabled: true,
        daysBeforeList: [1, 3, 7],
        emailRecipients: [],
        channels: [],
        accountIds: [],
      },
      personName,
    });
    return ok(event);
  },

  async update_event({ userId, args }) {
    const eventId = asNumber(args.eventId);
    if (eventId === undefined) return invalid('eventId is required');
    const data: Parameters<typeof updateEvent>[2] = {};
    const name = asString(args.name);
    const date = asString(args.date);
    const type = asString(args.type);
    const personName = asString(args.personName);
    if (name !== undefined) data.name = name;
    if (date !== undefined) data.date = date;
    if (type !== undefined) data.type = type;
    if (personName !== undefined) data.personName = personName;
    const updated = await updateEvent(String(eventId), String(userId), data);
    if (!updated) return notFound();
    return ok({ eventId, updated: true });
  },

  async delete_event({ userId, args }) {
    const eventId = asNumber(args.eventId);
    if (eventId === undefined) return invalid('eventId is required');
    const deleted = await deleteEvent(String(eventId), String(userId));
    if (!deleted) return notFound();
    return ok({ eventId, deleted: true });
  },

  async complete_todo({ userId, args }) {
    const eventId = asNumber(args.eventId);
    if (eventId === undefined) return invalid('eventId is required');
    // `markTodoComplete` is a blind upsert (no ownership check) - pre-verify the event so a
    // foreign or already-deleted id is a 404 instead of a silent completion row.
    const owner = await query(
      `SELECT id, date::text AS date FROM events WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [eventId, userId],
    );
    const row = owner.rows[0] as { id: number; date: string } | undefined;
    if (!row) return notFound();
    const occurrenceDate = asString(args.occurrenceDate) ?? String(row.date);
    await markTodoComplete(userId, eventId, occurrenceDate);
    return ok({ eventId, occurrenceDate, completed: true });
  },

  async snooze_reminder({ userId, args }) {
    const eventId = asNumber(args.eventId);
    const minutes = asNumber(args.minutes);
    if (eventId === undefined || minutes === undefined) return invalid('eventId and minutes are required');
    const result = await defaultBotDataProvider.snoozeTodo(userId, eventId, minutes);
    if (result.status === 'not_found') return notFound();
    return ok(result);
  },

  async list_upcoming({ userId, args }) {
    const days = asNumber(args.days) ?? 7;
    const tz = await resolveTimezone(userId);
    const today = dateStringInTimeZone(new Date(), tz);
    const horizon = addDaysYmd(today, days);
    const items = await listPendingItems(userId, null);
    const windowed = items.filter((item) => item.date >= today && item.date <= horizon);
    return ok({ days, items: windowed });
  },

  async search({ userId, args }) {
    const text = asString(args.text);
    if (!text) return invalid('text is required');
    const limit = asNumber(args.limit);
    const hits = await searchLocal(userId, text, limit ? { limit } : {});
    return ok({ hits });
  },

  async list_expiry({ userId, args }) {
    const days = asNumber(args.days) ?? 30;
    const items = await listUpcomingExpiryItems(userId, days);
    return ok({ days, items });
  },

  async create_expiry({ userId, args }) {
    const title = asString(args.title);
    const nextDueDate = asString(args.nextDueDate);
    if (!title || !nextDueDate) return invalid('title and nextDueDate are required');
    const kind = asString(args.kind);
    const cycle = asString(args.cycle);
    const vendor = asString(args.vendor);
    const amountCents = asNumber(args.amountCents);
    const input: Parameters<typeof createExpiryItem>[1] = {
      title,
      nextDueDate,
      kind: (kind ?? 'custom') as Parameters<typeof createExpiryItem>[1]['kind'],
      cycle: cycle as Parameters<typeof createExpiryItem>[1]['cycle'],
      vendor: vendor ?? null,
      amountCents: amountCents ?? null,
    };
    const item = await createExpiryItem(userId, input);
    return ok(item);
  },

  async log_interaction({ userId, args }) {
    const contactId = asNumber(args.contactId);
    const kind = asString(args.kind);
    if (contactId === undefined || !kind) return invalid('contactId and kind are required');
    const input: Parameters<typeof createInteraction>[2] = {
      kind: kind as Parameters<typeof createInteraction>[2]['kind'],
      summary: asString(args.summary) ?? null,
      occurredAt: asString(args.occurredAt),
    };
    const row = await createInteraction(userId, contactId, input);
    if (!row) return notFound();
    return ok(row);
  },

  async list_contacts_due({ userId, args }) {
    const withinDays = asNumber(args.withinDays) ?? 30;
    const contacts = await listDueContacts(userId);
    return ok({ withinDays, contacts });
  },

  async create_document({ userId, args }) {
    const title = asString(args.title);
    const kind = asString(args.kind);
    if (!title || !kind) return invalid('title and kind are required');
    const issuer = asString(args.issuer);
    const country = asString(args.country);
    const expiresAt = asString(args.expiresAt);
    const record = await createDocument(userId, {
      title,
      kind: kind as Parameters<typeof createDocument>[1]['kind'],
      issuer,
      country,
      expiresAt,
    });
    // Never echo `document_number_encrypted`; only the non-secret metadata leaves this module.
    return ok({
      id: record.id,
      title: record.title,
      kind: record.kind,
      issuer: record.issuer,
      expiresAt: record.expires_at,
    });
  },

  async log_dose({ userId, args }) {
    const doseId = asNumber(args.doseId);
    const status = asString(args.status);
    if (doseId === undefined || (status !== 'taken' && status !== 'skipped')) {
      return invalid('doseId and status (taken|skipped) are required');
    }
    const result = await logDose(userId, doseId, { status, note: asString(args.note) ?? null });
    if (result.status === 'not_found') return notFound();
    if (result.status === 'future_dose') return conflict('future_dose', '该剂量尚未到时间，无法记录');
    return ok(result);
  },

  async get_adherence({ userId, args }) {
    const from = asString(args.from);
    const to = asString(args.to);
    if (!from || !to) return invalid('from and to are required');
    const report = await getAdherence(userId, from, to);
    return ok(report);
  },

  async log_habit({ userId, args }) {
    const habitId = asNumber(args.habitId);
    if (habitId === undefined) return invalid('habitId is required');
    const result = await logHabit(userId, habitId, {
      count: asNumber(args.count),
      loggedOn: asString(args.loggedOn),
      note: asString(args.note) ?? null,
    });
    if (result.status === 'not_found') return notFound();
    if (result.status === 'future_date') return conflict('future_date', '不能为未来日期打卡');
    return ok(result);
  },

  async get_habits({ userId, args }) {
    const active = asBoolean(args.active) ?? true;
    const habits = await listHabits(userId, { active });
    return ok({ habits });
  },

  async get_patterns({ userId, args }) {
    const minEvidence = asNumber(args.minEvidence) ?? 1;
    const patterns = await listPatterns(userId);
    const filtered = patterns.filter((pattern) => Number(pattern.evidence_count) >= minEvidence);
    return ok({ minEvidence, patterns: filtered });
  },

  async send_digest({ userId, args }) {
    const period = asString(args.period);
    if (period !== 'monthly' && period !== 'yearly') return invalid('period must be monthly or yearly');
    const result = await sendDigestForUser(userId, period);
    return ok(result);
  },

  async get_today({ userId, args }) {
    const includeCompleted = asBoolean(args.includeCompleted) ?? false;
    const tz = await resolveTimezone(userId);
    const today = dateStringInTimeZone(new Date(), tz);
    const pending = await listPendingItems(userId, null);
    const doses = await getTodayDoses(userId, { profileId: null });
    return ok({
      date: today,
      events: pending.filter((item) => item.date === today),
      doses,
      includeCompleted,
    });
  },

  async get_week({ userId, args }) {
    const includeCompleted = asBoolean(args.includeCompleted) ?? false;
    const tz = await resolveTimezone(userId);
    const today = dateStringInTimeZone(new Date(), tz);
    const horizon = addDaysYmd(today, 7);
    const pending = await listPendingItems(userId, null);
    return ok({
      from: today,
      to: horizon,
      events: pending.filter((item) => item.date >= today && item.date <= horizon),
      includeCompleted,
    });
  },
};
