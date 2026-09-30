-- ============================================================================
-- Pending migration 64 — dedupe candidates + audit trail with TTL'd undo
-- (Wave 17 tasks 135 + 142)
-- ============================================================================
-- NOT yet merged into backend/src/db/migrate.ts: that file is owned by the
-- integrator lane. The orchestrator merges pending files in numeric order at
-- release (64 follows the currently landed max, 63 at the time of writing).
-- Until then:
--   backend/src/services/agent/audit.service.ts
--   backend/src/services/agent/dedupe.service.ts
--   backend/src/routes/audit.ts
--   backend/src/routes/dedupe.ts
-- will fail their reads/writes with "relation audit_events/audit_undo_snapshots
-- does not exist".
--
-- WHY TWO TABLES:
--
--   audit_events         One row per destructive change (delete / merge /
--                        bulk_edit / archive) with the actor, the REDACTED
--                        before/after payloads and the undo deadline. Written
--                        only through audit.service.recordAudit(); payloads are
--                        redacted by job-hardening's redactForAudit before they
--                        reach this table (tokens/secrets never persist here).
--
--   audit_undo_snapshots The exactly-once undo. `snapshot` holds the restorable
--                        row groups ({version, truncated, groups:[{table, mode,
--                        rows}]}); `undo_token` is the TTL'd token exposed to
--                        the user/bot; `consumed_at` is the atomic claim
--                        (`UPDATE ... SET consumed_at=now() WHERE consumed_at
--                        IS NULL AND expires_at > now()`) so a second undo
--                        updates zero rows and the API returns 409. The undo
--                        deadline is `expires_at` (AUDIT_UNDO_TTL_HOURS,
--                        default 72h); once it passes the undo is refused.
--
-- Safety model: the task-135 dedupe scanner only PROPOSES merges (decision
-- card, task 126); nothing in these tables triggers a delete. Undo only writes
-- to an allowlisted set of tables (events, fixed_contacts, todo_completions,
-- interactions), filtered against information_schema columns at restore time.
--
-- Purely additive + idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS only,
-- no ALTER of existing tables, no backfill, re-running is a no-op.
-- ============================================================================

CREATE TABLE IF NOT EXISTS audit_events (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'delete' | 'merge' | 'bulk_edit' | 'archive' (AUDIT_ACTIONS).
  action TEXT NOT NULL,
  -- Domain of the affected rows, e.g. 'event' | 'contact' | 'todo'.
  entity_kind TEXT NOT NULL,
  -- Stable ids of the affected entities (array of numbers/strings).
  entity_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary TEXT NOT NULL DEFAULT '',
  -- Human user the change is attributed to (agent/bot runs act on their behalf).
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- 'api' | 'bot' | 'agent' | 'decision_card' | ...
  actor_via TEXT NOT NULL DEFAULT 'api',
  -- REDACTED payload snapshots; never raw secrets (see redactForAudit).
  before_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  after_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Deadline copied from the snapshot row so the list view is a single scan.
  undo_expires_at TIMESTAMPTZ,
  undone_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_events_user_created
  ON audit_events (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_user_action
  ON audit_events (user_id, action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_user_expiry
  ON audit_events (user_id, undo_expires_at);

CREATE TABLE IF NOT EXISTS audit_undo_snapshots (
  id BIGSERIAL PRIMARY KEY,
  audit_event_id BIGINT NOT NULL REFERENCES audit_events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- {version, truncated, groups:[{table, mode:'reinsert'|'revert', rows:[...]}]}
  snapshot JSONB NOT NULL DEFAULT '{"version":1,"truncated":false,"groups":[]}'::jsonb,
  -- Opaque TTL'd token (32 random bytes, base64url). Unique per snapshot.
  undo_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  -- Atomic exactly-once claim; NULL = undo still available.
  consumed_at TIMESTAMPTZ,
  -- Outcome detail of a successful restore: {restored, groups:[...]}.
  restored JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (audit_event_id),
  UNIQUE (undo_token)
);

CREATE INDEX IF NOT EXISTS idx_audit_undo_snapshots_user_expiry
  ON audit_undo_snapshots (user_id, expires_at);
