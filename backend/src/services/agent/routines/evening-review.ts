import { isHabitScheduledOn, normalizeScheduleDays } from '@timemark/shared/habit-schedule';
import { query } from '../../../db/index.js';
import { createInboxMessage } from '../../inbox.service.js';
import { getAdherence } from '../../medication.service.js';
import {
  addDaysYmd,
  claimRoutineArtifact,
  dueUrgencyLabel,
  getUserTimezone,
  localDateIn,
  markRoutineArtifactDelivered,
  medicationSummary,
  resolveRoutineNarrative,
  routineArtifactKey,
  type RoutineContext,
  type RoutineDescriptor,
  type RoutineMedicationSummary,
  type RoutineResult,
  type RoutineTier,
} from './routine.js';

/**
 * Checkbox 123 - evening review (medium tier).
 *
 * Closes the day from existing user data and delivers ONE Inbox message: what
 * was completed today, today's events, habits that were / were not logged,
 * today's medication adherence, plus a tomorrow preview (events + items coming
 * due within `COMING_DUE_LEAD_DAYS`). An optional `ctx.narrator` may prepend one
 * AI paragraph (budget-gated); with AI off the body is the deterministic
 * template below - zero model calls.
 *
 * Idempotency: key `evening_review:<localDate>` claimed in
 * `agent_routine_artifacts`; a duplicate run returns `status: 'duplicate'`
 * without touching the Inbox (at-least-once queue safety).
 */

export const EVENING_REVIEW_SCHEDULE = '0 21 * * *';
export const EVENING_REVIEW_TIER: RoutineTier = 'medium';

/** Tomorrow-preview window: items due within N days of the review day. */
export const COMING_DUE_LEAD_DAYS = 3;

export function eveningReviewIdempotencyKey(localDate: string): string {
  return routineArtifactKey('evening_review', localDate);
}

/** Every statement this routine emits (exported so tests can pin the SQL). */
export const EVENING_REVIEW_SQL = {
  completedToday: `
SELECT tc.event_id, e.name, e.type, TO_CHAR(tc.completed_at, 'YYYY-MM-DD HH24:MI') AS completed_at
FROM todo_completions tc
JOIN events e ON e.id = tc.event_id
WHERE tc.user_id = $1 AND tc.occurrence_date = $2::date
ORDER BY tc.completed_at ASC
LIMIT 100`,
  eventsToday: `
SELECT id, name, type, TO_CHAR(COALESCE(next_occurrence, date), 'YYYY-MM-DD') AS on_date
FROM events
WHERE user_id = $1 AND COALESCE(next_occurrence, date) = $2::date
ORDER BY COALESCE(next_occurrence, date) ASC, id ASC
LIMIT 50`,
  habitsToday: `
SELECT h.id, h.name, h.period, h.target_per_period, h.schedule_days,
       COALESCE(hl.count, 0)::int AS logged_count
FROM habits h
LEFT JOIN habit_logs hl ON hl.habit_id = h.id AND hl.logged_on = $2::date
WHERE h.user_id = $1 AND h.is_active = TRUE
ORDER BY h.id ASC`,
  eventsTomorrow: `
SELECT id, name, type, TO_CHAR(COALESCE(next_occurrence, date), 'YYYY-MM-DD') AS on_date
FROM events
WHERE user_id = $1 AND COALESCE(next_occurrence, date) = $2::date
ORDER BY COALESCE(next_occurrence, date) ASC, id ASC
LIMIT 50`,
  comingDue: `
SELECT 'expiry' AS kind, title, TO_CHAR(next_due_date, 'YYYY-MM-DD') AS due
  FROM expiry_items
  WHERE user_id = $1 AND is_active = TRUE AND next_due_date <= $2::date
UNION ALL
SELECT 'document', title, TO_CHAR(expires_at, 'YYYY-MM-DD')
  FROM documents
  WHERE user_id = $1 AND is_active = TRUE AND expires_at IS NOT NULL AND expires_at <= $2::date
UNION ALL
SELECT 'maintenance', asset_name, TO_CHAR(next_due_at, 'YYYY-MM-DD')
  FROM maintenance_plans
  WHERE user_id = $1 AND is_active = TRUE AND next_due_at IS NOT NULL AND next_due_at <= $2::date
ORDER BY due ASC
LIMIT 100`,
} as const;

export interface EveningReviewCompleted {
  id: number;
  name: string;
  type: string;
  completedAt: string;
}

export interface EveningReviewEvent {
  id: number;
  name: string;
  type: string;
  date: string;
}

export interface EveningReviewHabit {
  id: number;
  name: string;
  period: string;
  target: number;
  done: boolean;
}

export interface EveningReviewComingDue {
  kind: string;
  title: string;
  due: string;
}

export interface EveningReviewFacts {
  localDate: string;
  completed: EveningReviewCompleted[];
  events: EveningReviewEvent[];
  habits: EveningReviewHabit[];
  medications: RoutineMedicationSummary | null;
  tomorrow: EveningReviewEvent[];
  comingDue: EveningReviewComingDue[];
  counts: {
    completed: number;
    events: number;
    habits: number;
    habitsDone: number;
    tomorrow: number;
    comingDue: number;
    medications: number;
  };
}

const KIND_LABEL: Record<string, string> = {
  expiry: '到期',
  document: '证件',
  maintenance: '保养',
};

/* ------------------------------------------------------------------ */
/* Collection                                                          */
/* ------------------------------------------------------------------ */

function asNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asText(value: unknown): string {
  return value == null ? '' : String(value);
}

function asYmd(value: unknown): string {
  return asText(value).slice(0, 10);
}

export async function collectEveningReview(userId: number, localDate: string): Promise<EveningReviewFacts> {
  const tomorrow = addDaysYmd(localDate, 1);
  const comingDueHorizon = addDaysYmd(localDate, COMING_DUE_LEAD_DAYS);

  const [completedResult, eventsResult, habitsResult, tomorrowResult, comingDueResult, adherence] =
    await Promise.all([
      query(EVENING_REVIEW_SQL.completedToday, [userId, localDate]),
      query(EVENING_REVIEW_SQL.eventsToday, [userId, localDate]),
      query(EVENING_REVIEW_SQL.habitsToday, [userId, localDate]),
      query(EVENING_REVIEW_SQL.eventsTomorrow, [userId, tomorrow]),
      query(EVENING_REVIEW_SQL.comingDue, [userId, comingDueHorizon]),
      // Missing/unconfigured medication data must never fail the review.
      getAdherence(userId, localDate, localDate).catch(() => null),
    ]);

  const completed: EveningReviewCompleted[] = completedResult.rows.map((row) => ({
    id: asNumber(row.event_id),
    name: asText(row.name),
    type: asText(row.type),
    completedAt: asText(row.completed_at),
  }));

  const events: EveningReviewEvent[] = eventsResult.rows.map((row) => ({
    id: asNumber(row.id),
    name: asText(row.name),
    type: asText(row.type),
    date: asYmd(row.on_date),
  }));

  const habits: EveningReviewHabit[] = habitsResult.rows
    .map((row) => ({
      id: asNumber(row.id),
      name: asText(row.name),
      period: asText(row.period) || 'day',
      target: Math.max(1, asNumber(row.target_per_period, 1)),
      loggedCount: asNumber(row.logged_count),
      scheduleDays: normalizeScheduleDays((row.schedule_days ?? null) as number[] | null),
    }))
    .filter((habit) => isHabitScheduledOn(localDate, habit.scheduleDays))
    .map((habit) => ({
      id: habit.id,
      name: habit.name,
      period: habit.period,
      target: habit.target,
      done: habit.loggedCount >= habit.target,
    }));

  const tomorrowEvents: EveningReviewEvent[] = tomorrowResult.rows.map((row) => ({
    id: asNumber(row.id),
    name: asText(row.name),
    type: asText(row.type),
    date: asYmd(row.on_date),
  }));

  const comingDue: EveningReviewComingDue[] = comingDueResult.rows.map((row) => ({
    kind: asText(row.kind),
    title: asText(row.title),
    due: asYmd(row.due),
  }));

  const medications = medicationSummary(adherence);

  return {
    localDate,
    completed,
    events,
    habits,
    medications,
    tomorrow: tomorrowEvents,
    comingDue,
    counts: {
      completed: completed.length,
      events: events.length,
      habits: habits.length,
      habitsDone: habits.filter((habit) => habit.done).length,
      tomorrow: tomorrowEvents.length,
      comingDue: comingDue.length,
      medications: medications?.total ?? 0,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Rendering (deterministic; AI off => this is the whole body)         */
/* ------------------------------------------------------------------ */

export function renderEveningReview(facts: EveningReviewFacts): { title: string; body: string } {
  const title = `TimeMark 晚间回顾 · ${facts.localDate}`;
  const lines: string[] = [];

  if (facts.completed.length > 0) {
    lines.push(`今日完成（${facts.completed.length}）`);
    for (const item of facts.completed) lines.push(`- ${item.name}`);
    lines.push('');
  }

  if (facts.events.length > 0) {
    lines.push(`今日日程（${facts.events.length}）`);
    for (const event of facts.events) lines.push(`- ${event.name}（${event.type}）`);
    lines.push('');
  }

  if (facts.habits.length > 0) {
    lines.push('今日习惯');
    for (const habit of facts.habits) {
      lines.push(`- ${habit.name} · ${habit.done ? '已完成' : '待补'}`);
    }
    lines.push('');
  }

  if (facts.medications) {
    const meds = facts.medications;
    lines.push(
      `用药（今日）：已服 ${meds.taken} · 跳过 ${meds.skipped} · 漏服 ${meds.missed}（依从率 ${meds.percentage}%）`,
    );
    lines.push('');
  }

  if (facts.tomorrow.length > 0) {
    lines.push(`明日预告（${facts.tomorrow.length}）`);
    for (const event of facts.tomorrow) lines.push(`- ${event.name}（${event.type}）`);
    lines.push('');
  }

  if (facts.comingDue.length > 0) {
    lines.push(`近 ${COMING_DUE_LEAD_DAYS} 日到期（${facts.comingDue.length}）`);
    for (const item of facts.comingDue) {
      const kind = KIND_LABEL[item.kind] ?? item.kind;
      lines.push(`- [${kind}] ${item.title} · ${item.due}（${dueUrgencyLabel(facts.localDate, item.due)}）`);
    }
    lines.push('');
  }

  if (lines.length === 0) {
    lines.push('今天没有记录到任何活动，是安静的一天。');
  }

  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return { title, body: lines.join('\n') };
}

/* ------------------------------------------------------------------ */
/* Run + descriptor                                                    */
/* ------------------------------------------------------------------ */

export async function runEveningReview(ctx: RoutineContext): Promise<RoutineResult> {
  const userId = ctx.userId;
  const now = ctx.now ?? new Date();
  const timezone = ctx.timezone ?? (await getUserTimezone(userId));
  const localDate = localDateIn(now, timezone);

  const facts = await collectEveningReview(userId, localDate);
  const narrative = await resolveRoutineNarrative(ctx, { kind: 'evening_review', localDate, timezone, facts });
  const rendered = renderEveningReview(facts);
  const body = narrative ? `${narrative}\n\n${rendered.body}` : rendered.body;
  const idempotencyKey = eveningReviewIdempotencyKey(localDate);

  const artifactId = await claimRoutineArtifact({
    userId,
    kind: 'evening_review',
    localDate,
    idempotencyKey,
    title: rendered.title,
    body,
    payload: { localDate, timezone, counts: facts.counts, narrative: narrative !== null },
  });

  if (artifactId === null) {
    // Already delivered for this local day: at-least-once landing, zero side effects.
    return {
      kind: 'evening_review',
      userId,
      localDate,
      status: 'duplicate',
      title: rendered.title,
      body,
      usedNarrative: narrative !== null,
      artifactId: null,
      facts,
    };
  }

  let inboxOk = false;
  try {
    const message = await createInboxMessage({
      userId,
      title: rendered.title,
      body,
      source: 'inbound',
      senderLabel: '晚间回顾',
    });
    inboxOk = message !== null;
  } catch {
    inboxOk = false;
  }

  let pushOk = false;
  if (ctx.deliver) {
    try {
      await ctx.deliver({ userId, kind: 'evening_review', localDate, title: rendered.title, body });
      pushOk = true;
    } catch {
      pushOk = false; // push is best-effort; Inbox remains the primary channel
    }
  }

  const delivered = inboxOk || pushOk;
  if (delivered) {
    await markRoutineArtifactDelivered(userId, artifactId, inboxOk ? 'inbox' : 'push');
  }

  return {
    kind: 'evening_review',
    userId,
    localDate,
    status: delivered ? 'delivered' : 'not_delivered',
    title: rendered.title,
    body,
    usedNarrative: narrative !== null,
    artifactId,
    facts,
  };
}

/** Descriptor for the integrator: seeds an `agent_routines` row + binds the handler. */
export const eveningReviewRoutine: RoutineDescriptor = {
  kind: 'evening_review',
  tier: EVENING_REVIEW_TIER,
  defaultSchedule: EVENING_REVIEW_SCHEDULE,
  run: runEveningReview,
};
