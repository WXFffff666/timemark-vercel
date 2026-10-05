import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn<(text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>>(),
}));

vi.mock('../../db/index.js', () => ({ query: mockQuery }));

import {
  RETENTION_DAYS,
  purgeExpiredLogs,
  purgeLogTable,
  retentionCutoff,
} from '../retention.service.js';

const NOW = new Date('2026-09-27T12:00:00.000Z');

describe('retention cutoff math (todo 41)', () => {
  it('computes the cutoff as now minus the retention window', () => {
    expect(retentionCutoff(180, NOW)?.toISOString()).toBe('2026-03-31T12:00:00.000Z');
    expect(retentionCutoff(90, NOW)?.toISOString()).toBe('2026-06-29T12:00:00.000Z');
    expect(retentionCutoff(30, NOW)?.toISOString()).toBe('2026-08-28T12:00:00.000Z');
  });

  it('returns null for malformed thresholds or timestamps (never delete-everything)', () => {
    for (const bad of [undefined, null, -1, 0, NaN, Infinity, -Infinity, '180', {}]) {
      expect(retentionCutoff(bad, NOW), `days=${String(bad)}`).toBeNull();
    }
    expect(retentionCutoff(180, new Date('not-a-date'))).toBeNull();
    expect(retentionCutoff(180, null as unknown as Date)).toBeNull();
    // An OMITTED clock is not malformed: it defaults to `now` (documented fallback).
    expect(retentionCutoff(180, undefined as unknown as Date)).toBeInstanceOf(Date);
  });

  it('exposes the plan-mandated windows (plus the task-110 365-day agent audit trail)', () => {
    expect(RETENTION_DAYS).toEqual({
      eventTriggerLogs: 90,
      emailLogs: 180,
      loginAttempts: 90,
      notificationQueue: 30,
      agentAuditLogs: 365,
      reminderSendClaims: 90,
      schedulerTicks: 90,
      auditEvents: 365,
      auditUndoSnapshots: 7,
      securityEvents: 365,
      auditLogs: 365,
      botUpdates: 30,
      botAuditLogs: 30,
      webhookIdempotencyKeys: 30,
      feedIngestSeen: 90,
      feedIngestProposals: 90,
      greetingHistory: 1095,
      cronExecutionLogs: 30,
    });
  });
});

describe('purgeLogTable (todo 41)', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it('deletes trigger logs older than 90 days via a parameterized cutoff', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 7 });
    const deleted = await purgeLogTable('event_trigger_logs', { now: NOW });

    expect(deleted).toBe(7);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toBe('DELETE FROM event_trigger_logs WHERE created_at < $1');
    expect((params?.[0] as Date).toISOString()).toBe('2026-06-29T12:00:00.000Z');
  });

  it('uses sent_at (email_logs has no created_at) with the 180-day window', async () => {
    await purgeLogTable('email_logs', { now: NOW });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toBe('DELETE FROM email_logs WHERE sent_at < $1');
    expect((params?.[0] as Date).toISOString()).toBe('2026-03-31T12:00:00.000Z');
  });

  it('uses last_attempt (login_attempts has no created_at) with the 90-day window', async () => {
    await purgeLogTable('login_attempts', { now: NOW });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toBe('DELETE FROM login_attempts WHERE last_attempt < $1');
    expect((params?.[0] as Date).toISOString()).toBe('2026-06-29T12:00:00.000Z');
  });

  it('purges only completed/dead queue rows with the 30-day window', async () => {
    await purgeLogTable('notification_queue', { now: NOW });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toBe(
      `DELETE FROM notification_queue WHERE updated_at < $1 AND status IN ('completed', 'dead')`,
    );
    expect((params?.[0] as Date).toISOString()).toBe('2026-08-28T12:00:00.000Z');
  });

  it('purges the agent audit trail with the 365-day window (task 110)', async () => {
    await purgeLogTable('agent_audit_logs', { now: NOW });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toBe('DELETE FROM agent_audit_logs WHERE created_at < $1');
    expect((params?.[0] as Date).toISOString()).toBe('2025-09-27T12:00:00.000Z');
  });

  it('deletes audit rows older than 365 days and keeps newer ones (strict cutoff)', async () => {
    const retained: Array<{ id: number; created_at: Date }> = [
      { id: 1, created_at: new Date('2025-09-27T11:59:59.999Z') }, // 1ms past the window -> purged
      { id: 2, created_at: new Date('2025-09-27T12:00:00.000Z') }, // exactly at the cutoff -> kept
      { id: 3, created_at: new Date('2026-01-01T00:00:00.000Z') }, // recent -> kept
    ];
    // The fake applies the SHIPPED SQL's `created_at < $1` predicate, so this drives the real
    // purge path end to end for the audit table.
    mockQuery.mockImplementation(async (_text: string, params?: unknown[]) => {
      const cutoff = (params?.[0] as Date).getTime();
      const before = retained.length;
      const kept = retained.filter((row) => !(row.created_at.getTime() < cutoff));
      retained.length = 0;
      retained.push(...kept);
      return { rows: [], rowCount: before - kept.length };
    });

    const deleted = await purgeLogTable('agent_audit_logs', { now: NOW });

    expect(deleted).toBe(1);
    expect(retained.map((row) => row.id)).toEqual([2, 3]);
  });

  it('skips the DELETE entirely for a malformed clock or threshold', async () => {
    await expect(purgeLogTable('event_trigger_logs', { now: null as unknown as Date })).resolves.toBe(0);
    await expect(purgeLogTable('event_trigger_logs', { days: 0 })).resolves.toBe(0);
    await expect(purgeLogTable('email_logs', { days: -5, now: NOW })).resolves.toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('purgeExpiredLogs (todo 41)', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockImplementation(async (text: string) => {
      if (text.includes('event_trigger_logs')) return { rows: [], rowCount: 11 };
      if (text.includes('email_logs')) return { rows: [], rowCount: 22 };
      if (text.includes('login_attempts')) return { rows: [], rowCount: 33 };
      if (text.includes('notification_queue')) return { rows: [], rowCount: 44 };
      if (text.includes('agent_audit_logs')) return { rows: [], rowCount: 55 };
      if (text.includes('reminder_send_claims')) return { rows: [], rowCount: 1 };
      if (text.includes('scheduler_ticks')) return { rows: [], rowCount: 2 };
      if (text.includes('audit_events')) return { rows: [], rowCount: 3 };
      if (text.includes('audit_undo_snapshots')) return { rows: [], rowCount: 4 };
      if (text.includes('security_events')) return { rows: [], rowCount: 5 };
      // bot_audit_logs 必须排在 audit_logs 之前（includes 前缀冲突）
      if (text.includes('bot_audit_logs')) return { rows: [], rowCount: 8 };
      if (text.includes('audit_logs')) return { rows: [], rowCount: 6 };
      if (text.includes('bot_updates')) return { rows: [], rowCount: 7 };
      if (text.includes('webhook_idempotency_keys')) return { rows: [], rowCount: 9 };
      if (text.includes('feed_ingest_seen')) return { rows: [], rowCount: 10 };
      if (text.includes('feed_ingest_proposals')) return { rows: [], rowCount: 11 };
      if (text.includes('greeting_history')) return { rows: [], rowCount: 12 };
      if (text.includes('cron_execution_logs')) return { rows: [], rowCount: 13 };
      // v2.28 C13：新增 5 张
      if (text.includes('scheduler_runs')) return { rows: [], rowCount: 14 };
      if (text.includes('rate_limits')) return { rows: [], rowCount: 15 };
      if (text.includes('collaboration_activity')) return { rows: [], rowCount: 16 };
      if (text.includes('data_health_repairs')) return { rows: [], rowCount: 17 };
      if (text.includes('calendar_sync_events')) return { rows: [], rowCount: 18 };
      return { rows: [], rowCount: 0 };
    });
  });

  it('purges every logging table (v2.28: 23 tables) and returns their counts', async () => {
    const result = await purgeExpiredLogs({ now: NOW });

    expect(result).toEqual({
      triggerLogs: 11,
      emailLogs: 22,
      loginAttempts: 33,
      notificationQueue: 44,
      agentAuditLogs: 55,
      reminderSendClaims: 1,
      schedulerTicks: 2,
      auditEvents: 3,
      auditUndoSnapshots: 4,
      securityEvents: 5,
      auditLogs: 6,
      botUpdates: 7,
      botAuditLogs: 8,
      webhookIdempotencyKeys: 9,
      feedIngestSeen: 10,
      feedIngestProposals: 11,
      greetingHistory: 12,
      cronExecutionLogs: 13,
      schedulerRuns: 14,
      rateLimits: 15,
      collaborationActivity: 16,
      dataHealthRepairs: 17,
      calendarSyncEvents: 18,
    });
    // 5 张既有表 + v2.26 的 13 张 + v2.28 的 5 张 = 23 条 DELETE
    expect(mockQuery).toHaveBeenCalledTimes(23);
    const tables = mockQuery.mock.calls.map(([sql]) => sql.split(' ')[2]);
    expect(new Set(tables).size).toBe(23);
  });

  it('returns zero counts and issues no DELETE when the clock is malformed', async () => {
    const result = await purgeExpiredLogs({ now: null as unknown as Date });

    expect(result.triggerLogs).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
