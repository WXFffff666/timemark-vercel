-- ============================================================================
-- Pending migration 62 — agent_triage_state (Wave 15 routines 122-125)
-- ============================================================================
-- NOT yet merged into backend/src/db/migrate.ts: that file is a shared file the
-- routine lane must not edit. The orchestrator merges pending files in numeric
-- order at release (62 follows the currently landed max, 58 at the time of
-- writing). Until then the routines in
--   backend/src/services/agent/routines/hourly-triage.ts
--   backend/src/services/agent/routines/weekly-review.ts
-- will fail their reads/writes with "relation agent_triage_state does not exist".
--
-- Why one table and not per-routine state: the hourly triage OBSERVES and the
-- weekly review DIGESTS, and both must agree on what has already been shown to
-- the user. One durable row per (user, item fingerprint) is the dedupe memory
-- that survives serverless cold starts:
--
--   fingerprint          stable key, e.g. 'event:42'  (UNIQUE per user)
--   last_seen_at         freshness: when the item last appeared in a scan
--   last_surfaced_at     suppression anchor: hourly triage skips a fingerprint
--                        surfaced within its dedupe window unless importance
--                        escalated (see TRIAGE_DEDUPE_WINDOW_HOURS / _DELTA)
--   surfaced_count       how many times it was actually shown
--   last_surface_kind    'hourly_triage' | 'weekly_review'
--   digest_week          ISO week ('2026-W40') the item was last included in a
--                        weekly digest; NULL = never digested. Same-week re-runs
--                        reproduce the same digest; earlier-week items repeat only
--                        while importance stays at/above the urgent bar.
--
-- Purely additive + idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS only,
-- no ALTER of existing tables, no backfill, re-running is a no-op.
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_triage_state (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_ref TEXT,
  title TEXT NOT NULL DEFAULT '',
  importance INTEGER NOT NULL DEFAULT 0,
  band TEXT NOT NULL DEFAULT 'fyi',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_surfaced_at TIMESTAMPTZ,
  surfaced_count INTEGER NOT NULL DEFAULT 0,
  last_surface_kind TEXT,
  digest_week TEXT,
  UNIQUE (user_id, fingerprint)
);

-- Scan/lookup support for the two routines (bounded, index-friendly reads).
CREATE INDEX IF NOT EXISTS idx_agent_triage_state_recent
  ON agent_triage_state (user_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_triage_state_surfaced
  ON agent_triage_state (user_id, last_surfaced_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_triage_state_week
  ON agent_triage_state (user_id, digest_week);
