import { query } from '../../db/index.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('agent.feedback');

/**
 * Task 127 — durable feedback memory.
 *
 * Every decision (approve/edit/reject + the optional free-text "Why?") and every
 * correction is persisted twice:
 *
 *   1. one append-only row in `agent_feedback` (audit + latest-wins policy), and
 *   2. one derived row in `user_patterns` (kind = 'decision_feedback') so the
 *      miner's confidence for the subject rises from REAL feedback.
 *
 * The derived pattern rows are preserved by `recomputePatterns` (the miner only
 * replaces its own kinds) — feedback memory survives the nightly recompute.
 *
 * HARD SETTINGS ARE CONFIG, NOT MEMORY. Quiet hours and the notification budget
 * can never be silently overridden by a decision or a correction: feedback about
 * them is still recorded for audit, but it creates NO pattern row, NO digest
 * line, and NO proposal suppression. This is asserted in
 * `assertNotHardSettingOverride` and applied on every write path below.
 *
 * CONFLICT RULE. Contradictory feedback on the same subject (approve then
 * reject, or reject then approve) resolves to the MOST RECENT decision - the
 * effective action is always the latest row - and the flip is LOGGED as a
 * conflict (`agent_feedback_conflict`), never oscillated back and forth.
 */

export const AGENT_FEEDBACK_KINDS = ['decision', 'correction'] as const;
export type AgentFeedbackKind = (typeof AGENT_FEEDBACK_KINDS)[number];

export const FEEDBACK_ACTIONS = ['approve', 'edit', 'reject', 'correct'] as const;
export type FeedbackAction = (typeof FEEDBACK_ACTIONS)[number];

/** `user_patterns.kind` of the derived feedback rows. */
export const FEEDBACK_PATTERN_KIND = 'decision_feedback';

/**
 * Hard settings — configuration authority, never feedback authority.
 * A subject that IS (or starts with) one of these keys can be commented on by
 * the user, but the comment is audit-only: it cannot suppress, enable or mutate
 * the setting. Quiet hours live in user config; the notification budget lives in
 * `notification-budget.service.ts`.
 */
export const HARD_SETTING_SUBJECTS = [
  'quiet_hours',
  'notification_budget',
  'notification_budget_per_day',
  'budget',
] as const;

export function isHardSettingSubject(subject: string): boolean {
  const normalized = subject.trim().toLowerCase();
  if (normalized === '') return false;
  return HARD_SETTING_SUBJECTS.some(
    (key) => normalized === key || normalized.startsWith(`${key}:`) || normalized.startsWith(`${key}.`),
  );
}

/**
 * Assertion used on every write path: feedback may only influence SOFT policy.
 * Returns `true` when the subject is safe to derive memory from, `false` (with a
 * log line) when the subject is a hard setting whose value stays in config.
 */
export function assertNotHardSettingOverride(subject: string): boolean {
  if (!isHardSettingSubject(subject)) return true;
  log.info(
    { event: 'agent_feedback_hard_setting_config_only', subject },
    'Feedback about a hard setting is audit-only; the setting stays on configuration',
  );
  return false;
}

/** Cap the persisted "Why?" note (UTF-16 code units) so one note cannot bloat a row. */
export const FEEDBACK_RATIONALE_MAX_CHARS = 500;

export function normalizeFeedbackRationale(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    // eslint-disable-next-line no-control-regex -- strips ASCII control characters from user notes
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned === '') return null;
  return cleaned.slice(0, FEEDBACK_RATIONALE_MAX_CHARS);
}

export interface AgentFeedbackRow {
  id: number;
  user_id: number;
  kind: AgentFeedbackKind;
  subject: string;
  action: FeedbackAction;
  rationale: string | null;
  decision_card_id: number | null;
  detail: Record<string, unknown>;
  created_at: string;
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? '');
}

function mapFeedbackRow(row: Record<string, unknown>): AgentFeedbackRow {
  return {
    id: Number(row.id),
    user_id: Number(row.user_id),
    kind: String(row.kind) as AgentFeedbackKind,
    subject: String(row.subject),
    action: String(row.action) as FeedbackAction,
    rationale: row.rationale == null ? null : String(row.rationale),
    decision_card_id: row.decision_card_id == null ? null : Number(row.decision_card_id),
    detail: (row.detail ?? {}) as Record<string, unknown>,
    created_at: toIso(row.created_at),
  };
}

export interface RecordFeedbackInput {
  userId: number;
  kind: AgentFeedbackKind;
  subject: string;
  action: FeedbackAction;
  rationale?: string | null;
  decisionCardId?: number | null;
  detail?: Record<string, unknown>;
}

export interface RecordFeedbackResult {
  conflict: boolean;
  /** Action of the previous row for the same subject, if any. */
  previousAction: FeedbackAction | null;
  /** The effective action after this write — always the most recent one. */
  effectiveAction: FeedbackAction;
}

/** The latest feedback row for one subject; recency (then id) breaks ties. */
export async function getLatestFeedback(
  userId: number,
  subject: string,
): Promise<AgentFeedbackRow | null> {
  const result = await query(
    `SELECT id, user_id, kind, subject, action, rationale, decision_card_id, detail, created_at
     FROM agent_feedback
     WHERE user_id = $1 AND subject = $2
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [userId, subject],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? mapFeedbackRow(row) : null;
}

/**
 * True when the two actions flip polarity on the same subject. `edit` counts as
 * an acceptance (an edited proposal was still approved).
 */
export function detectFeedbackConflict(
  previous: FeedbackAction | null,
  next: FeedbackAction,
): boolean {
  if (previous === null) return false;
  const wasAccept = previous === 'approve' || previous === 'edit';
  const wasReject = previous === 'reject';
  const isAccept = next === 'approve' || next === 'edit';
  const isReject = next === 'reject';
  return (wasAccept && isReject) || (wasReject && isAccept);
}

/**
 * Persist one feedback row + the derived `user_patterns` row.
 *
 * Conflict handling: the flip is detected against the previous row and LOGGED
 * (`agent_feedback_conflict`, resolution = most_recent_wins); both rows stay in
 * `agent_feedback`, and every reader takes the newest one, so the policy never
 * oscillates.
 */
export async function recordFeedback(input: RecordFeedbackInput): Promise<RecordFeedbackResult> {
  const subject = input.subject.trim();
  if (subject === '') throw new Error('agent feedback subject is required');
  const rationale = normalizeFeedbackRationale(input.rationale);

  const previous = await getLatestFeedback(input.userId, subject);
  const conflict = previous !== null && detectFeedbackConflict(previous.action, input.action);
  if (conflict && previous) {
    log.warn(
      {
        event: 'agent_feedback_conflict',
        userId: input.userId,
        subject,
        previous: previous.action,
        next: input.action,
        resolution: 'most_recent_wins',
      },
      'Contradictory feedback on the same subject; most recent decision wins',
    );
  }

  const detail: Record<string, unknown> = { ...(input.detail ?? {}) };
  if (conflict && previous) {
    detail.conflict_with = previous.action;
    detail.conflict_at = previous.created_at;
  }

  await query(
    `INSERT INTO agent_feedback (user_id, kind, subject, action, rationale, decision_card_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      input.userId,
      input.kind,
      subject,
      input.action,
      rationale,
      input.decisionCardId ?? null,
      JSON.stringify(detail),
    ],
  );

  // Derived miner-visible row. Hard settings are audit-only (config authority),
  // and a target_missing approval is not a real preference either.
  const targetMissing = detail.target_missing === true;
  if (!targetMissing && assertNotHardSettingOverride(subject)) {
    await upsertFeedbackPattern(input.userId, subject, input.action, rationale);
  }

  return {
    conflict,
    previousAction: previous?.action ?? null,
    effectiveAction: input.action,
  };
}

async function upsertFeedbackPattern(
  userId: number,
  subject: string,
  action: FeedbackAction,
  rationale: string | null,
): Promise<void> {
  const value = JSON.stringify({
    subject,
    last_action: action,
    last_rationale: rationale,
    last_at: new Date().toISOString(),
  });
  // First feedback row starts at 0.5 confidence; every further signal raises it
  // by 0.1 up to 0.95 so the miner's confidence rises from real feedback.
  await query(
    `INSERT INTO user_patterns (user_id, kind, key, value, confidence, evidence_count, computed_at)
     VALUES ($1, $2, $3, $4::jsonb, 0.5, 1, CURRENT_TIMESTAMP)
     ON CONFLICT (user_id, kind, key) DO UPDATE SET
       value = EXCLUDED.value,
       confidence = LEAST(0.95, user_patterns.confidence + 0.1),
       evidence_count = user_patterns.evidence_count + 1,
       computed_at = CURRENT_TIMESTAMP`,
    [userId, FEEDBACK_PATTERN_KIND, subject, value],
  );
}

/** Convenience wrapper: a non-decision correction (e.g. "把默认提醒改成 8 点"). */
export async function recordCorrection(
  userId: number,
  subject: string,
  rationale?: string | null,
  detail?: Record<string, unknown>,
): Promise<RecordFeedbackResult> {
  return recordFeedback({
    userId,
    kind: 'correction',
    subject,
    action: 'correct',
    rationale,
    detail,
  });
}

/** The effective (most recent) decision for one subject — the conflict rule. */
export async function getEffectiveDecision(
  userId: number,
  subject: string,
): Promise<{ action: FeedbackAction; rationale: string | null; decidedAt: string } | null> {
  const latest = await getLatestFeedback(userId, subject);
  if (!latest) return null;
  return { action: latest.action, rationale: latest.rationale, decidedAt: latest.created_at };
}

export interface PolicyVerdict {
  suppressed: boolean;
  reason: 'recent_rejection' | null;
  since: string | null;
  rationale: string | null;
  hardSetting: boolean;
}

/**
 * Propose-path guard: after a rejection, proposing the same subject again is
 * suppressed (pre-flagged) until a NEWER approve/edit flips the most recent
 * decision back. Hard settings are exempt — configuration decides for them.
 */
export async function checkPolicyForProposal(userId: number, subject: string): Promise<PolicyVerdict> {
  const normalized = subject.trim();
  if (normalized === '') {
    return { suppressed: false, reason: null, since: null, rationale: null, hardSetting: false };
  }
  if (isHardSettingSubject(normalized)) {
    // Feedback can never override a hard setting; config is the only authority.
    return { suppressed: false, reason: null, since: null, rationale: null, hardSetting: true };
  }
  const latest = await getLatestFeedback(userId, normalized);
  if (latest && latest.action === 'reject') {
    return {
      suppressed: true,
      reason: 'recent_rejection',
      since: latest.created_at,
      rationale: latest.rationale,
      hardSetting: false,
    };
  }
  return { suppressed: false, reason: null, since: null, rationale: null, hardSetting: false };
}

// ---------------------------------------------------------------------------
// Bounded "policies" digest (injected into assistant / routine prompts)
// ---------------------------------------------------------------------------

/**
 * Hard cap for the policies digest injected into a prompt. Retrieval is
 * bounded twice: top-K items by recency x relevance, and this character cap.
 * The prompt can NEVER grow unbounded with feedback history.
 */
export const POLICY_DIGEST_MAX_CHARS = 1200;
export const POLICY_DIGEST_MAX_ITEMS = 8;
export const POLICY_DIGEST_WINDOW_DAYS = 120;
export const POLICY_DIGEST_LINE_MAX_CHARS = 160;
export const POLICY_DIGEST_HEADER = '用户政策记忆（来自历史反馈；不得静默违反硬性设置）';

const ACTION_WEIGHT: Record<FeedbackAction, number> = {
  reject: 3,
  correct: 2.5,
  edit: 1.5,
  approve: 1,
};

const ACTION_LABEL: Record<FeedbackAction, string> = {
  reject: '拒绝过',
  approve: '批准过',
  edit: '修改后批准',
  correct: '纠正过',
};

export interface PolicyDigestOptions {
  maxItems?: number;
  maxChars?: number;
  windowDays?: number;
  /** Subjects containing this text are boosted x2 (relevance term). */
  subjectFilter?: string;
  now?: Date;
}

interface DigestCandidate {
  subject: string;
  action: FeedbackAction;
  rationale: string | null;
  createdAt: string;
  detail: Record<string, unknown>;
  score: number;
}

function clampInt(raw: number | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || !Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(raw)));
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Build the compact policies digest: one line per (subject, most recent
 * decision), ranked by recency x relevance, cut at maxChars. Returns '' when the
 * user has no feedback (or only hard-setting/audit-only feedback).
 */
export async function buildPolicyDigest(
  userId: number,
  options: PolicyDigestOptions = {},
): Promise<string> {
  const maxItems = clampInt(options.maxItems, POLICY_DIGEST_MAX_ITEMS, 0, 50);
  const maxChars = clampInt(options.maxChars, POLICY_DIGEST_MAX_CHARS, 0, 100_000);
  const windowDays = clampInt(options.windowDays, POLICY_DIGEST_WINDOW_DAYS, 1, 3650);
  const now = options.now ?? new Date();
  if (maxItems === 0 || maxChars === 0) return '';

  const result = await query(
    `SELECT DISTINCT ON (subject)
       subject, action, rationale, created_at, detail
     FROM agent_feedback
     WHERE user_id = $1
       AND created_at >= now() - make_interval(days => $2::int)
     ORDER BY subject, created_at DESC, id DESC`,
    [userId, windowDays],
  );

  const filter = (options.subjectFilter ?? '').trim().toLowerCase();
  const candidates: DigestCandidate[] = [];
  for (const raw of result.rows as Record<string, unknown>[]) {
    const subject = String(raw.subject ?? '');
    if (subject === '' || isHardSettingSubject(subject)) continue;
    const action = String(raw.action ?? '') as FeedbackAction;
    if (!FEEDBACK_ACTIONS.includes(action)) continue;
    const detail = (raw.detail ?? {}) as Record<string, unknown>;
    // A missing-target approval changed nothing: it must not steer policy.
    if (detail.target_missing === true) continue;

    const created = toDate(raw.created_at) ?? now;
    const ageDays = Math.max(0, (now.getTime() - created.getTime()) / 86_400_000);
    const recency = Math.max(0, 1 - ageDays / windowDays);
    const relevance = filter !== '' && subject.toLowerCase().includes(filter) ? 2 : 1;
    candidates.push({
      subject,
      action,
      rationale: raw.rationale == null ? null : String(raw.rationale),
      createdAt: created.toISOString(),
      detail,
      score: ACTION_WEIGHT[action] * (1 + recency) * relevance,
    });
  }

  candidates.sort((a, b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt));

  const lines: string[] = [];
  let used = 0;
  for (const candidate of candidates.slice(0, maxItems)) {
    const day = candidate.createdAt.slice(0, 10);
    const why = candidate.rationale ? `（原因：${candidate.rationale}）` : '';
    const rawLine = `- ${candidate.subject}：用户 ${day} ${ACTION_LABEL[candidate.action]}${why}`;
    const line = rawLine.length > POLICY_DIGEST_LINE_MAX_CHARS
      ? `${rawLine.slice(0, POLICY_DIGEST_LINE_MAX_CHARS - 1)}…`
      : rawLine;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

/** System-prompt block for the digest; '' when there is nothing to inject. */
export function formatPolicyDigestBlock(digest: string): string {
  if (digest.trim() === '') return '';
  return `## ${POLICY_DIGEST_HEADER}\n${digest}`;
}
