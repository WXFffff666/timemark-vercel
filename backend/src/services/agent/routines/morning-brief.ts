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
 * Checkbox 122 - morning brief (medium tier).
 *
 * Assembles the day ahead from existing user data and delivers ONE Inbox
 * message: today's events, expiries / documents / maintenance inside their lead
 * windows, habits scheduled today, and today's medication adherence. An
 * optional `ctx.narrator` may prepend one AI paragraph (budget-gated at
 * `NARRATIVE_MIN_BUDGET_TOKENS`); with AI off the body is the deterministic
 * template below - zero model calls, zero network beyond the Inbox write.
 *
 * Idempotency: key `morning_brief:<localDate>` claimed in
 * `agent_routine_artifacts`; a duplicate run returns `status: 'duplicate'`
 * without touching the Inbox (at-least-once queue safety).
 */

export const MORNING_BRIEF_SCHEDULE = '0 8 * * *';
export const MORNING_BRIEF_TIER: RoutineTier = 'medium';

/** An item counts once `due <= localDate + N days` (overdue items always count). */
export const EXPIRY_LEAD_DAYS = 7;
export const DOCUMENT_LEAD_DAYS = 30;
export const MAINTENANCE_LEAD_DAYS = 7;

export function morningBriefIdempotencyKey(localDate: string): string {
  return routineArtifactKey('morning_brief', localDate);
}

/** Every statement this routine emits (exported so tests can pin the SQL). */
export const MORNING_BRIEF_SQL = {
  eventsToday: `
SELECT id, name, type, TO_CHAR(COALESCE(next_occurrence, date), 'YYYY-MM-DD') AS on_date
FROM events
WHERE user_id = $1 AND COALESCE(next_occurrence, date) = $2::date
ORDER BY COALESCE(next_occurrence, date) ASC, id ASC
LIMIT 50`,
  expiringSoon: `
SELECT id, title, TO_CHAR(next_due_date, 'YYYY-MM-DD') AS due, amount_cents, currency
FROM expiry_items
WHERE user_id = $1 AND is_active = TRUE AND next_due_date <= $2::date
ORDER BY next_due_date ASC, id ASC
LIMIT 50`,
  documentsExpiring: `
SELECT id, title, TO_CHAR(expires_at, 'YYYY-MM-DD') AS due
FROM documents
WHERE user_id = $1 AND is_active = TRUE AND expires_at IS NOT NULL AND expires_at <= $2::date
ORDER BY expires_at ASC, id ASC
LIMIT 50`,
  maintenanceDue: `
SELECT id, asset_name, TO_CHAR(next_due_at, 'YYYY-MM-DD') AS due
FROM maintenance_plans
WHERE user_id = $1 AND is_active = TRUE AND next_due_at IS NOT NULL AND next_due_at <= $2::date
ORDER BY next_due_at ASC, id ASC
LIMIT 50`,
  habitsToday: `
SELECT h.id, h.name, h.period, h.target_per_period, h.schedule_days,
       COALESCE(hl.count, 0)::int AS logged_count
FROM habits h
LEFT JOIN habit_logs hl ON hl.habit_id = h.id AND hl.logged_on = $2::date
WHERE h.user_id = $1 AND h.is_active = TRUE
ORDER BY h.id ASC`,
} as const;

export interface MorningBriefEvent {
  id: number;
  name: string;
  type: string;
  date: string;
}

export interface MorningBriefExpiring {
  id: number;
  title: string;
  due: string;
  amountCents: number | null;
  currency: string;
}

export interface MorningBriefDocument {
  id: number;
  title: string;
  due: string;
}

export interface MorningBriefMaintenance {
  id: number;
  assetName: string;
  due: string;
}

export interface MorningBriefHabit {
  id: number;
  name: string;
  period: string;
  target: number;
  done: boolean;
}

export interface MorningBriefFacts {
  localDate: string;
  events: MorningBriefEvent[];
  expiring: MorningBriefExpiring[];
  documents: MorningBriefDocument[];
  maintenance: MorningBriefMaintenance[];
  habits: MorningBriefHabit[];
  medications: RoutineMedicationSummary | null;
  counts: {
    events: number;
    expiring: number;
    documents: number;
    maintenance: number;
    habits: number;
    habitsDone: number;
    medications: number;
  };
}

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

export async function collectMorningBrief(userId: number, localDate: string): Promise<MorningBriefFacts> {
  const [eventsResult, expiringResult, documentsResult, maintenanceResult, habitsResult, adherence] =
    await Promise.all([
      query(MORNING_BRIEF_SQL.eventsToday, [userId, localDate]),
      query(MORNING_BRIEF_SQL.expiringSoon, [userId, addDaysYmd(localDate, EXPIRY_LEAD_DAYS)]),
      query(MORNING_BRIEF_SQL.documentsExpiring, [userId, addDaysYmd(localDate, DOCUMENT_LEAD_DAYS)]),
      query(MORNING_BRIEF_SQL.maintenanceDue, [userId, addDaysYmd(localDate, MAINTENANCE_LEAD_DAYS)]),
      query(MORNING_BRIEF_SQL.habitsToday, [userId, localDate]),
      // Missing/unconfigured medication data must never fail the brief.
      getAdherence(userId, localDate, localDate).catch(() => null),
    ]);

  const events: MorningBriefEvent[] = eventsResult.rows.map((row) => ({
    id: asNumber(row.id),
    name: asText(row.name),
    type: asText(row.type),
    date: asYmd(row.on_date),
  }));

  const expiring: MorningBriefExpiring[] = expiringResult.rows.map((row) => ({
    id: asNumber(row.id),
    title: asText(row.title),
    due: asYmd(row.due),
    amountCents: row.amount_cents == null ? null : asNumber(row.amount_cents),
    currency: asText(row.currency) || 'CNY',
  }));

  const documents: MorningBriefDocument[] = documentsResult.rows.map((row) => ({
    id: asNumber(row.id),
    title: asText(row.title),
    due: asYmd(row.due),
  }));

  const maintenance: MorningBriefMaintenance[] = maintenanceResult.rows.map((row) => ({
    id: asNumber(row.id),
    assetName: asText(row.asset_name),
    due: asYmd(row.due),
  }));

  const habits: MorningBriefHabit[] = habitsResult.rows
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

  const medications = medicationSummary(adherence);

  return {
    localDate,
    events,
    expiring,
    documents,
    maintenance,
    habits,
    medications,
    counts: {
      events: events.length,
      expiring: expiring.length,
      documents: documents.length,
      maintenance: maintenance.length,
      habits: habits.length,
      habitsDone: habits.filter((habit) => habit.done).length,
      medications: medications?.total ?? 0,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Rendering (deterministic; AI off => this is the whole body)         */
/* ------------------------------------------------------------------ */

function money(cents: number, currency: string): string {
  const amount = (cents / 100).toFixed(2);
  return currency === 'CNY' ? `¥${amount}` : `${currency} ${amount}`;
}

export function renderMorningBrief(facts: MorningBriefFacts): { title: string; body: string } {
  const title = `TimeMark 晨间简报 · ${facts.localDate}`;
  const lines: string[] = [];

  if (facts.events.length > 0) {
    lines.push(`今日日程（${facts.events.length}）`);
    for (const event of facts.events) lines.push(`- ${event.name}（${event.type}）`);
    lines.push('');
  }

  if (facts.expiring.length > 0) {
    lines.push(`即将到期（${EXPIRY_LEAD_DAYS} 天内 · ${facts.expiring.length}）`);
    for (const item of facts.expiring) {
      const amount = item.amountCents == null ? '' : ` · ${money(item.amountCents, item.currency)}`;
      lines.push(`- ${item.title}${amount} · ${item.due}（${dueUrgencyLabel(facts.localDate, item.due)}）`);
    }
    lines.push('');
  }

  if (facts.documents.length > 0) {
    lines.push(`证件到期（${DOCUMENT_LEAD_DAYS} 天内 · ${facts.documents.length}）`);
    for (const doc of facts.documents) {
      lines.push(`- ${doc.title} · ${doc.due}（${dueUrgencyLabel(facts.localDate, doc.due)}）`);
    }
    lines.push('');
  }

  if (facts.maintenance.length > 0) {
    lines.push(`保养到期（${MAINTENANCE_LEAD_DAYS} 天内 · ${facts.maintenance.length}）`);
    for (const plan of facts.maintenance) {
      lines.push(`- ${plan.assetName} · ${plan.due}（${dueUrgencyLabel(facts.localDate, plan.due)}）`);
    }
    lines.push('');
  }

  if (facts.habits.length > 0) {
    lines.push('今日习惯');
    for (const habit of facts.habits) {
      const scope = habit.period === 'week' ? `本周目标 ${habit.target}` : `今日目标 ${habit.target}`;
      lines.push(`- ${habit.name} · ${scope} · ${habit.done ? '已完成' : '待完成'}`);
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

  if (lines.length === 0) {
    lines.push('今日暂无安排，是安静的一天。');
  }

  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return { title, body: lines.join('\n') };
}

/* ------------------------------------------------------------------ */
/* Run + descriptor                                                    */
/* ------------------------------------------------------------------ */

export async function runMorningBrief(ctx: RoutineContext): Promise<RoutineResult> {
  const userId = ctx.userId;
  const now = ctx.now ?? new Date();
  const timezone = ctx.timezone ?? (await getUserTimezone(userId));
  const localDate = localDateIn(now, timezone);

  const facts = await collectMorningBrief(userId, localDate);
  const narrative = await resolveRoutineNarrative(ctx, { kind: 'morning_brief', localDate, timezone, facts });
  const rendered = renderMorningBrief(facts);
  const body = narrative ? `${narrative}\n\n${rendered.body}` : rendered.body;
  const idempotencyKey = morningBriefIdempotencyKey(localDate);

  const artifactId = await claimRoutineArtifact({
    userId,
    kind: 'morning_brief',
    localDate,
    idempotencyKey,
    title: rendered.title,
    body,
    payload: { localDate, timezone, counts: facts.counts, narrative: narrative !== null },
  });

  if (artifactId === null) {
    // Already delivered for this local day: at-least-once landing, zero side effects.
    return {
      kind: 'morning_brief',
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
      senderLabel: '晨间简报',
    });
    inboxOk = message !== null;
  } catch {
    inboxOk = false;
  }

  let pushOk = false;
  if (ctx.deliver) {
    try {
      await ctx.deliver({ userId, kind: 'morning_brief', localDate, title: rendered.title, body });
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
    kind: 'morning_brief',
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
export const morningBriefRoutine: RoutineDescriptor = {
  kind: 'morning_brief',
  tier: MORNING_BRIEF_TIER,
  defaultSchedule: MORNING_BRIEF_SCHEDULE,
  run: runMorningBrief,
};
