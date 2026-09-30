import { query } from '../../db/index.js';
import type { AiEnv, AiModelTier } from '../ai/gateway.js';

/**
 * Checkbox 117: the per-user monthly token/call budget guard.
 *
 * Configuration (environment, read at call time - serverless instances are cold
 * started per invocation and the operator may not redeploy to change a budget):
 *
 *   AGENT_MONTHLY_TOKEN_BUDGET  max provider tokens per user per calendar month
 *   AGENT_MONTHLY_CALL_BUDGET   max metered AI calls per user per calendar month
 *
 * Absent (or malformed/negative) => unlimited. An explicit `0` means "nothing may
 * spend", which is the documented kill switch (a deliberate 0 is NOT unlimited).
 * The deployment is single-user, so "per user" is satisfied by charging every job's
 * `user_id` against its own allowance.
 *
 * Usage is the REAL recorded spend - `agent_jobs.cost_tokens` (checkbox 112), summed
 * for jobs CREATED inside the current calendar month. The month boundary is computed
 * by the database (`date_trunc('month', now())`), never by slicing a UTC ISO string:
 * a JS/UTC slice is a different calendar boundary from the one the data was written
 * under (the repo-wide trigger-date lesson).
 *
 * The guard is a pure decision function plus this data reader; enforcement on the job
 * path lives in `job-runner.service.ts`.
 */

export const MONTHLY_BUDGET_ENV = {
  tokens: 'AGENT_MONTHLY_TOKEN_BUDGET',
  calls: 'AGENT_MONTHLY_CALL_BUDGET',
} as const;

/**
 * Monthly usage for one user. `calls` counts jobs that reported provider usage
 * (`cost_tokens > 0`): a cache hit or a deterministic run performed no metered
 * provider call, so it must not consume the call budget. Jobs are counted by
 * `created_at`; unfinished jobs still carry `cost_tokens = 0` and add nothing.
 */
export const MONTHLY_USAGE_SQL = `
SELECT
  COALESCE(SUM(cost_tokens), 0)::int AS tokens,
  COUNT(*) FILTER (WHERE cost_tokens > 0)::int AS calls
FROM agent_jobs
WHERE user_id = $1
  AND created_at >= date_trunc('month', now())`;

export interface MonthlyBudget {
  /** Token ceiling for the calendar month; `null` = unlimited. */
  tokens: number | null;
  /** Metered-call ceiling for the calendar month; `null` = unlimited. */
  calls: number | null;
}

export interface MonthlyUsage {
  tokens: number;
  calls: number;
}

export type BudgetAction = 'allow' | 'skip' | 'defer';

/** Machine-readable degraded reason, persisted on the job row / job event. */
export type BudgetReason = 'BUDGET_EXHAUSTED_TOKENS' | 'BUDGET_EXHAUSTED_CALLS';

export interface BudgetDecision {
  /**
   * What the caller does: run the job, skip it (lite), or defer it (medium).
   * High always drains; a missing user/budget always allows.
   */
  action: BudgetAction;
  /** Why the job is degraded (/ ran over budget); null while comfortably inside. */
  reason: BudgetReason | null;
  /** True when a configured ceiling is reached or passed (even if `action` is allow). */
  overBudget: boolean;
  budget: MonthlyBudget;
  usage: MonthlyUsage;
}

function parseBudget(raw: string | undefined): number | null {
  const text = (raw ?? '').trim();
  if (text === '') return null;
  const parsed = Number.parseInt(text, 10);
  // A malformed or negative value must never become a surprise block: treat as unlimited.
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

/** Read the monthly ceilings from the environment (see the module comment for semantics). */
export function readMonthlyBudget(env: AiEnv): MonthlyBudget {
  return {
    tokens: parseBudget(env[MONTHLY_BUDGET_ENV.tokens]),
    calls: parseBudget(env[MONTHLY_BUDGET_ENV.calls]),
  };
}

function toCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

/** Sum the current month's recorded spend for one user. */
export async function getMonthlyUsage(userId: number): Promise<MonthlyUsage> {
  const result = await query(MONTHLY_USAGE_SQL, [userId]);
  const row = (result.rows[0] ?? {}) as { tokens?: unknown; calls?: unknown };
  return { tokens: toCount(row.tokens), calls: toCount(row.calls) };
}

/** True when a configured ceiling has been reached (`usage >= budget` = no headroom left). */
export function isBudgetExhausted(budget: MonthlyBudget, usage: MonthlyUsage): boolean {
  const tokensExhausted = budget.tokens !== null && usage.tokens >= budget.tokens;
  const callsExhausted = budget.calls !== null && usage.calls >= budget.calls;
  return tokensExhausted || callsExhausted;
}

/**
 * The guard, pure and deterministic:
 *
 *  - AI off (no provider configured) => allow. The deterministic path must never be
 *    blocked by a budget check (plan criterion 14: every AI feature ships with a
 *    deterministic fallback and no AI variable is required).
 *  - Inside both ceilings => allow, no reason.
 *  - Exhausted: lite jobs are SKIPPED, medium jobs are DEFERRED, high jobs DRAIN
 *    (allowed, flagged `overBudget` so the caller can record that it ran hot).
 */
export function evaluateMonthlyBudget(input: {
  tier: AiModelTier;
  aiConfigured: boolean;
  budget: MonthlyBudget;
  usage: MonthlyUsage;
}): BudgetDecision {
  const { tier, aiConfigured, budget, usage } = input;
  const tokensExhausted = budget.tokens !== null && usage.tokens >= budget.tokens;
  const callsExhausted = budget.calls !== null && usage.calls >= budget.calls;
  const overBudget = tokensExhausted || callsExhausted;
  const reason: BudgetReason | null = !overBudget
    ? null
    : tokensExhausted
      ? 'BUDGET_EXHAUSTED_TOKENS'
      : 'BUDGET_EXHAUSTED_CALLS';

  if (!aiConfigured) {
    // AI is off: nothing can spend, so no budget is applied at all (criterion 14).
    return { action: 'allow', reason: null, overBudget: false, budget, usage };
  }
  if (!overBudget || tier === 'high') {
    return { action: 'allow', reason, overBudget, budget, usage };
  }
  return {
    action: tier === 'lite' ? 'skip' : 'defer',
    reason,
    overBudget: true,
    budget,
    usage,
  };
}
