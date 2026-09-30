import { query } from '../../db/index.js';
import { createLogger } from '../../utils/logger.js';
import { normalizeTimezone } from '../../utils/timezone.js';
import { AUDIT_SNAPSHOT_ROW_CAP, buildReinsertGroup, buildRevertGroup, recordAuditSafe } from './audit.service.js';
import { createInboxMessage } from '../inbox.service.js';
import { getUserConfig } from '../config.service.js';
import { sendTelegramMessage, type SendMessageParams } from '../bot/telegram-api.js';
import { CALLBACK_DATA_MAX_BYTES, isCallbackDataWithinLimit } from '../bot/callback-data.js';
import {
  getLocalDayKey,
  getTodayBudgetUsage,
  recordSuppressedNotification,
  tryConsumeDailyBudget,
  type TodayBudgetUsage,
} from './notification-budget.service.js';
import {
  checkPolicyForProposal,
  normalizeFeedbackRationale,
  recordFeedback,
  type PolicyVerdict,
} from './feedback.service.js';
import type { CallbackHandleResult } from '../bot/callback-handler.js';

const log = createLogger('agent.decision-card');

/**
 * Task 126 — human-in-the-loop decision cards.
 *
 * Lifecycle: `proposeDecision` writes ONE `agent_decision_cards` row (status
 * 'pending'), ALWAYS creates an Inbox entry, and — only when a notification-budget
 * slot is available — sends ONE push with Approve / Edit / Reject inline buttons
 * (callback data namespaced `dc:`). Nothing mutates user data until `decideOnDecisionCard`
 * approves the card, and even then the change is applied through the TYPED resolver
 * registry below: `subject kind -> apply function`, with strict payload validation, so
 * no arbitrary action can be injected via the payload JSON.
 *
 * EXACTLY-ONCE APPROVAL. The transition pending -> approved is a single atomic
 * conditional UPDATE. The first call updates one row and runs the resolver; every
 * later call updates zero rows and returns `already_decided` (the API maps that to
 * 409). A resolver failure BEFORE any mutation releases the claim back to 'pending'
 * (resolvers must check-then-single-write), while a `target_missing` result moves the
 * card to a terminal 'target_missing' state — the API answers `目标已不存在` 404-style.
 *
 * Every decision also flows into the feedback memory (task 127) via
 * `recordFeedback`, including the optional free-text "Why?" note.
 */

export const DECISION_SUBJECT_KINDS = [
  'reschedule_reminder',
  'merge_contacts',
  'archive_completed',
  'adjust_cadence',
  'accept_tag',
] as const;
export type DecisionSubjectKind = (typeof DECISION_SUBJECT_KINDS)[number];

export type DecisionStatus = 'pending' | 'approved' | 'rejected' | 'target_missing' | 'expired';

export const DECISION_ACTIONS = ['approve', 'edit', 'reject'] as const;
export type DecisionAction = (typeof DECISION_ACTIONS)[number];

export const DECISION_SUMMARY_MAX_CHARS = 500;

// ---------------------------------------------------------------------------
// Card model
// ---------------------------------------------------------------------------

export interface DecisionCardRow {
  id: number;
  user_id: number;
  subject_kind: DecisionSubjectKind;
  subject_ref: string | null;
  action: string;
  summary: string;
  payload: Record<string, unknown>;
  idempotency_key: string;
  status: DecisionStatus;
  is_question: boolean;
  rationale: string | null;
  edit_payload: Record<string, unknown> | null;
  resolution: Record<string, unknown>;
  created_at: string;
  decided_at: string | null;
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? '');
}

function mapCard(row: Record<string, unknown>): DecisionCardRow {
  return {
    id: Number(row.id),
    user_id: Number(row.user_id),
    subject_kind: String(row.subject_kind) as DecisionSubjectKind,
    subject_ref: row.subject_ref == null ? null : String(row.subject_ref),
    action: String(row.action ?? 'propose'),
    summary: String(row.summary ?? ''),
    payload: (row.payload ?? {}) as Record<string, unknown>,
    idempotency_key: String(row.idempotency_key ?? ''),
    status: String(row.status ?? 'pending') as DecisionStatus,
    is_question: row.is_question === true,
    rationale: row.rationale == null ? null : String(row.rationale),
    edit_payload: (row.edit_payload ?? null) as Record<string, unknown> | null,
    resolution: (row.resolution ?? {}) as Record<string, unknown>,
    created_at: toIso(row.created_at),
    decided_at: row.decided_at == null ? null : toIso(row.decided_at),
  };
}

function sanitizeSummary(raw: string): string {
  return raw
    // eslint-disable-next-line no-control-regex -- strips ASCII control characters from card text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DECISION_SUMMARY_MAX_CHARS);
}

/** Feedback/policy subject for a card: the stable ref, falling back to the kind. */
export function decisionFeedbackSubject(card: Pick<DecisionCardRow, 'subject_kind' | 'subject_ref'>): string {
  return card.subject_ref?.trim() || card.subject_kind;
}

// ---------------------------------------------------------------------------
// Typed resolver registry (subject kind -> apply function)
// ---------------------------------------------------------------------------

export interface DecisionResolution {
  /** 'applied' ran the change; 'target_missing' finds the target gone; 'invalid' = bad payload. */
  status: 'applied' | 'target_missing' | 'invalid';
  detail?: Record<string, unknown>;
}

export type DecisionApplyFn = (input: {
  userId: number;
  card: DecisionCardRow;
  /** Card payload merged with any edit override; already past the allowlist checks. */
  payload: Record<string, unknown>;
  now: Date;
}) => Promise<DecisionResolution>;

const resolverRegistry = new Map<DecisionSubjectKind, DecisionApplyFn>();

export function registerDecisionResolver(kind: DecisionSubjectKind, fn: DecisionApplyFn): void {
  resolverRegistry.set(kind, fn);
}

/** Registry lookup with an injection guard: unknown kinds resolve to `null`. */
export function getDecisionResolver(kind: string): DecisionApplyFn | null {
  if (!(DECISION_SUBJECT_KINDS as readonly string[]).includes(kind)) return null;
  return resolverRegistry.get(kind as DecisionSubjectKind) ?? null;
}

// -- payload allowlist helpers (no arbitrary action can pass through) --------

function readPositiveInt(payload: Record<string, unknown>, key: string): number | null {
  const raw = payload[key];
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function readYmd(payload: Record<string, unknown>, key: string): string | null {
  const raw = payload[key];
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const parsed = new Date(`${raw}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : raw;
}

function readTag(payload: Record<string, unknown>): string | null {
  const raw = payload.tag;
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/^#+/, '').replace(/\s+/g, ' ').trim();
  if (cleaned === '' || cleaned.length > 40) return null;
  return cleaned;
}

// -- default resolvers -------------------------------------------------------

registerDecisionResolver('reschedule_reminder', async ({ userId, payload }) => {
  const eventId = readPositiveInt(payload, 'eventId');
  const date = readYmd(payload, 'date');
  if (eventId === null || date === null) {
    return { status: 'invalid', detail: { reason: 'payload_requires_eventId_and_date' } };
  }
  const result = await query(
    `UPDATE events SET date = $3::date WHERE id = $2 AND user_id = $1 RETURNING id`,
    [userId, eventId, date],
  );
  if (result.rows.length === 0) return { status: 'target_missing', detail: { eventId } };
  return { status: 'applied', detail: { eventId, date } };
});

registerDecisionResolver('merge_contacts', async ({ userId, payload }) => {
  const keepContactId = readPositiveInt(payload, 'keepContactId');
  const mergeContactId = readPositiveInt(payload, 'mergeContactId');
  if (keepContactId === null || mergeContactId === null || keepContactId === mergeContactId) {
    return { status: 'invalid', detail: { reason: 'payload_requires_two_distinct_contact_ids' } };
  }
  const found = await query(
    `SELECT id FROM fixed_contacts WHERE user_id = $1 AND id = ANY($2::bigint[])`,
    [userId, [keepContactId, mergeContactId]],
  );
  if (found.rows.length < 2) {
    return { status: 'target_missing', detail: { keepContactId, mergeContactId } };
  }
  // Task 142: capture the pre-merge rows BEFORE the mutation so an undo can
  // restore the deleted contact and re-point the moved interactions exactly.
  const contactRows = await query(
    `SELECT * FROM fixed_contacts WHERE user_id = $1 AND id = ANY($2::bigint[])`,
    [userId, [keepContactId, mergeContactId]],
  );
  const movedInteractions = await query(
    `SELECT * FROM interactions WHERE user_id = $1 AND contact_id = $2 LIMIT $3`,
    [userId, mergeContactId, AUDIT_SNAPSHOT_ROW_CAP + 1],
  );
  await query(
    `UPDATE interactions SET contact_id = $2 WHERE user_id = $1 AND contact_id = $3`,
    [userId, keepContactId, mergeContactId],
  );
  await query(`DELETE FROM fixed_contacts WHERE user_id = $1 AND id = $2`, [userId, mergeContactId]);
  const mergedRow = contactRows.rows.find(
    (row) => Number((row as Record<string, unknown>).id) === mergeContactId,
  );
  const movedRows = movedInteractions.rows.slice(0, AUDIT_SNAPSHOT_ROW_CAP) as Array<Record<string, unknown>>;
  await recordAuditSafe({
    userId,
    action: 'merge',
    entityKind: 'contact',
    entityIds: [keepContactId, mergeContactId],
    summary: `merged contact #${mergeContactId} into #${keepContactId}`,
    actorVia: 'decision_card',
    before: {
      contacts: contactRows.rows,
      movedInteractionIds: movedRows.map((row) => row.id),
      truncated: movedInteractions.rows.length > AUDIT_SNAPSHOT_ROW_CAP,
    },
    after: { kept: keepContactId, merged: mergeContactId },
    snapshotGroups: [
      ...(mergedRow ? [buildReinsertGroup('fixed_contacts', [mergedRow])] : []),
      ...(movedRows.length > 0 ? [buildRevertGroup('interactions', movedRows)] : []),
    ],
  });
  return { status: 'applied', detail: { kept: keepContactId, merged: mergeContactId } };
});

registerDecisionResolver('archive_completed', async ({ userId, payload, now }) => {
  const beforeDate = readYmd(payload, 'beforeDate') ?? readYmd(payload, 'date');
  if (beforeDate === null) {
    return { status: 'invalid', detail: { reason: 'payload_requires_beforeDate' } };
  }
  const result = await query(
    `DELETE FROM todo_completions WHERE user_id = $1 AND occurrence_date < $2::date RETURNING id`,
    [userId, beforeDate],
  );
  return {
    status: 'applied',
    detail: { archived: result.rows.length, beforeDate, at: now.toISOString() },
  };
});

registerDecisionResolver('adjust_cadence', async ({ userId, payload }) => {
  const contactId = readPositiveInt(payload, 'contactId');
  const cadenceDays = readPositiveInt(payload, 'cadenceDays');
  if (contactId === null || cadenceDays === null || cadenceDays > 3650) {
    return { status: 'invalid', detail: { reason: 'payload_requires_contactId_and_cadenceDays' } };
  }
  const result = await query(
    `UPDATE fixed_contacts SET cadence_days = $3 WHERE id = $2 AND user_id = $1 RETURNING id`,
    [userId, contactId, cadenceDays],
  );
  if (result.rows.length === 0) return { status: 'target_missing', detail: { contactId } };
  return { status: 'applied', detail: { contactId, cadenceDays } };
});

registerDecisionResolver('accept_tag', async ({ userId, payload }) => {
  const eventId = readPositiveInt(payload, 'eventId');
  const tag = readTag(payload);
  if (eventId === null || tag === null) {
    return { status: 'invalid', detail: { reason: 'payload_requires_eventId_and_tag' } };
  }
  const result = await query(
    `UPDATE events
     SET tags = CASE
       WHEN COALESCE(tags, '[]'::jsonb) @> jsonb_build_array($3::text)
         THEN COALESCE(tags, '[]'::jsonb)
       ELSE COALESCE(tags, '[]'::jsonb) || jsonb_build_array($3::text)
     END
     WHERE id = $2 AND user_id = $1
     RETURNING id`,
    [userId, eventId, tag],
  );
  if (result.rows.length === 0) return { status: 'target_missing', detail: { eventId } };
  return { status: 'applied', detail: { eventId, tag } };
});

// ---------------------------------------------------------------------------
// Question-card cap (separate from the notification budget)
// ---------------------------------------------------------------------------

/** Daily cap for question cards; env override `AGENT_QUESTION_CARD_DAILY_CAP`. */
export const DEFAULT_QUESTION_CARD_DAILY_CAP = 5;
export const QUESTION_CARD_CAP_ENV = 'AGENT_QUESTION_CARD_DAILY_CAP';

export function readQuestionCardCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env[QUESTION_CARD_CAP_ENV] ?? '').trim();
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_QUESTION_CARD_DAILY_CAP;
}

export interface QuestionCardCapStatus {
  day: string;
  used: number;
  cap: number;
  reached: boolean;
}

/** Count today's question cards for the user's LOCAL day (tz-aware, db-side). */
export async function countQuestionCardsToday(
  userId: number,
  timezone: string,
  now: Date = new Date(),
): Promise<number> {
  const day = getLocalDayKey(now, timezone);
  const result = await query(
    `SELECT COUNT(*)::int AS count
     FROM agent_decision_cards
     WHERE user_id = $1 AND is_question = TRUE
       AND (created_at AT TIME ZONE $2)::date = $3::date`,
    [userId, timezone, day],
  );
  const count = Number((result.rows[0] as Record<string, unknown> | undefined)?.count);
  return Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
}

export async function checkQuestionCardCap(
  userId: number,
  timezone: string,
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<QuestionCardCapStatus> {
  const cap = readQuestionCardCap(env);
  const day = getLocalDayKey(now, timezone);
  const used = await countQuestionCardsToday(userId, timezone, now);
  return { day, used, cap, reached: used >= cap };
}

// ---------------------------------------------------------------------------
// Propose
// ---------------------------------------------------------------------------

export interface ProposeDecisionInput {
  userId: number;
  subjectKind: DecisionSubjectKind;
  subjectRef?: string | null;
  summary: string;
  payload?: Record<string, unknown>;
  idempotencyKey: string;
  isQuestion?: boolean;
  timezone?: string;
  now?: Date;
}

export type ProposeDecisionOutcome = 'created' | 'existing' | 'suppressed';
export type ProposeSuppressionReason = 'policy_rejection' | 'question_card_cap';

export interface ProposeDecisionResult {
  outcome: ProposeDecisionOutcome;
  reason?: ProposeSuppressionReason;
  card: DecisionCardRow | null;
  created: boolean;
  inboxMessageId: number | null;
  notified: boolean;
  policy: PolicyVerdict | null;
  questionCap: QuestionCardCapStatus | null;
  budget: TodayBudgetUsage | null;
}

export async function loadUserTimezone(userId: number): Promise<string> {
  const result = await query('SELECT timezone FROM user_configs WHERE user_id = $1', [userId]);
  const raw = (result.rows[0] as Record<string, unknown> | undefined)?.timezone;
  return normalizeTimezone(raw);
}

const INSERT_CARD_SQL = `
INSERT INTO agent_decision_cards
  (user_id, subject_kind, subject_ref, action, summary, payload, idempotency_key, is_question)
VALUES ($1, $2, $3, 'propose', $4, $5::jsonb, $6, $7)
ON CONFLICT (user_id, idempotency_key) DO NOTHING
RETURNING *`;

const SELECT_CARD_BY_KEY_SQL = `
SELECT * FROM agent_decision_cards WHERE user_id = $1 AND idempotency_key = $2 LIMIT 1`;

/**
 * Create a decision card: Inbox entry always; ONE budget-gated push.
 * The policy memory is consulted first — a previously rejected subject is
 * suppressed (never re-proposed), and question cards obey their own daily cap.
 */
export async function proposeDecision(input: ProposeDecisionInput): Promise<ProposeDecisionResult> {
  const resolver = getDecisionResolver(input.subjectKind);
  if (!resolver) {
    throw new Error(`Unknown decision subject kind: ${String(input.subjectKind)}`);
  }

  const summary = sanitizeSummary(input.summary);
  if (summary === '') throw new Error('decision summary is required');
  const now = input.now ?? new Date();
  const subject = decisionFeedbackSubject({
    subject_kind: input.subjectKind,
    subject_ref: input.subjectRef ?? null,
  });

  // 1. Policy memory: suppress anything the user rejected (most recent rule).
  const policy = await checkPolicyForProposal(input.userId, subject);
  if (policy.suppressed) {
    log.info(
      { event: 'decision_proposal_suppressed', userId: input.userId, subject, reason: policy.reason },
      'Proposal suppressed by the feedback policy digest',
    );
    return {
      outcome: 'suppressed', reason: 'policy_rejection', card: null, created: false,
      inboxMessageId: null, notified: false, policy, questionCap: null, budget: null,
    };
  }

  // 2. Question-card cap (its own counter, NOT the notification budget).
  const timezone = input.timezone ?? (await loadUserTimezone(input.userId));
  let questionCap: QuestionCardCapStatus | null = null;
  if (input.isQuestion === true) {
    questionCap = await checkQuestionCardCap(input.userId, timezone, now);
    if (questionCap.reached) {
      log.info(
        { event: 'decision_question_card_cap_reached', userId: input.userId, used: questionCap.used, cap: questionCap.cap },
        'Question-card cap reached; proposal suppressed',
      );
      return {
        outcome: 'suppressed', reason: 'question_card_cap', card: null, created: false,
        inboxMessageId: null, notified: false, policy, questionCap, budget: null,
      };
    }
  }

  // 3. Idempotent insert.
  const inserted = await query(INSERT_CARD_SQL, [
    input.userId,
    input.subjectKind,
    input.subjectRef ?? null,
    summary,
    JSON.stringify(input.payload ?? {}),
    input.idempotencyKey,
    input.isQuestion === true,
  ]);

  if (inserted.rows.length === 0) {
    const existing = await query(SELECT_CARD_BY_KEY_SQL, [input.userId, input.idempotencyKey]);
    const card = existing.rows[0]
      ? mapCard(existing.rows[0] as Record<string, unknown>)
      : null;
    return {
      outcome: 'existing', card, created: false, inboxMessageId: null, notified: false,
      policy, questionCap, budget: null,
    };
  }
  const card = mapCard(inserted.rows[0] as Record<string, unknown>);

  // 4. Inbox entry (always — the card is visible even when the push is skipped).
  const inbox = await createInboxMessage({
    userId: input.userId,
    title: `需要你的决定：${summary.slice(0, 120)}`,
    body: `${summary}\n\n可在「决定卡片」中批准、编辑或拒绝。`,
    source: 'notification',
    channel: 'decision_card',
    senderLabel: 'TimeMark 助手',
  });

  // 5. ONE push, only within the notification budget.
  const usage = await getTodayBudgetUsage(input.userId, timezone, now);
  let notified = false;
  if (usage.remaining > 0) {
    const consumed = await tryConsumeDailyBudget(input.userId, usage.day, usage.limit);
    if (consumed.allowed) {
      notified = await sendDecisionPush(card);
    }
  } else {
    await recordSuppressedNotification(input.userId, usage.day);
  }

  return {
    outcome: 'created', card, created: true,
    inboxMessageId: inbox?.id ?? null, notified, policy, questionCap, budget: usage,
  };
}

// ---------------------------------------------------------------------------
// Decide (approve / edit / reject) — exactly once
// ---------------------------------------------------------------------------

export type DecideOnCardOutcome =
  | 'approved'
  | 'rejected'
  | 'edited'
  | 'already_decided'
  | 'not_found'
  | 'target_missing'
  | 'invalid_payload'
  | 'failed';

export interface DecideOnDecisionCardInput {
  userId: number;
  cardId: number;
  action: DecisionAction;
  /** Optional free-text "Why?" note persisted with the decision. */
  rationale?: string | null;
  /** For `action: 'edit'`: the user-adjusted payload merged over the proposal. */
  payloadOverride?: Record<string, unknown> | null;
  via?: 'api' | 'telegram' | 'routine';
  now?: Date;
}

export interface DecideOnDecisionCardResult {
  outcome: DecideOnCardOutcome;
  card: DecisionCardRow | null;
  resolution: DecisionResolution | null;
}

/** The exactly-once gate: pending -> approved/rejected in ONE conditional UPDATE. */
const CLAIM_CARD_SQL = `
UPDATE agent_decision_cards
SET status = $3,
    rationale = COALESCE($4, rationale),
    edit_payload = COALESCE($5::jsonb, edit_payload),
    decided_at = now()
WHERE id = $1 AND user_id = $2 AND status = 'pending'
RETURNING *`;

const RELEASE_CLAIM_SQL = `
UPDATE agent_decision_cards SET status = 'pending', decided_at = NULL
WHERE id = $1 AND user_id = $2 AND status = 'approved'`;

async function releaseClaim(userId: number, cardId: number): Promise<void> {
  try {
    await query(RELEASE_CLAIM_SQL, [cardId, userId]);
  } catch (error: unknown) {
    log.error(
      { event: 'decision_claim_release_failed', cardId, err: String(error) },
      'Failed to release decision claim',
    );
  }
}

/**
 * Approve / edit / reject a card.
 *
 * The atomic pending->final claim guarantees at-most/exactly-once application:
 * a concurrent second decide updates zero rows, sees the terminal status and
 * returns `already_decided`. Resolvers run only for the winner.
 */
export async function decideOnDecisionCard(
  input: DecideOnDecisionCardInput,
): Promise<DecideOnDecisionCardResult> {
  const now = input.now ?? new Date();
  const nextStatus = input.action === 'reject' ? 'rejected' : 'approved';
  const rationale = normalizeFeedbackRationale(input.rationale ?? null);
  const editPayload = input.action === 'edit' ? (input.payloadOverride ?? null) : null;

  const claimed = await query(CLAIM_CARD_SQL, [
    input.cardId,
    input.userId,
    nextStatus,
    rationale,
    editPayload === null ? null : JSON.stringify(editPayload),
  ]);

  if (claimed.rows.length === 0) {
    const existing = await query(
      `SELECT * FROM agent_decision_cards WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [input.cardId, input.userId],
    );
    if (existing.rows.length === 0) return { outcome: 'not_found', card: null, resolution: null };
    return {
      outcome: 'already_decided',
      card: mapCard(existing.rows[0] as Record<string, unknown>),
      resolution: null,
    };
  }

  let card = mapCard(claimed.rows[0] as Record<string, unknown>);

  if (input.action === 'reject') {
    // Rejection applies NOTHING; it only records the decision + "Why?".
    await recordFeedback({
      userId: input.userId,
      kind: 'decision',
      subject: decisionFeedbackSubject(card),
      action: 'reject',
      rationale,
      decisionCardId: card.id,
      detail: { via: input.via ?? 'api' },
    });
    return { outcome: 'rejected', card, resolution: null };
  }

  const resolver = getDecisionResolver(card.subject_kind);
  if (!resolver) {
    await releaseClaim(input.userId, card.id);
    log.error(
      { event: 'decision_resolver_missing', cardId: card.id, subjectKind: card.subject_kind },
      'No resolver registered for decision subject kind; claim released',
    );
    return { outcome: 'failed', card: { ...card, status: 'pending' }, resolution: null };
  }

  const payload: Record<string, unknown> = {
    ...card.payload,
    ...(card.edit_payload ?? {}),
  };

  let resolution: DecisionResolution;
  try {
    resolution = await resolver({ userId: input.userId, card, payload, now });
  } catch (error: unknown) {
    await releaseClaim(input.userId, card.id);
    log.error(
      { event: 'decision_apply_failed', cardId: card.id, subjectKind: card.subject_kind, err: String(error) },
      'Decision resolver threw before completing; claim released',
    );
    return { outcome: 'failed', card: { ...card, status: 'pending' }, resolution: null };
  }

  if (resolution.status === 'invalid') {
    await releaseClaim(input.userId, card.id);
    return { outcome: 'invalid_payload', card: { ...card, status: 'pending' }, resolution };
  }

  if (resolution.status === 'target_missing') {
    // The target was deleted between proposal and approval: a clear terminal
    // state without erroring; nothing was mutated.
    const updated = await query(
      `UPDATE agent_decision_cards
       SET status = 'target_missing', resolution = $3::jsonb
       WHERE id = $1 AND user_id = $2 AND status = 'approved'
       RETURNING *`,
      [card.id, input.userId, JSON.stringify({ ...resolution, checked_at: now.toISOString() })],
    );
    const finalCard = updated.rows[0]
      ? mapCard(updated.rows[0] as Record<string, unknown>)
      : { ...card, status: 'target_missing' as const };
    await recordFeedback({
      userId: input.userId,
      kind: 'decision',
      subject: decisionFeedbackSubject(card),
      action: input.action === 'edit' ? 'edit' : 'approve',
      rationale,
      decisionCardId: card.id,
      detail: { ...(resolution.detail ?? {}), target_missing: true, via: input.via ?? 'api' },
    });
    log.info(
      { event: 'decision_target_missing', cardId: card.id, subjectKind: card.subject_kind },
      'Decision target no longer exists; card moved to target_missing',
    );
    return { outcome: 'target_missing', card: finalCard, resolution };
  }

  await query(
    `UPDATE agent_decision_cards SET resolution = $3::jsonb WHERE id = $1 AND user_id = $2`,
    [card.id, input.userId, JSON.stringify({ ...resolution, applied_at: now.toISOString() })],
  );
  card = { ...card, resolution: { ...resolution, applied_at: now.toISOString() } };

  await recordFeedback({
    userId: input.userId,
    kind: 'decision',
    subject: decisionFeedbackSubject(card),
    action: input.action === 'edit' ? 'edit' : 'approve',
    rationale,
    decisionCardId: card.id,
    detail: {
      ...(resolution.detail ?? {}),
      edited: input.action === 'edit',
      via: input.via ?? 'api',
    },
  });

  return {
    outcome: input.action === 'edit' ? 'edited' : 'approved',
    card,
    resolution,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface ListDecisionCardsOptions {
  status?: DecisionStatus;
  limit?: number;
  includeQuestions?: boolean;
}

export async function listDecisionCards(
  userId: number,
  options: ListDecisionCardsOptions = {},
): Promise<DecisionCardRow[]> {
  const limit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 20)));
  const params: unknown[] = [userId];
  let sql = 'SELECT * FROM agent_decision_cards WHERE user_id = $1';
  if (options.status) {
    params.push(options.status);
    sql += ` AND status = $${params.length}`;
  }
  if (options.includeQuestions === false) {
    sql += ' AND is_question = FALSE';
  }
  params.push(limit);
  sql += ` ORDER BY created_at DESC, id DESC LIMIT $${params.length}`;
  const result = await query(sql, params);
  return (result.rows as Record<string, unknown>[]).map(mapCard);
}

export async function getDecisionCard(userId: number, cardId: number): Promise<DecisionCardRow | null> {
  const result = await query(
    `SELECT * FROM agent_decision_cards WHERE id = $1 AND user_id = $2 LIMIT 1`,
    [cardId, userId],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? mapCard(row) : null;
}

// ---------------------------------------------------------------------------
// Telegram push + `dc:` callback plumbing
// ---------------------------------------------------------------------------

export interface DecisionPushDeps {
  /** Resolve the user's bot token + chat; defaults to the real bot link store. */
  resolveChat?: (userId: number) => Promise<{ token: string; chatId: string } | null>;
  send?: (token: string, params: SendMessageParams) => Promise<unknown>;
}

/** The same token resolution the bot webhook uses (env first, then user config). */
async function resolveBotToken(userId: number): Promise<string | null> {
  const envToken = process.env.TELEGRAM_BOT_TOKEN;
  if (envToken && envToken.trim()) return envToken.trim();
  const config = (await getUserConfig(userId)) as { telegram_bot_token?: unknown } | null;
  const token = config?.telegram_bot_token;
  return typeof token === 'string' && token.trim() ? token.trim() : null;
}

export async function resolveDecisionPushChat(
  userId: number,
): Promise<{ token: string; chatId: string } | null> {
  const token = await resolveBotToken(userId);
  if (!token) return null;
  const result = await query(
    `SELECT chat_id FROM bot_links
     WHERE user_id = $1 AND platform = 'telegram' AND revoked_at IS NULL
     ORDER BY last_seen_at DESC NULLS LAST, id DESC
     LIMIT 1`,
    [userId],
  );
  const chatId = (result.rows[0] as Record<string, unknown> | undefined)?.chat_id;
  if (typeof chatId !== 'string' || chatId === '') return null;
  return { token, chatId };
}

export function buildDecisionKeyboard(
  cardId: number,
): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  return {
    inline_keyboard: [
      [
        { text: '✅ 批准', callback_data: encodeDecisionCallbackData('approve', cardId) },
        { text: '✏️ 编辑', callback_data: encodeDecisionCallbackData('edit', cardId) },
        { text: '❌ 拒绝', callback_data: encodeDecisionCallbackData('reject', cardId) },
      ],
    ],
  };
}

export function buildDecisionPushText(card: DecisionCardRow): string {
  return `🧭 需要你的决定：${sanitizeSummary(card.summary)}\n\n点按下方按钮「批准 / 编辑 / 拒绝」（可附上“Why”说明）。`;
}

/**
 * Send ONE Telegram push with the Approve/Edit/Reject inline keyboard.
 * Best-effort: a missing link/token or a provider error returns `false` and the
 * card simply stays visible in the Inbox (never an error for the caller).
 */
export async function sendDecisionPush(
  card: DecisionCardRow,
  deps: DecisionPushDeps = {},
): Promise<boolean> {
  const resolve = deps.resolveChat ?? resolveDecisionPushChat;
  const send = deps.send ?? sendTelegramMessage;
  let target: { token: string; chatId: string } | null = null;
  try {
    target = await resolve(card.user_id);
  } catch (error: unknown) {
    log.warn(
      { event: 'decision_push_link_lookup_failed', userId: card.user_id, err: String(error) },
      'Decision push chat lookup failed',
    );
    return false;
  }
  if (!target) {
    log.warn(
      { event: 'decision_push_channel_unavailable', userId: card.user_id, cardId: card.id },
      'No linked Telegram chat/token; decision card stays Inbox-only',
    );
    return false;
  }
  try {
    await send(target.token, {
      chatId: target.chatId,
      text: buildDecisionPushText(card),
      replyMarkup: buildDecisionKeyboard(card.id),
    });
    return true;
  } catch (error: unknown) {
    log.warn(
      { event: 'decision_push_failed', cardId: card.id, err: String(error) },
      'Decision push send failed',
    );
    return false;
  }
}

/** `dc:` namespace for decision-card callback data (well within Telegram's 64 bytes). */
export const DECISION_CALLBACK_PREFIX = 'dc:';
export const DECISION_CALLBACK_ACTIONS = ['approve', 'edit', 'reject'] as const;

export function encodeDecisionCallbackData(action: DecisionAction, cardId: number): string {
  if (!Number.isSafeInteger(cardId) || cardId <= 0) {
    throw new Error(`Decision card id must be a positive integer: ${String(cardId)}`);
  }
  if (!(DECISION_CALLBACK_ACTIONS as readonly string[]).includes(action)) {
    throw new Error(`Unknown decision callback action: ${String(action)}`);
  }
  const data = `${DECISION_CALLBACK_PREFIX}${action}:${cardId}`;
  if (!isCallbackDataWithinLimit(data)) {
    throw new Error(`callback_data exceeds ${CALLBACK_DATA_MAX_BYTES} bytes: ${data}`);
  }
  return data;
}

/** Tolerant decode: `null` for anything malformed, unknown, oversized or non-`dc:`. */
export function decodeDecisionCallbackData(
  raw: unknown,
): { action: DecisionAction; cardId: number } | null {
  if (typeof raw !== 'string' || !raw.startsWith(DECISION_CALLBACK_PREFIX)) return null;
  if (!isCallbackDataWithinLimit(raw)) return null;
  const parts = raw.split(':');
  if (parts.length !== 3 || parts[0] !== 'dc') return null;
  const action = parts[1];
  if (!(DECISION_CALLBACK_ACTIONS as readonly string[]).includes(action)) return null;
  if (!/^\d{1,16}$/.test(parts[2])) return null;
  const cardId = Number(parts[2]);
  if (!Number.isSafeInteger(cardId) || cardId <= 0) return null;
  return { action: action as DecisionAction, cardId };
}

export interface DecisionCallbackContext {
  /** The raw `callback_data` string (already known to start with `dc:`). */
  data: string;
  userId: number;
  chatId: string | null;
  messageId: number | null;
  toast: (text: string) => Promise<void>;
  edit: (text: string, replyMarkup?: unknown) => Promise<void>;
}

const CALLBACK_ANSWER_INVALID = '无法识别该操作';
const CALLBACK_ANSWER_MISSING = '该决定已不存在';
const CALLBACK_ANSWER_ALREADY = '该决定已处理';
const CALLBACK_ANSWER_FAILED = '操作失败，请稍后重试';
const REMOVE_KEYBOARD = { inline_keyboard: [] };

const STATUS_LABEL: Record<DecisionStatus, string> = {
  pending: '待处理',
  approved: '已批准',
  rejected: '已拒绝',
  target_missing: '目标已不存在',
  expired: '已过期',
};

/**
 * The `dc:` half of the bot callback path: approve / reject apply the decision
 * exactly once, `edit` points the user at the app, and every terminal state gets
 * a friendly toast + edited message.
 */
export async function handleDecisionCallbackQuery(
  ctx: DecisionCallbackContext,
): Promise<CallbackHandleResult> {
  const parsed = decodeDecisionCallbackData(ctx.data);
  if (!parsed) {
    await ctx.toast(CALLBACK_ANSWER_INVALID);
    return { handled: false, outcome: 'invalid' };
  }

  if (parsed.action === 'edit') {
    // A button tap cannot carry a "Why?" note; the edit+reason flow lives in the app.
    await ctx.toast('请在 TimeMark 应用中编辑并确认');
    return { handled: true, outcome: 'open' };
  }

  let result: DecideOnDecisionCardResult;
  try {
    result = await decideOnDecisionCard({
      userId: ctx.userId,
      cardId: parsed.cardId,
      action: parsed.action,
      via: 'telegram',
    });
  } catch (error: unknown) {
    log.error(
      { event: 'decision_callback_failed', cardId: parsed.cardId, err: String(error) },
      'Decision callback failed',
    );
    await ctx.toast(CALLBACK_ANSWER_FAILED);
    return { handled: true, outcome: 'failed' };
  }

  switch (result.outcome) {
    case 'approved':
    case 'edited': {
      await ctx.toast('✅ 已批准');
      await ctx.edit(`✅ 已批准：${sanitizeSummary(result.card?.summary ?? '')}`, REMOVE_KEYBOARD);
      return { handled: true, outcome: 'done' };
    }
    case 'rejected': {
      await ctx.toast('❌ 已拒绝');
      await ctx.edit(`❌ 已拒绝：${sanitizeSummary(result.card?.summary ?? '')}`, REMOVE_KEYBOARD);
      return { handled: true, outcome: 'done' };
    }
    case 'already_decided': {
      const status = result.card?.status ?? 'pending';
      await ctx.toast(CALLBACK_ANSWER_ALREADY);
      await ctx.edit(`ℹ️ 该决定已处理（${STATUS_LABEL[status]}）`, REMOVE_KEYBOARD);
      return { handled: true, outcome: 'already_done' };
    }
    case 'target_missing': {
      await ctx.toast(CALLBACK_ANSWER_MISSING);
      await ctx.edit('⚠️ 目标已不存在', REMOVE_KEYBOARD);
      return { handled: true, outcome: 'missing' };
    }
    case 'not_found': {
      await ctx.toast(CALLBACK_ANSWER_MISSING);
      return { handled: true, outcome: 'missing' };
    }
    case 'invalid_payload': {
      await ctx.toast(CALLBACK_ANSWER_INVALID);
      return { handled: false, outcome: 'invalid' };
    }
    default: {
      await ctx.toast(CALLBACK_ANSWER_FAILED);
      return { handled: true, outcome: 'failed' };
    }
  }
}
