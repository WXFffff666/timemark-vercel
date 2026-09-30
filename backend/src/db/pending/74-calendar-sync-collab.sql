-- ============================================================================
-- Pending migration 74 - two-way calendar sync accounts + single-owner
-- family collaboration invites (Wave tasks 159 + 160)
-- ============================================================================
-- NOT yet merged into backend/src/db/migrate.ts (integrator-owned). The
-- orchestrator merges pending files in numeric order at release (74 follows the
-- currently-landed max, 73 at the time of writing). Register as:
--   { version: 74, name: 'calendar_sync_collaboration_v74', sql: <this file> }
-- Until then the new services/routes fail their reads/writes with
-- "relation calendar_sync_accounts / calendar_sync_events /
--  collaboration_invites / collaboration_activity does not exist".
--
-- WHY EACH TABLE:
--
--   calendar_sync_accounts  A per-user external calendar target (task 159).
--                           `kind` is 'caldav' | 'exchange'; the Exchange path
--                           is an adapter seam that may report `unsupported`
--                           instead of faking success. Credentials are encrypted
--                           at rest with the shared crypto util (MASTER_KEY);
--                           the ciphertext is never returned and never logged.
--                           `direction` gates pull / push / both and `enabled`
--                           lets the owner pause an account without deleting it.
--
--   calendar_sync_events    The idempotency + conflict ledger. UNIQUE
--                           (account_id, calendar_id, external_uid) makes a
--                           re-pull a no-op (dedupe on external UID + calendar
--                           id). `external_version` (ETag / changeKey) and
--                           `local_version` (content hash) are the per-side
--                           versions recorded at the last sync; `losing_version`
--                           records the version discarded by the conflict policy
--                           (last-write-wins by default).
--
--   collaboration_invites   SINGLE-OWNER, invite-only guests (task 160). There
--                           is exactly one owner (owner_user_id) and NO tenant
--                           table, org table or membership table: a guest is an
--                           email/link holding a token, not an account. The raw
--                           token is shown once and never stored - only its
--                           SHA-256 hash (`token_hash`) is persisted. `role` is
--                           viewer | commenter | editor and `scope_*` bounds the
--                           surface (profile and/or tag and/or entity types).
--
--   collaboration_activity  Append-only feed of collaborator changes (task 160)
--                           so the owner sees what a guest did, scoped to the
--                           invite. Never stores credentials or raw tokens.
--
-- Purely additive + idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS only,
-- no ALTER of existing tables, no backfill; re-running is a no-op.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 159: external calendar sync accounts (CalDAV / Exchange seam)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calendar_sync_accounts (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'caldav' | 'exchange'
  kind TEXT NOT NULL CHECK (kind IN ('caldav', 'exchange')),
  -- External calendar collection / endpoint root. Its host MUST clear the
  -- shipped egress guard before any outbound call (see calendar-sync.service.ts).
  base_url TEXT NOT NULL,
  -- Login name for HTTP basic / CalDAV. Not secret, but never echoed with creds.
  username TEXT,
  -- Encrypted (shared crypto util / MASTER_KEY) password, app-password or
  -- bearer token. NULL when the target needs no credential.
  credentials_encrypted TEXT,
  -- Remote calendar / collection id (CalDAV collection path or Exchange folder).
  calendar_id TEXT NOT NULL DEFAULT 'default',
  -- 'pull' | 'push' | 'both'
  direction TEXT NOT NULL DEFAULT 'both' CHECK (direction IN ('pull', 'push', 'both')),
  -- 'last_write_wins' (default) | 'local_wins' | 'remote_wins'
  conflict_policy TEXT NOT NULL DEFAULT 'last_write_wins'
    CHECK (conflict_policy IN ('last_write_wins', 'local_wins', 'remote_wins')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_calendar_sync_accounts_user
  ON calendar_sync_accounts (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 159: per-event idempotency + conflict ledger
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calendar_sync_events (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id BIGINT NOT NULL REFERENCES calendar_sync_accounts(id) ON DELETE CASCADE,
  -- Stable external identity. Re-pull dedupes on (account_id, calendar_id, external_uid).
  external_uid TEXT NOT NULL,
  calendar_id TEXT NOT NULL DEFAULT 'default',
  -- Local event this external object maps to (NULL until imported).
  local_event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
  -- Remote version at last sync: ETag / Exchange changeKey.
  external_version TEXT,
  -- Local content hash at last sync (name + date + type).
  local_version TEXT,
  -- The version the conflict policy discarded (audit trail); NULL when no conflict.
  losing_version TEXT,
  last_direction TEXT,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, calendar_id, external_uid)
);

CREATE INDEX IF NOT EXISTS idx_calendar_sync_events_account
  ON calendar_sync_events (account_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_calendar_sync_events_local
  ON calendar_sync_events (user_id, local_event_id);

-- ---------------------------------------------------------------------------
-- 160: single-owner collaboration invites (invite-only guests, roles + scope)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS collaboration_invites (
  id BIGSERIAL PRIMARY KEY,
  -- The ONE owner of all data. Guests are never rows in `users`.
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  guest_email TEXT,
  -- 'viewer' | 'commenter' | 'editor'
  role TEXT NOT NULL CHECK (role IN ('viewer', 'commenter', 'editor')),
  -- Scope: any combination of profile, tag and entity types. An empty
  -- `scope_entity_types` means "all supported entity types" for the chosen
  -- profile/tag; with no profile AND no tag it is bounded by entity types only.
  scope_profile_id INTEGER REFERENCES profiles(id) ON DELETE CASCADE,
  scope_tag TEXT,
  scope_entity_types JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- SHA-256 hex of the high-entropy raw invite token - the ONLY persisted form.
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  last_accessed_at TIMESTAMPTZ,
  access_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_collaboration_invites_owner
  ON collaboration_invites (owner_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS collaboration_activity (
  id BIGSERIAL PRIMARY KEY,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'owner' | 'guest'
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('owner', 'guest')),
  actor_label TEXT,
  invite_id BIGINT REFERENCES collaboration_invites(id) ON DELETE SET NULL,
  -- 'invite_created' | 'invite_revoked' | 'guest_viewed' | 'guest_commented'
  -- | 'guest_event_created' | 'guest_write_denied'
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_collaboration_activity_owner
  ON collaboration_activity (owner_user_id, created_at DESC, id DESC);
