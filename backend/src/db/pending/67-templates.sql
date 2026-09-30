-- 67-templates.sql (tasks 140-141)
-- Recurring routine templates: a named set of steps (event + reminders + checklist
-- todos + optional habit / maintenance linkage) that can be instantiated as a whole.
--
-- Storage:
--   routine_templates        - the named routine (per user)
--   routine_template_steps   - ordered steps; `payload` holds the per-kind options
--   routine_template_instances - idempotency + audit: one row per (user, template, slot).
--     UNIQUE (user_id, template_id, slot_key) is what makes a double-click a no-op:
--     instantiate inserts this row first with ON CONFLICT DO NOTHING and only creates
--     the items when the claim succeeds. The whole unit runs in one transaction.
--
-- NOT yet registered in backend/src/db/migrate.ts (integrator-owned this wave).
-- Register as: { version: 67, name: 'routine_templates_v67', sql: <this file> }
-- (sibling pending files 59-63 belong to other lanes). Additive and idempotent: every
-- statement is IF NOT EXISTS-guarded; nothing existing is altered, dropped or rewritten.

CREATE TABLE IF NOT EXISTS routine_templates (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  -- Built-in presets (每周大扫除 / 旅行准备 / 月度报表) are seeded with TRUE.
  is_builtin BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_routine_templates_user
  ON routine_templates (user_id, name);

CREATE TABLE IF NOT EXISTS routine_template_steps (
  id SERIAL PRIMARY KEY,
  template_id INTEGER NOT NULL REFERENCES routine_templates(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  -- event | todo | habit | maintenance (todo steps are events under the hood:
  -- this app's completable todo IS an event in its reminder window).
  kind TEXT NOT NULL CONSTRAINT routine_template_steps_kind_check
    CHECK (kind IN ('event', 'todo', 'habit', 'maintenance')),
  title TEXT NOT NULL,
  -- Per-kind options: dateOffsetDays, eventType, reminder, recurring, habitId/habit,
  -- maintenancePlanId/maintenance, profileId.
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_routine_template_steps_template
  ON routine_template_steps (template_id, position, id);

CREATE TABLE IF NOT EXISTS routine_template_instances (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  template_id INTEGER NOT NULL REFERENCES routine_templates(id) ON DELETE CASCADE,
  -- Slot identity: caller-supplied slot, else the anchor date (user-local today).
  slot_key TEXT NOT NULL,
  anchor_date DATE NOT NULL,
  -- Per-item creation report (stepId -> created/linked entity), JSONB array.
  report JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, template_id, slot_key)
);

CREATE INDEX IF NOT EXISTS idx_routine_template_instances_user_template
  ON routine_template_instances (user_id, template_id, created_at DESC);
