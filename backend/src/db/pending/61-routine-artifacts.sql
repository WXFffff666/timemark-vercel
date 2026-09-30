-- 61-routine-artifacts.sql (tasks 122-123)
-- Idempotency + audit store for agent routine deliveries (morning_brief,
-- evening_review, and the later weekly_review / hourly_triage lanes).
--
-- NOT yet registered in backend/src/db/migrate.ts (coordinator-owned this wave).
-- Register as: { version: 61, name: 'routine_artifacts_v61', sql: <this file> }
-- (the migrate.ts chain ended at v58 when this file was written; 59/60 belong
-- to sibling lanes). Additive and idempotent: every statement is
-- IF NOT EXISTS-guarded; nothing existing is altered, dropped or rewritten.

CREATE TABLE IF NOT EXISTS agent_routine_artifacts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Routine kind ('morning_brief', 'evening_review', ...); no FK - kinds are code.
  routine TEXT NOT NULL,
  -- The user-local calendar day the artifact covers (YYYY-MM-DD).
  local_date DATE NOT NULL,
  -- '<routine>:<YYYY-MM-DD>' - unique per user, the once-per-day delivery guard.
  idempotency_key TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  -- Structured facts behind the body + narration flag (fed back into later digests).
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  delivered BOOLEAN NOT NULL DEFAULT FALSE,
  delivered_at TIMESTAMPTZ,
  channel TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_agent_routine_artifacts_user_date
  ON agent_routine_artifacts (user_id, local_date DESC);

-- Partial index for the stale-reclaim sweep (claimed but never delivered).
CREATE INDEX IF NOT EXISTS idx_agent_routine_artifacts_pending
  ON agent_routine_artifacts (created_at) WHERE delivered = FALSE;
