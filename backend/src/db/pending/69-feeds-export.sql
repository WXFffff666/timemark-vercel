-- ============================================================================
-- Pending migration 69 — inbound feed ingest + print/export support
-- (Tasks 144 + 147)
-- ============================================================================
-- NOT yet merged into backend/src/db/migrate.ts (integrator-owned). The
-- orchestrator merges pending files in numeric order at release; the next free
-- version at the time of writing is 64, but this lane was assigned the reserved
-- slot 69. Register as:
--   { version: 69, name: 'feeds_export_v69', sql: <this file> }
--
-- Until then:
--   backend/src/services/agent/feed-ingest.service.ts
--   backend/src/routes/feeds.ts
-- will fail their reads/writes with "relation feed_sources ... does not exist".
-- The export lane (147) needs NO table — it renders from existing events /
-- fixed_contacts / event_trigger_logs.
--
-- WHY THREE TABLES (and why NOT the existing `ics_feeds`):
--
--   feed_sources        Task 144 inbound SOURCE registry. NOTE: the shipped
--                       `ics_feeds` table (migration v48, ics-feed.service.ts) is
--                       the OPPOSITE direction — it stores OUTBOUND public
--                       subscription feeds keyed by token_hash + "filter".
--                       Reusing it would require ALTERing a NOT-NULL token/filter
--                       shape that has no meaning for an inbound url+poll source,
--                       so a separate additive table is used instead. One row is
--                       either kind='ics' (url + poll_interval_minutes) or
--                       kind='mail' (mail_address). `trusted` is the per-source
--                       switch: trusted sources may be applied immediately;
--                       untrusted sources only ever produce proposals.
--
--   feed_ingest_proposals  Human-in-the-loop queue. Nothing creates an event or
--                       contact until the row flips to 'accepted'; the accept
--                       path is a single atomic claim
--                       (`UPDATE ... WHERE status='pending'`, loser updates 0
--                       rows -> 409). kind ('event_new' | 'event_changed' |
--                       'contact_new') tells the resolver what to do. The unique
--                       (user_id, source_kind, dedupe_key) is the idempotency
--                       guard: re-syncing the same feed is a no-op.
--
--   feed_ingest_seen    The dedupe memory that survives serverless cold starts.
--                       For ICS the contract is UID + DTSTART: a brand-new
--                       (uid, dtstart_key) proposes 'event_new'; a known uid with
--                       a DIFFERENT dtstart_key proposes 'event_changed'; every
--                       other combination is a duplicate and is skipped. For
--                       mail the key is Message-ID + candidate index. The unique
--                       (source_id, dedupe_key) makes re-ingest idempotent.
--
-- Purely additive + idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS only,
-- no ALTER of existing tables, no backfill, re-running is a no-op.
-- ============================================================================

CREATE TABLE IF NOT EXISTS feed_sources (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'ics' = polled external calendar URL; 'mail' = inbound RFC822 mailbox.
  kind TEXT NOT NULL CHECK (kind IN ('ics', 'mail')),
  name TEXT NOT NULL DEFAULT '',
  -- ICS only: the external feed URL (operator must add the host to
  -- EGRESS_ALLOWED_HOSTS so services/agent/egress-guard.service.ts lets the fetch out).
  url TEXT,
  -- ICS only: how often the scheduler should re-poll (minutes).
  poll_interval_minutes INTEGER NOT NULL DEFAULT 360,
  -- Mail only: the address this mailbox expects mail for (informational).
  mail_address TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  -- trusted = apply directly (still recorded as an accepted proposal);
  -- untrusted (default) = propose only, never silently write user data.
  trusted BOOLEAN NOT NULL DEFAULT FALSE,
  last_synced_at TIMESTAMPTZ,
  last_status TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feed_sources_user
  ON feed_sources (user_id, enabled, kind);

CREATE TABLE IF NOT EXISTS feed_ingest_proposals (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id BIGINT REFERENCES feed_sources(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('event_new', 'event_changed', 'contact_new')),
  -- UID|<DTSTART> for ICS, Message-ID#<index> for mail.
  dedupe_key TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  -- Typed payload re-validated at accept time (never executed blindly).
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  UNIQUE (user_id, source_kind, dedupe_key)
);

-- Pending queue listing (newest first) + status filters.
CREATE INDEX IF NOT EXISTS idx_feed_ingest_proposals_user_status
  ON feed_ingest_proposals (user_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS feed_ingest_seen (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id BIGINT REFERENCES feed_sources(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  -- ICS: the VEVENT UID (stable identity across re-syncs).
  uid TEXT,
  -- ICS: the DTSTART token (all-day 'YYYYMMDD' or 'YYYYMMDDTHHMMSSZ').
  dtstart_key TEXT,
  title TEXT NOT NULL DEFAULT '',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, dedupe_key)
);

-- Change detection: find every DTSTART already known for a UID.
CREATE INDEX IF NOT EXISTS idx_feed_ingest_seen_source_uid
  ON feed_ingest_seen (source_id, uid);
