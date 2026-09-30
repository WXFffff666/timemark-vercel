-- ============================================================================
-- Pending migration 63 — agent decision cards + durable feedback memory
-- (Wave 16 tasks 126 + 127)
-- ============================================================================
-- NOT yet merged into backend/src/db/migrate.ts: that file is owned by the
-- integrator lane. The orchestrator merges pending files in numeric order at
-- release (63 follows the currently landed max, 62 at the time of writing).
-- Until then:
--   backend/src/services/agent/decision-card.service.ts
--   backend/src/services/agent/feedback.service.ts
--   backend/src/routes/decisions.ts
-- will fail their reads/writes with "relation agent_decision_cards/agent_feedback
-- does not exist".
--
-- WHY TWO TABLES:
--
--   agent_decision_cards  The human-in-the-loop proposal (task 126). NOTHING
--                         mutates user data until the card is approved. The
--                         exactly-once guarantee is a single atomic claim:
--                         `UPDATE ... SET status='approved' WHERE status='pending'`
--                         - the loser of a race updates zero rows and the API
--                         returns 409 already_decided. The card stores the full
--                         typed payload so the resolver registry (subject kind ->
--                         apply function) can re-validate it at approval time.
--                         `is_question` marks question cards, whose daily cap is
--                         enforced separately from the notification budget.
--
--   agent_feedback        The durable memory (task 127): every approve/edit/
--                         reject (with its optional free-text "Why?") and every
--                         correction lands here, plus a derived row in
--                         user_patterns (kind='decision_feedback') so the miner's
--                         confidence rises from REAL feedback. The most recent
--                         row for a subject is the effective policy; a polarity
--                         flip (approve then reject) is logged as a conflict
--                         rather than oscillating.
--
-- The feedback memory NEVER overrides a hard setting (quiet hours, notification
-- budget): those live in configuration and the feedback service refuses to turn
-- feedback rows into config overrides (see HARD_SETTING_SUBJECTS in
-- feedback.service.ts). Hard settings are excluded from the policy digest too.
--
-- Purely additive + idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS only,
-- no ALTER of existing tables, no backfill, re-running is a no-op.
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_decision_cards (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Typed subject kind; only kinds present in DECISION_SUBJECT_KINDS have a
  -- resolver, so an unknown kind can never be applied (injection guard).
  subject_kind TEXT NOT NULL,
  -- Stable human/machine subject, e.g. 'contact:12+34'. It is the key the
  -- feedback memory and the policy digest use for suppression checks.
  subject_ref TEXT,
  -- 'propose' at creation time; kept as a column so future action kinds
  -- (e.g. 'question') do not need an ALTER.
  action TEXT NOT NULL DEFAULT 'propose',
  summary TEXT NOT NULL DEFAULT '',
  -- Full proposed change; validated against the resolver's allowlist at
  -- approval time - never executed blindly.
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Caller-provided idempotency key: re-proposing the same change returns the
  -- EXISTING card instead of creating (and re-notifying) a second one.
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'target_missing', 'expired')),
  -- Question cards (the agent asking the user something) have their own daily
  -- cap, enforced separately from the notification budget.
  is_question BOOLEAN NOT NULL DEFAULT FALSE,
  -- The optional free-text "Why?" note captured at decide time.
  rationale TEXT,
  -- For an edit decision: the user-adjusted payload merged over `payload`.
  edit_payload JSONB,
  -- Outcome of the resolver run: { status, detail, applied_at }.
  resolution JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  UNIQUE (user_id, idempotency_key)
);

-- Pending-card lists (API + bot) and the question-card day counter.
CREATE INDEX IF NOT EXISTS idx_agent_decision_cards_user_status
  ON agent_decision_cards (user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_decision_cards_user_question
  ON agent_decision_cards (user_id, is_question, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_feedback (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'decision' (approve/edit/reject of a card) | 'correction' (free correction).
  kind TEXT NOT NULL,
  -- Feedback subject; matches agent_decision_cards.subject_ref (or the subject
  -- kind when no ref was supplied). This is the suppression key.
  subject TEXT NOT NULL,
  -- 'approve' | 'edit' | 'reject' | 'correct'.
  action TEXT NOT NULL,
  -- Optional free-text "Why?" note, persisted verbatim (bounded upstream).
  rationale TEXT,
  -- Card that produced this feedback, when applicable; audit only.
  decision_card_id BIGINT REFERENCES agent_decision_cards(id) ON DELETE SET NULL,
  -- Machine details (edited payload, target_missing flag, conflict_with, ...).
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Latest-per-subject lookup (policy check, digest, conflict resolution).
CREATE INDEX IF NOT EXISTS idx_agent_feedback_user_subject
  ON agent_feedback (user_id, subject, created_at DESC);
-- Recency window scan for the bounded policy digest.
CREATE INDEX IF NOT EXISTS idx_agent_feedback_user_created
  ON agent_feedback (user_id, created_at DESC);
