-- ============================================================================
-- Pending migration 70 - OCR results + family share tokens + remote backups
-- (Wave tasks 146 + 148 + 149)
-- ============================================================================
-- NOT yet merged into backend/src/db/migrate.ts (integrator-owned). The
-- orchestrator merges pending files in numeric order at release (70 follows the
-- currently-landed max, 63 at the time of writing). Register as:
--   { version: 70, name: 'ocr_share_remote_backup_v70', sql: <this file> }
-- Until then the new services/routes fail their reads/writes with
-- "relation ocr_results / share_tokens / remote_backup_configs /
-- remote_backup_records does not exist".
--
-- WHY EACH TABLE:
--
--   ocr_results            Optional OCR (task 146). One row per extraction
--                          attempt, linked to the owning document and/or the
--                          source attachment. The raw text is stored bounded
--                          (excerpt) plus a structured-fields JSON object
--                          (issuer/date/total/currency). OCR is OFF by default:
--                          rows only appear once an engine is configured.
--
--   share_tokens           Read-only family sharing (task 148). The raw token
--                          is shown once and NEVER stored - only its SHA-256
--                          hash (`token_hash`) is persisted. Scope is exactly
--                          one of profile | tag; an optional passcode is stored
--                          as its SHA-256 hash. `expires_at` / `revoked_at`
--                          gate access; `access_count` / `last_accessed_at`
--                          are usage counters (no IP, no user agent).
--
--   remote_backup_configs  WebDAV / S3-compatible target (task 149). One row
--                          per user. Credentials are encrypted at rest with the
--                          shared crypto util (MASTER_KEY); the plaintext is
--                          never stored and never logged.
--
--   remote_backup_records  Append-only attempt log for every backup / restore /
--                          list / prune action (task 149), so the UI can show
--                          history without touching the remote target.
--
-- Purely additive + idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS only,
-- no ALTER of existing tables, no backfill; re-running is a no-op.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 146: optional OCR results
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ocr_results (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Owning document (preferred) - null for a standalone extraction.
  document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  -- Source attachment when the bytes came from the vault.
  attachment_id INTEGER REFERENCES attachments(id) ON DELETE SET NULL,
  -- Engine that produced the row (e.g. 'tesseract'); 'none' when disabled.
  engine TEXT NOT NULL,
  -- 'extracted' | 'disabled' | 'failed'
  status TEXT NOT NULL,
  content_type TEXT,
  byte_size INTEGER,
  -- Bounded text excerpt; never the full document body.
  text_excerpt TEXT,
  -- Structured fields: { issuer, date, total, currency } (any may be null).
  fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ocr_results_user_document
  ON ocr_results (user_id, document_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ocr_results_user_created
  ON ocr_results (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 148: read-only family share tokens (profile / tag scoped)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS share_tokens (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- SHA-256 hex of the high-entropy raw token - the ONLY persisted form.
  token_hash TEXT NOT NULL UNIQUE,
  -- 'profile' | 'tag'
  scope_type TEXT NOT NULL CHECK (scope_type IN ('profile', 'tag')),
  -- Present when scope_type = 'profile' (ownership checked in the service).
  scope_profile_id INTEGER REFERENCES profiles(id) ON DELETE CASCADE,
  -- Present when scope_type = 'tag' (a value in events.tags / contacts tags).
  scope_tag TEXT,
  label TEXT,
  -- SHA-256 hex of the optional passcode; null = no passcode required.
  passcode_hash TEXT,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  last_accessed_at TIMESTAMPTZ,
  access_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_share_tokens_user_created
  ON share_tokens (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 149: remote backup target config + attempt log
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS remote_backup_configs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  -- 'webdav' | 's3'
  target_type TEXT NOT NULL CHECK (target_type IN ('webdav', 's3')),
  -- WebDAV base URL / S3-compatible endpoint. Its host MUST be on the egress
  -- allowlist before any call is attempted (see remote-backup.service.ts).
  endpoint TEXT NOT NULL,
  path_prefix TEXT NOT NULL DEFAULT '',
  -- S3 only.
  bucket TEXT,
  region TEXT,
  access_key_id TEXT,
  -- WebDAV only.
  username TEXT,
  -- Encrypted (shared crypto util) WebDAV password / S3 secret access key.
  -- Never serialized into a response, never logged.
  secret_encrypted TEXT,
  retention_count INTEGER NOT NULL DEFAULT 5,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS remote_backup_records (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'backup' | 'restore' | 'list' | 'prune'
  kind TEXT NOT NULL,
  -- 'success' | 'dry_run' | 'failure'
  status TEXT NOT NULL,
  target_type TEXT,
  object_key TEXT,
  byte_size BIGINT,
  retention_deleted INTEGER NOT NULL DEFAULT 0,
  dry_run BOOLEAN NOT NULL DEFAULT FALSE,
  error_code TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_remote_backup_records_user_created
  ON remote_backup_records (user_id, created_at DESC);
