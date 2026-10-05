/**
 * Agent tool registry — the SINGLE source of truth for every tool exposed by the
 * in-app assistant (checkbox 101), the tool API (checkbox 102) and the MCP server
 * (checkbox 103). Defined exactly once here (checkbox 100); nothing in this module
 * executes, routes or wires anything - `handler` is a STRING binding reference only.
 *
 * Contract per entry (`AgentToolDefinition`):
 *   - `description` MUST state WHEN to call the tool (checkers both here and in the
 *     assistant pick tools from the description alone).
 *   - `inputSchema` is a NARROW, typed Zod object (`z.strictObject`, so unknown keys are
 *     rejected, not stripped) and MUST reject `{}` — every tool has at least one
 *     required parameter.
 *   - `requiredScope` is least-privilege: reads use a `*:read` scope, mutations their own
 *     narrower scope, `delete_event` the most restrictive scope in the registry.
 *   - `destructive` marks irreversible tools; `requiresConfirmation` marks tools the
 *     executor must confirm with the user before running.
 *
 * Security invariant (enforced by backend/src/test/agent-tools.test.ts): NO tool may
 * accept a free-form `sql` / `exec` / `command` / `url` / `query` field, at any depth.
 * An omnibus query/exec tool is the top MCP anti-pattern; each capability stays a
 * separate, narrowly typed tool.
 *
 * `handler` binding convention: `<module>.<exportedFunction>` where `<module>` is the
 * backend source file without extension, e.g. `event.service` maps to
 * `backend/src/services/event.service.ts`. Three bindings are marked [planned]: no single
 * exported function exists yet and task 102 must create exactly this thin wrapper:
 *   - get_event -> `event.service.getEventById` (single-row reader)
 *   - get_today -> `assistant.service.getToday` (aggregator over events/todos/doses)
 *   - get_week  -> `assistant.service.getWeek`  (same aggregator, 7-day window)
 *
 * Calendar-day output rule (hard-won lesson, see .omo/notepads/timemark-vercel-expansion/
 * issues.md): executors MUST resolve calendar days with `dateStringInTimeZone` /
 * `toYmdString` — NEVER by slicing a UTC ISO string. This module only declares metadata.
 */

import { z } from 'zod';
import { EXPIRY_CYCLES, EXPIRY_KINDS } from './types/expiry.js';
import { DOCUMENT_KINDS } from './types/documents.js';
import { INTERACTION_KINDS } from './types/crm.js';
import { LOGGABLE_DOSE_STATUSES } from './types/medications.js';
import type { EventType } from './types/event.types.js';

/** Calendar-day literal accepted by every date parameter. */
const ymdSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be a real calendar day in YYYY-MM-DD form');

/** Numeric primary key; ids are never guessed by the model. */
const idSchema = z.number().int().positive();

/**
 * Event types — mirrors `EventType` from shared/src/types/event.types.ts (the existing
 * `createEventSchema` duplicates the same literal list; the `satisfies` clause keeps this
 * copy compile-time aligned with the type).
 */
const EVENT_TYPE_VALUES = [
  'birthday',
  'exam',
  'anniversary',
  'holiday',
  'meeting',
  'deadline',
  'travel',
  'graduation',
  'wedding',
  'medical',
  'other',
] as const satisfies readonly EventType[];

const eventTypeSchema = z.enum(EVENT_TYPE_VALUES);
const calendarTypeSchema = z.enum(['gregorian', 'lunar', 'both']);
const expiryKindSchema = z.enum(EXPIRY_KINDS);
const expiryCycleSchema = z.enum(EXPIRY_CYCLES);
const documentKindSchema = z.enum(DOCUMENT_KINDS);
const interactionKindSchema = z.enum(INTERACTION_KINDS);
const doseStatusSchema = z.enum(LOGGABLE_DOSE_STATUSES);
const digestPeriodSchema = z.enum(['monthly', 'yearly']);

/**
 * Canonical scope set. Reads use `*:read`; mutations use their own narrow scope;
 * `events:delete` is the only `*:delete` scope and is therefore the most restrictive.
 */
export const AGENT_TOOL_SCOPES = [
  'assistant:read',
  'events:read',
  'events:write',
  'events:delete',
  'todos:read',
  'todos:write',
  'reminders:snooze',
  'expiry:read',
  'expiry:write',
  'contacts:read',
  'contacts:write',
  'documents:write',
  'health:read',
  'health:write',
  'habits:read',
  'habits:write',
  'patterns:read',
  'search:read',
  'digest:send',
] as const;

export type AgentToolScope = (typeof AGENT_TOOL_SCOPES)[number];

/** The documented tool list (task 100). The registry MUST match it exactly. */
export const DOCUMENTED_AGENT_TOOL_NAMES = [
  'list_events',
  'get_event',
  'create_event',
  'update_event',
  'delete_event',
  'complete_todo',
  'snooze_reminder',
  'list_upcoming',
  'search',
  'list_expiry',
  'create_expiry',
  'log_interaction',
  'list_contacts_due',
  'create_document',
  'log_dose',
  'get_adherence',
  'log_habit',
  'get_habits',
  'get_patterns',
  'send_digest',
  'get_today',
  'get_week',
] as const;

export type AgentToolName = (typeof DOCUMENTED_AGENT_TOOL_NAMES)[number];

export interface AgentToolDefinition {
  readonly name: AgentToolName;
  /** WHEN to call the tool, plus the boundary against neighbouring tools. */
  readonly description: string;
  /** Narrow typed input; MUST reject `{}`. Unknown keys are rejected (strict). */
  readonly inputSchema: z.ZodType;
  readonly requiredScope: AgentToolScope;
  /** Irreversible without extra effort (only deletion, per the documented set). */
  readonly destructive: boolean;
  /** The executor must ask the user before running the tool. */
  readonly requiresConfirmation: boolean;
  /** Binding reference only: `<backend module>.<exported function>`; never executed here. */
  readonly handler: string;
}

export const AGENT_TOOLS: readonly AgentToolDefinition[] = [
  {
    name: 'list_events',
    description:
      'Call when the user wants to browse or enumerate their events (for example "show my events" or "what do I have this month"), optionally narrowed by type or date range. Returns a bounded page of events; do NOT call it to resolve one already-known event id (use get_event) or to find an event by keyword (use search).',
    inputSchema: z.strictObject({
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .describe('Maximum rows to return; pass 20 unless the user asked for more.'),
      type: eventTypeSchema.optional().describe('Optional event type filter.'),
      from: ymdSchema.optional().describe('Optional inclusive lower bound (YYYY-MM-DD).'),
      to: ymdSchema.optional().describe('Optional inclusive upper bound (YYYY-MM-DD).'),
    }),
    requiredScope: 'events:read',
    destructive: false,
    requiresConfirmation: false,
    handler: 'event.service.getEventsByUserIdPaginated',
  },
  {
    name: 'get_event',
    description:
      'Call when the user refers to one specific event and its full record is needed - typically after list_events or search returned the id. Requires the numeric eventId; never guess an id and never use this to list or search events.',
    inputSchema: z.strictObject({
      eventId: idSchema.describe('Id of the event to fetch, as returned by list_events/search.'),
    }),
    requiredScope: 'events:read',
    destructive: false,
    requiresConfirmation: false,
    // [planned] single-row reader; no exported one-by-id getter exists in event.service yet.
    handler: 'event.service.getEventById',
  },
  {
    name: 'create_event',
    description:
      'Call when the user wants to add a dated item or reminder to the calendar (birthday, anniversary, festival, exam, meeting, deadline, trip, wedding, medical visit). Requires a name and a calendar date. For subscriptions, bills, insurance, domains or warranties use create_expiry; for identity documents use create_document; for a pure habit use the habit tools.',
    inputSchema: z.strictObject({
      name: z.string().min(1).max(100).describe('Event title as the user stated it.'),
      date: ymdSchema.describe('Calendar date of the event (YYYY-MM-DD).'),
      type: eventTypeSchema.optional().describe('Event type; default other when the user did not say.'),
      calendarType: calendarTypeSchema
        .optional()
        .describe('gregorian | lunar | both; only pass lunar/both when the user gave a lunar date.'),
      personName: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .describe('Person the event is about, when the user names one.'),
    }),
    requiredScope: 'events:write',
    destructive: false,
    requiresConfirmation: false,
    handler: 'event.service.createEvent',
  },
  {
    name: 'update_event',
    description:
      'Call when the user wants to change an existing event name, date, type or person. Requires the eventId; include ONLY the fields the user actually asked to change - omitted fields stay untouched. Use delete_event when removal (not modification) is requested.',
    inputSchema: z.strictObject({
      eventId: idSchema.describe('Id of the event to update.'),
      name: z.string().min(1).max(100).optional().describe('New title, when the user changes it.'),
      date: ymdSchema.optional().describe('New calendar date, when the user changes it.'),
      type: eventTypeSchema.optional().describe('New event type, when the user changes it.'),
      personName: z.string().min(1).max(100).optional().describe('New person, when the user changes it.'),
    }),
    requiredScope: 'events:write',
    destructive: false,
    requiresConfirmation: true,
    handler: 'event.service.updateEvent',
  },
  {
    name: 'delete_event',
    description:
      'Call ONLY when the user explicitly asks to permanently delete an event by id. This is destructive and irreversible, so the executor must ask the user to confirm before running it. Prefer update_event when the user only wants to modify the event.',
    inputSchema: z.strictObject({
      eventId: idSchema.describe('Id of the event to delete permanently.'),
    }),
    requiredScope: 'events:delete',
    destructive: true,
    requiresConfirmation: true,
    handler: 'event.service.deleteEvent',
  },
  {
    name: 'complete_todo',
    description:
      'Call when the user says a todo/reminder is finished (for example "done with X" or "mark it complete"). Requires the eventId of the todo; pass occurrenceDate only when completing a specific recurring occurrence other than the current one.',
    inputSchema: z.strictObject({
      eventId: idSchema.describe('Id of the todo event to complete.'),
      occurrenceDate: ymdSchema
        .optional()
        .describe('Occurrence day (YYYY-MM-DD) for recurring todos; omit for the current occurrence.'),
    }),
    requiredScope: 'todos:write',
    destructive: false,
    requiresConfirmation: false,
    handler: 'todo.service.markTodoComplete',
  },
  {
    name: 'snooze_reminder',
    description:
      'Call when the user wants to be reminded again later about an event/todo (for example "remind me in 30 minutes" or "snooze this"). Requires the eventId and a delay in minutes (1-1440). It moves only the reminder deadline, never the event date.',
    inputSchema: z.strictObject({
      eventId: idSchema.describe('Id of the event/todo whose reminder is snoozed.'),
      minutes: z.number().int().min(1).max(1440).describe('Delay in minutes from now (1-1440).'),
    }),
    requiredScope: 'reminders:snooze',
    destructive: false,
    requiresConfirmation: true,
    // Reuses the checkbox-97 snooze writer (`events.snoozed_until`, migration v51).
    handler: 'bot-data.service.snoozeTodo',
  },
  {
    name: 'list_upcoming',
    description:
      'Call when the user asks what is coming up or still pending (for example "what is next" or "what do I still have to do"). Returns the pending todos/reminders inside the next N days; use list_events for the full event catalogue and get_today for just today.',
    inputSchema: z.strictObject({
      days: z.number().int().min(1).max(365).describe('Look-ahead window in days.'),
    }),
    requiredScope: 'todos:read',
    destructive: false,
    requiresConfirmation: false,
    handler: 'bot-data.service.listPendingItems',
  },
  {
    name: 'search',
    description:
      'Call when the user wants to find records by keyword across events, contacts, interactions, documents and expiry items (for example "find anything about the dentist"). This is a bounded text search inside one specific tool - it is NOT a free-form query/exec surface; pass a short search string and an optional result cap.',
    inputSchema: z.strictObject({
      text: z.string().min(1).max(200).describe('Short keyword/phrase to match (never SQL or a command).'),
      limit: z.number().int().min(1).max(50).optional().describe('Maximum results; default 10.'),
    }),
    requiredScope: 'search:read',
    destructive: false,
    requiresConfirmation: false,
    handler: 'search.service.searchLocal',
  },
  {
    name: 'list_expiry',
    description:
      'Call when the user asks about upcoming renewals, expirations, subscriptions or bills (for example "what expires soon" or "which subscriptions renew this month"). Returns expiry items due within the next N days; use create_expiry to add one.',
    inputSchema: z.strictObject({
      days: z.number().int().min(1).max(365).describe('Look-ahead window in days.'),
    }),
    requiredScope: 'expiry:read',
    destructive: false,
    requiresConfirmation: false,
    handler: 'expiry.service.listUpcomingExpiryItems',
  },
  {
    name: 'create_expiry',
    description:
      'Call when the user wants to record something that expires or renews (subscription, bill, insurance, domain, warranty) together with its next due date. For calendar events or ordinary reminders use create_event; for identity documents use create_document.',
    inputSchema: z.strictObject({
      title: z.string().min(1).max(200).describe('What expires/renews, as the user stated it.'),
      nextDueDate: ymdSchema.describe('Next due/renewal date (YYYY-MM-DD).'),
      kind: expiryKindSchema.optional().describe('subscription | bill | insurance | domain | warranty | custom.'),
      cycle: expiryCycleSchema
        .optional()
        .describe('once | monthly | quarterly | yearly | custom; pass the renewal cycle when stated.'),
      vendor: z.string().min(1).max(200).optional().describe('Vendor/provider, when stated.'),
      amountCents: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Amount in integer cents; omit when the user did not give a price.'),
    }),
    requiredScope: 'expiry:write',
    destructive: false,
    requiresConfirmation: true,
    handler: 'expiry.service.createExpiryItem',
  },
  {
    name: 'log_interaction',
    description:
      'Call when the user reports having contacted or met someone (for example "I called mom" or "had lunch with Ann"). Requires the contactId and the interaction kind; occurredAt defaults to now when omitted. Use list_contacts_due to learn who is overdue first.',
    inputSchema: z.strictObject({
      contactId: idSchema.describe('Id of the contact the interaction was with.'),
      kind: interactionKindSchema.describe('Interaction kind (call, meeting, message, ...).'),
      summary: z.string().min(1).max(2000).optional().describe('Short human summary of what happened.'),
      occurredAt: ymdSchema.optional().describe('Day it happened (YYYY-MM-DD); omit for now.'),
    }),
    requiredScope: 'contacts:write',
    destructive: false,
    requiresConfirmation: true,
    handler: 'contact-crm.service.createInteraction',
  },
  {
    name: 'list_contacts_due',
    description:
      'Call when the user asks who they should reach out to or which relationships are going stale (for example "who have I not talked to"). Returns contacts whose contact cadence is due within the requested look-ahead window; use log_interaction to record a contact afterwards.',
    inputSchema: z.strictObject({
      withinDays: z.number().int().min(1).max(365).describe('Look-ahead window in days.'),
    }),
    requiredScope: 'contacts:read',
    destructive: false,
    requiresConfirmation: false,
    handler: 'contact-crm.service.listDueContacts',
  },
  {
    name: 'create_document',
    description:
      'Call when the user wants to store an identity document (passport, ID card, driving licence, ...) or its expiry metadata. Records title, kind and optional issuer/expiry only - the secret document number is deliberately NOT accepted by this tool.',
    inputSchema: z.strictObject({
      title: z.string().min(1).max(200).describe('Document name as the user stated it.'),
      kind: documentKindSchema.describe('Document kind (passport, id_card, ...).'),
      issuer: z.string().min(1).max(200).optional().describe('Issuing authority, when stated.'),
      country: z.string().min(1).max(100).optional().describe('Issuing country, when stated.'),
      expiresAt: ymdSchema.optional().describe('Expiry date (YYYY-MM-DD), when stated.'),
    }),
    requiredScope: 'documents:write',
    destructive: false,
    requiresConfirmation: true,
    handler: 'document.service.createDocument',
  },
  {
    name: 'log_dose',
    description:
      'Call when the user reports taking or skipping a scheduled medication dose (for example "I took my pill"). Requires the doseId from a schedule listing (get_today) and the taken/skipped status; use get_adherence to report compliance over time.',
    inputSchema: z.strictObject({
      doseId: idSchema.describe('Id of the scheduled dose being logged.'),
      status: doseStatusSchema.describe('taken | skipped (only these two are loggable).'),
      note: z.string().max(500).optional().describe('Optional note, e.g. half dose or side effect.'),
    }),
    requiredScope: 'health:write',
    destructive: false,
    requiresConfirmation: false,
    handler: 'medication.service.logDose',
  },
  {
    name: 'get_adherence',
    description:
      'Call when the user asks how well a medication schedule has been followed (for example "did I miss any doses this month" or "what is my adherence"). Requires an explicit from/to date range; both bounds are inclusive calendar days.',
    inputSchema: z.strictObject({
      from: ymdSchema.describe('Inclusive range start (YYYY-MM-DD).'),
      to: ymdSchema.describe('Inclusive range end (YYYY-MM-DD).'),
    }),
    requiredScope: 'health:read',
    destructive: false,
    requiresConfirmation: false,
    handler: 'medication.service.getAdherence',
  },
  {
    name: 'log_habit',
    description:
      'Call when the user reports completing a habit (for example "I ran today" or "check off my reading"). Requires the habitId; count defaults to 1 and loggedOn defaults to the user-local today when omitted. Use get_habits for streaks and habit lists.',
    inputSchema: z.strictObject({
      habitId: idSchema.describe('Id of the habit being checked off.'),
      count: z.number().int().min(1).max(1000).optional().describe('Units completed; omit for a single check.'),
      loggedOn: ymdSchema.optional().describe('Day to credit (YYYY-MM-DD); omit for user-local today.'),
      note: z.string().max(500).optional().describe('Optional note for the check-in.'),
    }),
    requiredScope: 'habits:write',
    destructive: false,
    requiresConfirmation: false,
    handler: 'habit.service.logHabit',
  },
  {
    name: 'get_habits',
    description:
      'Call when the user asks about their habits or streaks (for example "how are my habits doing" or "what is my streak"). Pass active=true for current habits and active=false for archived ones; use log_habit to check one off.',
    inputSchema: z.strictObject({
      active: z.boolean().describe('true = only active habits; false = only archived habits.'),
    }),
    requiredScope: 'habits:read',
    destructive: false,
    requiresConfirmation: false,
    handler: 'habit.service.listHabits',
  },
  {
    name: 'get_patterns',
    description:
      'Call when the user asks what the system has learned about their behaviour (for example "what patterns did you notice" or "when do I usually snooze"). Returns mined patterns whose evidence count meets the given threshold; never invent a pattern when the result is empty.',
    inputSchema: z.strictObject({
      minEvidence: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .describe('Minimum observations behind a pattern; pass 1 for everything surfaced, higher to be strict.'),
    }),
    requiredScope: 'patterns:read',
    destructive: false,
    requiresConfirmation: false,
    handler: 'patterns.service.listPatterns',
  },
  {
    name: 'send_digest',
    description:
      'Call ONLY when the user explicitly asks to send themselves a monthly or yearly summary/digest. It delivers an outward message (Inbox + email), so the executor must ask for confirmation before sending. For a dry run without sending, use the digest preview, never this tool.',
    inputSchema: z.strictObject({
      period: digestPeriodSchema.describe('monthly | yearly digest to generate and send.'),
    }),
    requiredScope: 'digest:send',
    destructive: false,
    requiresConfirmation: true,
    handler: 'digest.service.sendDigestForUser',
  },
  {
    name: 'get_today',
    description:
      'Call FIRST when the user asks about today (for example "what is on today" or "what needs attention right now"). Aggregates today\'s events, pending todos and scheduled doses in the user\'s timezone; use get_week for a seven-day view.',
    inputSchema: z.strictObject({
      includeCompleted: z.boolean().describe('true = also list items already completed today.'),
    }),
    requiredScope: 'assistant:read',
    destructive: false,
    requiresConfirmation: false,
    // [planned] aggregator over events/todos/doses; no single existing export yet.
    handler: 'assistant.service.getToday',
  },
  {
    name: 'get_week',
    description:
      'Call when the user asks about the next seven days (for example "what does my week look like" or "anything coming up this week"). Aggregates the upcoming week in the user\'s timezone; call get_today instead when only today matters.',
    inputSchema: z.strictObject({
      includeCompleted: z.boolean().describe('true = also list items already completed in the window.'),
    }),
    requiredScope: 'assistant:read',
    destructive: false,
    requiresConfirmation: false,
    // [planned] same aggregator as get_today, 7-day window; no single existing export yet.
    handler: 'assistant.service.getWeek',
  },
];

/** Irreversible tools (the documented destructive set is exactly `delete_event`). */
export const DESTRUCTIVE_AGENT_TOOLS: readonly AgentToolName[] = AGENT_TOOLS.filter(
  (tool) => tool.destructive,
).map((tool) => tool.name);

/** Tools the executor must confirm with the user before running. */
export const CONFIRMATION_REQUIRED_AGENT_TOOLS: readonly AgentToolName[] = AGENT_TOOLS.filter(
  (tool) => tool.requiresConfirmation,
).map((tool) => tool.name);

/** Lookup by name for executors; built from the one registry above. */
export const AGENT_TOOLS_BY_NAME: ReadonlyMap<AgentToolName, AgentToolDefinition> = new Map(
  AGENT_TOOLS.map((tool) => [tool.name, tool] as const),
);

export function getAgentTool(name: AgentToolName): AgentToolDefinition {
  const tool = AGENT_TOOLS_BY_NAME.get(name);
  if (!tool) {
    throw new Error(`unknown agent tool: ${name}`);
  }
  return tool;
}
