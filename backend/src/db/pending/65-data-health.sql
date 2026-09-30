-- Task 137: audit ledger for data-health one-click repairs.
--
-- Every successful repair writes one row here (best-effort) in addition to the shipped
-- `audit_logs` entry written via services/audit.service.ts. `repaired_count` is the number
-- of rows the repair touched; `confirmed` records whether a destructive repair was
-- explicitly confirmed by the caller. Repairs are idempotent, so re-running one over an
-- already-clean dataset appends a row with repaired_count = 0.
CREATE TABLE IF NOT EXISTS data_health_repairs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  repaired_count INTEGER NOT NULL DEFAULT 0,
  confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_data_health_repairs_user ON data_health_repairs (user_id, created_at DESC);
