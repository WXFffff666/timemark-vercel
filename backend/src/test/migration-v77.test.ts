import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Migration v77 pin: fold the legacy 'email' channel into 'resend'.
 *
 * Delivery has always run 'email' and 'resend' through the exact same branch, but 'email'
 * never had a UI template, so accounts and event selections typed 'email' were active yet
 * invisible. v77 retypes them; historical trigger logs are deliberately NOT rewritten (they
 * are an audit record and their channel_results keys use the original channel id). The
 * 'email' alias stays in the dispatch chain (notifications/index.ts) as a safety net.
 */

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn<(text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>>(),
}));

vi.mock('../db/index.js', () => ({ query: mockQuery }));

import { applyIncrementalMigrations } from '../db/migrate.js';
import { migrationSqlFor, registeredMigrationVersions } from './helpers.js';

const MIGRATE_SOURCE = readFileSync(new URL('../db/migrate.ts', import.meta.url), 'utf8');
const V77_SQL = migrationSqlFor(MIGRATE_SOURCE, 'fold_email_channel_v77');

function statements(): string[] {
  return V77_SQL.split(';').map((s) => s.trim()).filter(Boolean);
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('migration v77 registration (email -> resend fold)', () => {
  it('applies on top of a recorded 76 and is recorded as the new tail', async () => {
    await applyIncrementalMigrations(76);
    const updates = mockQuery.mock.calls.filter(([sql]) => String(sql).includes('UPDATE'));
    expect(updates.length).toBeGreaterThan(0);
    expect(registeredMigrationVersions(MIGRATE_SOURCE).at(-1)).toBe(81);
  });

  it('retypes email accounts and rewrites event channel selections guarded by containment checks', () => {
    expect(V77_SQL).toContain(`UPDATE notification_accounts SET type = 'resend' WHERE type = 'email'`);
    const stmt = statements().find((s) => s.includes('UPDATE events SET notification_channels'));
    expect(stmt, 'events rewrite missing').toBeDefined();
    // Only rows that actually contain the alias are touched (idempotent + no false hits).
    expect(stmt).toContain(`WHERE notification_channels @> '["email"]'::jsonb`);
    expect(stmt).toContain(`REPLACE(notification_channels::text, '"email"', '"resend"')::jsonb`);
    // fixed_contacts 没有 notification_channels 列（只有 preferred_channels），绝不能碰。
    expect(V77_SQL).not.toContain('fixed_contacts');
  });

  it('never touches event_trigger_logs (audit history keyed by the original channel id)', () => {
    expect(V77_SQL).not.toContain('event_trigger_logs');
  });

  it('does not record v77 when its SQL fails, so a later cold start retries', async () => {
    mockQuery.mockImplementation(async (text: string) => {
      if (text.includes('UPDATE notification_accounts')) throw new Error('permission denied');
      return { rows: [], rowCount: 0 };
    });
    await applyIncrementalMigrations(76);
    const inserts = mockQuery.mock.calls
      .filter(([sql]) => String(sql).includes('INSERT INTO schema_version'))
      .map(([, params]) => params?.[0]);
    expect(inserts).not.toContain(77);
  });
});
