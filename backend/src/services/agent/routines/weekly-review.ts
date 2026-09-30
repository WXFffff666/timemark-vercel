import { query } from '../../../db/index.js';
import { createLogger } from '../../../utils/logger.js';
import type { AgentJobKind, ClaimedJob } from '../queue.service.js';
import type {
  AgentJobHandler,
  AgentJobHandlerContext,
  AgentJobHandlerResult,
} from '../job-runner.service.js';
import {
  IMPORTANCE_NORMAL_BAR,
  IMPORTANCE_URGENT_BAR,
  TRIAGE_BAND_LABELS,
  TRIAGE_IMPORTANCE_BARS,
  importanceBand,
  loadTriageCandidates,
  saveTriageState,
  type RoutineDescriptor,
  type TriageBand,
  type TriageCandidate,
  type TriageStateRow,
  type TriageStateWrite,
} from './hourly-triage.js';

/**
 * Wave 15 routine (`weekly_review`, job kinds 122-125): the weekly digest built on top
 * of the hourly triage memory.
 *
 * It merges two sources into one ranked digest:
 *   1. `agent_triage_state` rows seen in the trailing `WEEKLY_STATE_WINDOW_DAYS`
 *      (what the hourly triage already observed, including below-bar items), and
 *   2. fresh event candidates (`loadTriageCandidates`, 7-day horizon) that the hourly
 *      routine may not have persisted yet.
 *
 * ## Digest-dedupe mechanism (three layers)
 *   1. FINGERPRINT: every item is keyed `event:<id>` and stored once per user
 *      (`UNIQUE (user_id, fingerprint)`), so the two sources merge into one item and
 *      cannot double-count.
 *   2. WEEK KEY: the digest records its ISO week (`2026-W40`) into
 *      `agent_triage_state.digest_week` for every included fingerprint. An item whose
 *      `digest_week` equals the current week is re-rendered as-is but NOT re-counted -
 *      re-running the job inside the same week yields the SAME digest (idempotent),
 *      never a second copy.
 *   3. ONCE-DIGESTED SUPPRESSION: an item that appeared in a PREVIOUS digest is skipped
 *      from later digests unless its importance is still at/above
 *      `WEEKLY_REPEAT_UNLESS_URGENT` (85) - the weekly review must not re-report the
 *      same unchanged item week after week, while a genuinely urgent one stays visible.
 *
 * ## Importance bar
 *   Only items at/above `WEEKLY_MIN_IMPORTANCE` (45 = IMPORTANCE_NORMAL_BAR) are
 *   eligible; the digest shows at most `WEEKLY_TOP_N` (10), ranked by importance,
 *   then by urgency, then by title (fully deterministic).
 *
 * Like the hourly routine it is spend-free: deterministic SQL + pure TS, no AI call,
 * `costTokens: 0`. All data access is an injectable seam for tests.
 */

const log = createLogger('agent.routines.weekly-review');

/** `agent_jobs.kind` value this handler consumes. */
export const WEEKLY_REVIEW_KIND = 'weekly_review' as const;

/** Trailing window of triage-state rows the digest considers. */
export const WEEKLY_STATE_WINDOW_DAYS = 7;
/** Forward horizon for fresh event candidates. */
export const WEEKLY_LOOKAHEAD_DAYS = 7;
/** Hard cap on digest entries per week. */
export const WEEKLY_TOP_N = 10;
/** Surface bar: items below this are never digested (45 = IMPORTANCE_NORMAL_BAR). */
export const WEEKLY_MIN_IMPORTANCE = IMPORTANCE_NORMAL_BAR;
/** Once digested, an item is repeated only while still at/above this bar (85). */
export const WEEKLY_REPEAT_UNLESS_URGENT = IMPORTANCE_URGENT_BAR;

export const WEEKLY_REVIEW_DESCRIPTOR: RoutineDescriptor = {
  kind: WEEKLY_REVIEW_KIND,
  title: '每周回顾',
  description:
    '每周汇总 7 天内的巡检状态与即将到期事项，按重要性排序生成摘要；指纹唯一 + ISO 周键 + 已汇总抑制三层去重，同一周重复运行得到同一份摘要。全流程无 AI 调用。',
  cron: '0 19 * * 0',
  tier: 'high',
  windowDays: WEEKLY_STATE_WINDOW_DAYS,
  dedupeWindowHours: null,
  importanceBars: TRIAGE_IMPORTANCE_BARS,
  topN: WEEKLY_TOP_N,
};

/** Display order of bands inside the digest. */
export const WEEKLY_BAND_ORDER: readonly TriageBand[] = ['urgent', 'high', 'normal', 'fyi'];

export interface WeeklyDigestItem {
  fingerprint: string;
  title: string;
  band: TriageBand;
  importance: number;
  sourceKind: string;
  sourceRef: string | null;
  daysUntil: number | null;
}

export type DigestEligibility = 'included' | 'new' | 'suppressed';

/**
 * Pure dedupe verdict for one item:
 *  - `included`: already part of THIS week's digest -> re-render, do not mark again.
 *  - `new`:      never digested, or digested before but still urgent -> include + mark.
 *  - `suppressed`: digested in an earlier week and no longer urgent -> skip.
 */
export function digestEligibility(
  row: { digestWeek: string | null; importance: number },
  week: string,
): DigestEligibility {
  if (row.digestWeek === week) return 'included';
  if (row.digestWeek === null) return 'new';
  return row.importance >= WEEKLY_REPEAT_UNLESS_URGENT ? 'new' : 'suppressed';
}

/**
 * ISO week key (`YYYY-Www`) computed purely from UTC calendar fields, so the key is
 * stable regardless of the host timezone. This is a calendar LABEL, not an instant
 * comparison: the week boundary follows ISO-8601 (Monday is day 1).
 */
export function isoWeekKey(date: Date): string {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = target.getUTCDay() === 0 ? 7 : target.getUTCDay();
  target.setUTCDate(target.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((target.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Human hint for an item's due date ('' when unknown). */
export function describeDays(daysUntil: number | null): string {
  if (daysUntil === null) return '';
  if (daysUntil < 0) return `（已逾期 ${-daysUntil} 天）`;
  if (daysUntil === 0) return '（今天）';
  return `（${daysUntil} 天后）`;
}

/** Deterministic markdown rendering of the digest (no AI, no timestamps from the host TZ). */
export function renderWeeklyDigestMarkdown(input: {
  week: string;
  items: WeeklyDigestItem[];
  generatedAt: Date;
  deduped: number;
  belowBar: number;
}): string {
  const lines: string[] = [];
  lines.push(`# 📋 每周回顾（${input.week}）`);
  lines.push('');
  if (input.items.length === 0) {
    lines.push('本周没有达到重要性门槛的新事项。');
  } else {
    for (const band of WEEKLY_BAND_ORDER) {
      const group = input.items.filter((item) => item.band === band);
      if (group.length === 0) continue;
      lines.push(`## ${TRIAGE_BAND_LABELS[band]}（${group.length}）`);
      for (const item of group) {
        lines.push(`- ${item.title}${describeDays(item.daysUntil)} · 重要性 ${item.importance}`);
      }
      lines.push('');
    }
  }
  lines.push(
    `> 已去重 ${input.deduped} 项 · 低于门槛 ${input.belowBar} 项 · 生成于 ${input.generatedAt.toISOString()}`,
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// SQL (exported so tests can execute the shipped text verbatim)
// ---------------------------------------------------------------------------

/** Triage-state rows observed in the trailing window (dedupe verdicts applied in TS). */
export const WEEKLY_STATE_SELECT_SQL = `
SELECT fingerprint, title, source_kind, source_ref, importance, last_surfaced_at, surfaced_count, digest_week
FROM agent_triage_state
WHERE user_id = $1
  AND last_seen_at >= now() - make_interval(days => $2::int)
ORDER BY importance DESC, last_seen_at DESC
LIMIT 200`;

/** Mark the included fingerprints as digested for this ISO week (idempotent UPDATE). */
export const WEEKLY_DIGEST_MARK_SQL = `
UPDATE agent_triage_state
SET digest_week = $3, last_surface_kind = 'weekly_review', last_surfaced_at = now()
WHERE user_id = $1 AND fingerprint = ANY($2::text[])`;

// ---------------------------------------------------------------------------
// Data access (default implementations of the injectable seams)
// ---------------------------------------------------------------------------

export async function loadWeeklyState(
  userId: number,
  windowDays: number = WEEKLY_STATE_WINDOW_DAYS,
): Promise<TriageStateRow[]> {
  const result = await query(WEEKLY_STATE_SELECT_SQL, [userId, windowDays]);
  const rows: TriageStateRow[] = [];
  for (const row of result.rows as Array<Record<string, unknown>>) {
    const fingerprint = typeof row.fingerprint === 'string' ? row.fingerprint : '';
    if (fingerprint === '') continue;
    const importance = Number(row.importance);
    rows.push({
      fingerprint,
      title: typeof row.title === 'string' ? row.title : '',
      sourceKind: typeof row.source_kind === 'string' ? row.source_kind : 'event',
      sourceRef: row.source_ref == null ? null : String(row.source_ref),
      importance: Number.isFinite(importance) ? Math.trunc(importance) : 0,
      lastSurfacedAt: (row.last_surfaced_at ?? null) as Date | string | null,
      surfacedCount: Number.isFinite(Number(row.surfaced_count)) ? Math.trunc(Number(row.surfaced_count)) : 0,
      digestWeek: row.digest_week == null ? null : String(row.digest_week),
    });
  }
  return rows;
}

export async function markDigestIncluded(
  userId: number,
  fingerprints: string[],
  week: string,
): Promise<number> {
  if (fingerprints.length === 0) return 0;
  const result = await query(WEEKLY_DIGEST_MARK_SQL, [userId, fingerprints, week]);
  return result.rowCount ?? 0;
}

function daysRank(daysUntil: number | null): number {
  return daysUntil === null ? Number.MAX_SAFE_INTEGER : daysUntil;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export interface WeeklyReviewSummary {
  kind: typeof WEEKLY_REVIEW_KIND;
  week: string;
  generatedAt: string;
  items: WeeklyDigestItem[];
  markdown: string;
  counts: {
    merged: number;
    stateRows: number;
    candidates: number;
    deduped: number;
    belowBar: number;
    included: number;
    freshlyMarked: number;
  };
}

export interface WeeklyReviewDeps {
  /** Injectable clock; the ISO week key is derived from it. */
  now?: () => Date;
  loadState?: (userId: number, windowDays: number) => Promise<TriageStateRow[]>;
  loadCandidates?: (userId: number, lookaheadDays: number) => Promise<TriageCandidate[]>;
  saveState?: (userId: number, writes: TriageStateWrite[], nowMs: number) => Promise<number>;
  markIncluded?: (userId: number, fingerprints: string[], week: string) => Promise<number>;
}

interface MergedEntry {
  item: WeeklyDigestItem;
  digestWeek: string | null;
}

/**
 * Build the `weekly_review` job handler. Production uses {@link weeklyReviewHandler};
 * tests inject the seams and assert the digest without a database.
 */
export function createWeeklyReviewHandler(deps: WeeklyReviewDeps = {}): AgentJobHandler {
  const now = deps.now ?? (() => new Date());
  const loadState = deps.loadState ?? loadWeeklyState;
  const loadCandidates = deps.loadCandidates ?? loadTriageCandidates;
  const saveState = deps.saveState ?? saveTriageState;
  const markIncluded = deps.markIncluded ?? markDigestIncluded;

  return async function execute(
    job: ClaimedJob,
    context: AgentJobHandlerContext,
  ): Promise<AgentJobHandlerResult> {
    const userId = job.userId;
    if (userId === null) {
      return { result: { skipped: true, reason: 'no_user' }, costTokens: 0 };
    }

    const generatedAt = now();
    const week = isoWeekKey(generatedAt);

    const [stateRows, candidates] = await Promise.all([
      loadState(userId, WEEKLY_STATE_WINDOW_DAYS),
      loadCandidates(userId, WEEKLY_LOOKAHEAD_DAYS),
    ]);

    // Merge both sources by fingerprint; fresh candidates win on score/title/due.
    // (A candidate without a state row has never been digested -> digestWeek null.)
    const merged = new Map<string, MergedEntry>();
    for (const row of stateRows) {
      merged.set(row.fingerprint, {
        item: {
          fingerprint: row.fingerprint,
          title: (row.title ?? '').trim().slice(0, 200) || '未命名事项',
          band: importanceBand(row.importance),
          importance: row.importance,
          sourceKind: row.sourceKind ?? 'event',
          sourceRef: row.sourceRef ?? null,
          daysUntil: null,
        },
        digestWeek: row.digestWeek,
      });
    }
    const candidateByFingerprint = new Map<string, TriageCandidate>();
    for (const candidate of candidates) {
      candidateByFingerprint.set(candidate.fingerprint, candidate);
      const existing = merged.get(candidate.fingerprint);
      merged.set(candidate.fingerprint, {
        item: {
          fingerprint: candidate.fingerprint,
          title: candidate.title,
          band: candidate.band,
          importance: candidate.importance,
          sourceKind: candidate.sourceKind,
          sourceRef: candidate.sourceRef,
          daysUntil: candidate.daysUntil,
        },
        digestWeek: existing ? existing.digestWeek : null,
      });
    }

    let deduped = 0;
    let belowBar = 0;
    const includedAgain: MergedEntry[] = [];
    const freshIncluded: MergedEntry[] = [];
    for (const entry of merged.values()) {
      if (entry.item.importance < WEEKLY_MIN_IMPORTANCE) {
        belowBar += 1;
        continue;
      }
      const verdict = digestEligibility(
        { digestWeek: entry.digestWeek, importance: entry.item.importance },
        week,
      );
      if (verdict === 'suppressed') {
        deduped += 1;
        continue;
      }
      if (verdict === 'included') includedAgain.push(entry);
      else freshIncluded.push(entry);
    }

    // Same-week inclusions first (stable digest on re-run), then fresh items; both
    // sorted deterministically and capped at WEEKLY_TOP_N.
    const selected = [...includedAgain, ...freshIncluded]
      .sort(
        (a, b) =>
          b.item.importance - a.item.importance ||
          daysRank(a.item.daysUntil) - daysRank(b.item.daysUntil) ||
          a.item.title.localeCompare(b.item.title),
      )
      .slice(0, WEEKLY_TOP_N)
      .map((entry) => entry.item);
    const selectedFingerprints = new Set(selected.map((item) => item.fingerprint));

    // Persist only the fresh selections: candidates get a real state row first
    // (upsert), then every selected fingerprint is stamped with this ISO week.
    const freshWrites: TriageStateWrite[] = [];
    for (const entry of freshIncluded) {
      if (!selectedFingerprints.has(entry.item.fingerprint)) continue;
      const candidate = candidateByFingerprint.get(entry.item.fingerprint);
      if (candidate) {
        freshWrites.push({ candidate, surfaced: true, surfaceKind: WEEKLY_REVIEW_KIND });
      }
    }
    if (freshWrites.length > 0) {
      await saveState(userId, freshWrites, generatedAt.getTime());
    }
    if (selected.length > 0) {
      await markIncluded(userId, [...selectedFingerprints], week);
    }

    const markdown = renderWeeklyDigestMarkdown({
      week,
      items: selected,
      generatedAt,
      deduped,
      belowBar,
    });
    const summary: WeeklyReviewSummary = {
      kind: WEEKLY_REVIEW_KIND,
      week,
      generatedAt: generatedAt.toISOString(),
      items: selected,
      markdown,
      counts: {
        merged: merged.size,
        stateRows: stateRows.length,
        candidates: candidates.length,
        deduped,
        belowBar,
        included: selected.length,
        freshlyMarked: freshWrites.length,
      },
    };
    log.info(
      {
        event: 'agent.weekly_review.done',
        userId,
        tier: context.tier,
        week,
        items: selected.length,
        deduped,
        belowBar,
      },
      'Weekly review digest generated',
    );
    return { result: summary, costTokens: 0 };
  };
}

/** Production handler (real SQL). Spend-free, so it always reports 0 tokens. */
export const weeklyReviewHandler: AgentJobHandler = createWeeklyReviewHandler();

/**
 * Ready-to-spread handler map for `createAgentJobExecutor({ handlers: { ...weeklyReviewHandlers } })`.
 * The executor is owned by another lane; this file never wires itself into routes.
 */
export const weeklyReviewHandlers: Partial<Record<AgentJobKind, AgentJobHandler>> = {
  [WEEKLY_REVIEW_KIND]: weeklyReviewHandler,
};
