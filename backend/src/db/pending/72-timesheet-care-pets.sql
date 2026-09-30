-- 72-timesheet-care-pets.sql (tasks 153 + 154 + 155 supporting DDL)
--
-- PENDING DDL: this directory is merged into backend/src/db/migrate.ts by the
-- integrator (append-only, next free version after 71 at the time of writing; the
-- integrator re-checks the tail immediately before appending, per repo convention).
-- Do NOT edit migrate.ts from a lane; this file is the lane's DDL handoff.
--
-- Idempotent + additive: CREATE TABLE / CREATE INDEX IF NOT EXISTS only, no ALTER,
-- no backfill, no data migration; re-running is a no-op.

-- ---------------------------------------------------------------------------
-- (153) Attendance / timesheet
-- ---------------------------------------------------------------------------

-- One row per work session. `clock_out IS NULL` marks the single open session.
-- The partial unique index below is the hard guarantee against duplicate open
-- sessions (a second clock-in hits 23505 and the route answers 409); the service
-- also checks for a friendly error before inserting.
CREATE TABLE IF NOT EXISTS timesheet_sessions (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clock_in TIMESTAMPTZ NOT NULL DEFAULT now(),
  clock_out TIMESTAMPTZ,
  note TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT timesheet_sessions_range_check CHECK (clock_out IS NULL OR clock_out > clock_in)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_timesheet_open_session
  ON timesheet_sessions (user_id) WHERE clock_out IS NULL;
CREATE INDEX IF NOT EXISTS idx_timesheet_sessions_user_clock_in
  ON timesheet_sessions (user_id, clock_in);

-- Absence / leave records. `kind` is a coarse bucket; the note carries detail.
CREATE TABLE IF NOT EXISTS timesheet_leaves (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'leave'
    CONSTRAINT timesheet_leaves_kind_check CHECK (kind IN ('absence', 'leave', 'sick', 'holiday', 'other')),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT timesheet_leaves_range_check CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS idx_timesheet_leaves_user_start
  ON timesheet_leaves (user_id, start_date);

-- ---------------------------------------------------------------------------
-- (154) Child / elder care
-- ---------------------------------------------------------------------------

-- A care recipient (child, elder, ...). One user may keep several profiles.
CREATE TABLE IF NOT EXISTS care_profiles (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  relationship TEXT NOT NULL DEFAULT '',
  date_of_birth DATE,
  allergies TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_care_profiles_user ON care_profiles (user_id);

-- Care events: feeding / dose / vitals / mood / incident. Deliberately named
-- `care_logs` so it cannot collide with the existing medications/doses domain.
-- `value` + `unit` carry measurement history (e.g. temperature 36.8 C, weight
-- 12.5 kg); `label` names the item (formula, drug, metric).
CREATE TABLE IF NOT EXISTS care_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id BIGINT NOT NULL REFERENCES care_profiles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL
    CONSTRAINT care_logs_kind_check CHECK (kind IN ('feeding', 'dose', 'vitals', 'mood', 'incident')),
  logged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  label TEXT NOT NULL DEFAULT '',
  value NUMERIC,
  unit TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_care_logs_profile_logged_at
  ON care_logs (profile_id, logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_care_logs_user_kind_logged_at
  ON care_logs (user_id, kind, logged_at DESC);

-- ---------------------------------------------------------------------------
-- (155) Pet care
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pets (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  species TEXT NOT NULL DEFAULT '',
  breed TEXT NOT NULL DEFAULT '',
  birth_date DATE,
  weight_kg NUMERIC(6, 2),
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pets_user ON pets (user_id);

-- Pet history: weight / feeding / vet. `weight_kg` is used by kind='weight'
-- (and optionally by vet visits); `detail` carries feeding / vet notes.
CREATE TABLE IF NOT EXISTS pet_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pet_id BIGINT NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  kind TEXT NOT NULL
    CONSTRAINT pet_logs_kind_check CHECK (kind IN ('weight', 'feeding', 'vet')),
  logged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  weight_kg NUMERIC(6, 2),
  detail TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pet_logs_pet_kind_logged_at
  ON pet_logs (pet_id, kind, logged_at DESC);

-- Vaccination / deworming schedule with per-row lead time. A one-shot schedule
-- is retired by setting `completed_at`; a recurring schedule (interval_days IS
-- NOT NULL) rolls `due_date` forward on completion so the reminder scan keeps
-- working off a single due date (see pet.service.ts completePetSchedule).
CREATE TABLE IF NOT EXISTS pet_schedules (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pet_id BIGINT NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  kind TEXT NOT NULL
    CONSTRAINT pet_schedules_kind_check CHECK (kind IN ('vaccination', 'deworming')),
  name TEXT NOT NULL,
  due_date DATE NOT NULL,
  interval_days INTEGER,
  reminder_days_before INTEGER NOT NULL DEFAULT 14,
  completed_at TIMESTAMPTZ,
  last_completed_at TIMESTAMPTZ,
  completion_count INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pet_schedules_interval_check CHECK (interval_days IS NULL OR interval_days > 0),
  CONSTRAINT pet_schedules_reminder_check CHECK (reminder_days_before >= 0)
);
CREATE INDEX IF NOT EXISTS idx_pet_schedules_user_due
  ON pet_schedules (user_id, due_date);
CREATE INDEX IF NOT EXISTS idx_pet_schedules_pet_due
  ON pet_schedules (pet_id, due_date);
