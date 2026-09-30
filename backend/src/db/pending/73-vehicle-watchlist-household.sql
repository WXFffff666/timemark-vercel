-- Task 156/157/158: vehicle fuel & maintenance ledger, watch/read list, household lists.
--
-- Idempotent + additive. Folds into backend/src/db/migrate.ts by the integrator in
-- numeric order after the landed max. No data migration: brand-new tables plus two
-- additive share_tokens changes (new 'household_list' scope value + scope_list_id)
-- guarded so re-runs are no-ops.

-- ---------------------------------------------------------------------------
-- 156: vehicles + fuel / maintenance ledger
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS vehicles (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  make TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  year INTEGER CHECK (year IS NULL OR (year >= 1886 AND year <= 2100)),
  plate TEXT NOT NULL DEFAULT '',
  odometer INTEGER NOT NULL DEFAULT 0 CHECK (odometer >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vehicles_user ON vehicles (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS vehicle_fuel_records (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vehicle_id BIGINT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  recorded_on DATE NOT NULL,
  energy_type TEXT NOT NULL DEFAULT 'fuel' CHECK (energy_type IN ('fuel', 'electric')),
  quantity NUMERIC(10, 2) NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(10, 3) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  total_cost NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (total_cost >= 0),
  odometer INTEGER NOT NULL CHECK (odometer >= 0),
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vehicle_fuel_vehicle ON vehicle_fuel_records (vehicle_id, odometer DESC);

CREATE TABLE IF NOT EXISTS vehicle_maintenance_records (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vehicle_id BIGINT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  item TEXT NOT NULL,
  serviced_on DATE NOT NULL,
  odometer INTEGER CHECK (odometer IS NULL OR odometer >= 0),
  cost NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (cost >= 0),
  next_due_date DATE,
  next_due_odometer INTEGER CHECK (next_due_odometer IS NULL OR next_due_odometer >= 0),
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vehicle_maintenance_vehicle
  ON vehicle_maintenance_records (vehicle_id, serviced_on DESC);

-- ---------------------------------------------------------------------------
-- 157: watch / read list. Rows with a future release_date + status
-- wanted/in_progress feed the shared minute-cron reminder iterator
-- (jobs/tasks.ts WATCHLIST_SOURCE); no second scheduler.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS watchlist_items (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('film', 'series', 'book', 'game', 'other')),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'wanted' CHECK (status IN ('wanted', 'in_progress', 'done', 'dropped')),
  release_date DATE,
  source TEXT,
  link TEXT,
  rating INTEGER CHECK (rating IS NULL OR (rating >= 0 AND rating <= 10)),
  note TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  reminder_config JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_watchlist_user_status ON watchlist_items (user_id, status);
CREATE INDEX IF NOT EXISTS idx_watchlist_user_release ON watchlist_items (user_id, release_date);

-- ---------------------------------------------------------------------------
-- 158: household collaborative list. Deliberately separate from the existing
-- inventory_items stock domain (different table names, different lifecycle).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS household_lists (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_household_lists_user ON household_lists (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS household_list_items (
  id BIGSERIAL PRIMARY KEY,
  list_id BIGINT NOT NULL REFERENCES household_lists(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  quantity TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  assignee TEXT NOT NULL DEFAULT '',
  checked BOOLEAN NOT NULL DEFAULT FALSE,
  checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_household_list_items_list
  ON household_list_items (list_id, checked, created_at);

-- Per-list share links reuse share_tokens: widen the scope CHECK to accept
-- 'household_list' and add the list reference column. Dropping the old CHECK is
-- required (an ADD would otherwise be rejected); the loop handles any constraint
-- name, and re-runs drop + re-add the same widened constraint.
ALTER TABLE share_tokens ADD COLUMN IF NOT EXISTS scope_list_id BIGINT;

DO $$
DECLARE
  constraint_row record;
BEGIN
  FOR constraint_row IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'share_tokens'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%scope_type%'
  LOOP
    EXECUTE format('ALTER TABLE share_tokens DROP CONSTRAINT %I', constraint_row.conname);
  END LOOP;
  ALTER TABLE share_tokens
    ADD CONSTRAINT share_tokens_scope_type_check
    CHECK (scope_type IN ('profile', 'tag', 'household_list'));
END $$;
