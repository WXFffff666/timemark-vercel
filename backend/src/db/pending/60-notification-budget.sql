-- 60-notification-budget.sql (checkbox 118 + 121 supporting DDL)
--
-- PENDING DDL: this directory is merged into backend/src/db/migrate.ts by the
-- integrator (append-only, next free version = 60 at the time of writing; the
-- integrator re-checks the tail immediately before appending, per repo convention).
-- Do NOT edit migrate.ts from a lane; this file is the lane's DDL handoff.
--
-- Idempotent + additive: CREATE TABLE / CREATE INDEX IF NOT EXISTS only, no ALTER,
-- no backfill, no data migration; re-running is a no-op.

-- (118) Per-user per-LOCAL-day proactive notification budget and suppression ledger.
-- `day` is the user's local calendar day (YYYY-MM-DD), resolved timezone-aware via
-- Intl.DateTimeFormat in notification-budget.service.ts, so the counters reset at the
-- user's local midnight. `sent_count` counts proactive sends only; user-initiated
-- replies and the critical class (e.g. medication critical reminders) are excluded
-- from BOTH counters by the service, never written here as sends.
CREATE TABLE IF NOT EXISTS agent_budget_usage (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  sent_count INTEGER NOT NULL DEFAULT 0,
  suppressed_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, day)
);
CREATE INDEX IF NOT EXISTS idx_agent_budget_usage_day ON agent_budget_usage (day);

-- (118) Send-claim ledger, the agent-queue analogue of `reminder_send_claims`:
-- a claim is won with `INSERT ... ON CONFLICT DO NOTHING RETURNING id`, so a
-- duplicate claim matches zero rows and the caller skips. `window_bucket` is
-- floor(epochMs / windowMs); a new bucket = a fresh window. Two scopes:
--   dedupe            - identical content within AGENT_NOTIFICATION_DEDUPE_WINDOW_MS
--   routine_cooldown  - per-routine cooldown (AGENT_ROUTINE_COOLDOWN_MS)
CREATE TABLE IF NOT EXISTS agent_notification_claims (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CONSTRAINT agent_notification_claims_scope_check CHECK (scope IN ('dedupe', 'routine_cooldown')),
  claim_key TEXT NOT NULL,
  window_bucket BIGINT NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, scope, claim_key, window_bucket)
);
CREATE INDEX IF NOT EXISTS idx_agent_notification_claims_user ON agent_notification_claims (user_id, claimed_at DESC);

-- (118) Folded proactive content: when the daily budget is exhausted (or the user is
-- inside quiet hours) a non-urgent routine's content is stored here instead of being
-- sent; the next Inbox digest consumes pending rows (consumed_at IS NULL) and marks
-- them consumed. Nothing in this table is ever delivered on its own.
CREATE TABLE IF NOT EXISTS agent_digest_folds (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  routine_id TEXT,
  notification_class TEXT NOT NULL DEFAULT 'routine',
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_agent_digest_folds_pending ON agent_digest_folds (user_id, created_at ASC) WHERE consumed_at IS NULL;

-- (121g) Neon Free CU-hour guard alert ledger: one row per (month, threshold) so the
-- 70% and 90% alerts fire once per month across cold-started serverless instances.
CREATE TABLE IF NOT EXISTS agent_neon_budget_alerts (
  month TEXT NOT NULL,
  threshold_percent INTEGER NOT NULL,
  cu_hours DOUBLE PRECISION,
  alerted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (month, threshold_percent)
);
