-- 71-weather-parcels.sql (tasks 151 + 152 supporting DDL)
--
-- PENDING DDL: this directory is merged into backend/src/db/migrate.ts by the
-- integrator (append-only, next free version = 71 at the time of writing; the
-- integrator re-checks the tail immediately before appending, per repo convention).
-- Do NOT edit migrate.ts from a lane; this file is the lane's DDL handoff.
--
-- Idempotent + additive: CREATE TABLE / CREATE INDEX IF NOT EXISTS only, no ALTER,
-- no backfill, no data migration; re-running is a no-op.

-- (151) The user's stored weather location (opt-in). One row per user; an absent row
-- means "unconfigured" and the service degrades to 天气不可用. `latitude`/`longitude`
-- are WGS-84 decimal degrees keyed by the Open-Meteo forecast endpoints.
CREATE TABLE IF NOT EXISTS user_weather_settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  location_label TEXT NOT NULL DEFAULT '',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- (151) Shared, cross-instance upstream cache for Open-Meteo (free, no API key).
-- `fetched_at` is the payload freshness clock; `attempted_at` is the 5-minute
-- Postgres/egress floor: an instance never re-calls upstream while a previous
-- attempt (success OR failure) is younger than WEATHER_MIN_REFRESH_MS, and a
-- failed attempt serves the previous payload as `stale` instead of failing.
CREATE TABLE IF NOT EXISTS weather_cache (
  cache_key TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- (152) Tracked parcels (carrier, tracking number, label, status, last event, ETA).
-- Manual status updates overwrite `status` + `last_event`; adapter polling (the
-- injected CarrierAdapter seam) writes the same fields. The tracking number is a
-- user secret: it is only ever logged through maskTrackingNumber().
CREATE TABLE IF NOT EXISTS parcels (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  carrier TEXT NOT NULL,
  tracking_number TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'registered'
    CONSTRAINT parcels_status_check CHECK (status IN ('registered', 'in_transit', 'out_for_delivery', 'delivered', 'exception')),
  last_event TEXT,
  last_event_at TIMESTAMPTZ,
  eta DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, carrier, tracking_number)
);
CREATE INDEX IF NOT EXISTS idx_parcels_user_status ON parcels (user_id, status);
