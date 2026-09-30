-- ============================================================================
-- Pending migration 59 — scheduler_runs / scheduler_ticks (checkbox 115-116)
-- ============================================================================
-- MERGED AS VERSION 59 into backend/src/db/migrate.ts at release. This is the
-- scheduler egress ledger for the self-perpetuating chain: Vercel Workflow DevKit
-- is NOT used, Postgres is the source of truth (see
-- backend/src/services/agent/scheduler.workflow.ts). The orchestrator merges
-- pending files in numeric order; this file follows the landed max (58).
--
-- scheduler_runs  — one row per chain run (status: running -> handed_off when the
--   event threshold is reached, or running -> stalled when the watchdog sees no
--   tick for 3 x tick_interval_ms). The UNIQUE PARTIAL index over
--   (chain_id) WHERE status = 'running' is the concurrency arbiter: both
--   bootstrap and handoff use
--     INSERT ... ON CONFLICT (chain_id) WHERE status = 'running' DO NOTHING
--   + re-select, so concurrent callbacks converge on exactly ONE live run, while
--   history (parents, successors) stays queryable via parent_run_id.
-- scheduler_ticks — one ledger row per executed tick (at most 50 routines per
--   tick), with due/ran/skipped/error counters and a detail jsonb payload.
--
-- Purely additive + idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS only,
-- no ALTER of existing tables, no backfill, re-running is a no-op.
-- ============================================================================

CREATE TABLE IF NOT EXISTS scheduler_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id TEXT NOT NULL DEFAULT 'default',
  parent_run_id UUID REFERENCES scheduler_runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'handed_off', 'stalled', 'stopped')),
  tick_interval_ms INTEGER NOT NULL DEFAULT 600000,
  step_count INTEGER NOT NULL DEFAULT 0,
  event_count INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_tick_at TIMESTAMPTZ,
  handed_off_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Exactly one live run per chain: the arbiter for concurrent bootstrap / handoff
-- (`ON CONFLICT (chain_id) WHERE status = 'running'` infers this partial index).
CREATE UNIQUE INDEX IF NOT EXISTS scheduler_runs_one_live_per_chain
  ON scheduler_runs (chain_id) WHERE status = 'running';

-- Chain history / status reads.
CREATE INDEX IF NOT EXISTS idx_scheduler_runs_chain
  ON scheduler_runs (chain_id, started_at DESC);

CREATE TABLE IF NOT EXISTS scheduler_ticks (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES scheduler_runs(id) ON DELETE CASCADE,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  due_count INTEGER NOT NULL DEFAULT 0,
  ran_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Last-tick lookup for GET /api/agent/scheduler/status and the heartbeat trail.
CREATE INDEX IF NOT EXISTS idx_scheduler_ticks_run_at
  ON scheduler_ticks (run_id, at DESC);
