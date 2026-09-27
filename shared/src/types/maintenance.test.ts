import { describe, expect, it } from 'vitest';
import {
  createMaintenancePlanSchema,
  updateMaintenancePlanSchema,
  recordMaintenanceLogSchema,
  ASSET_KINDS,
  NO_INTERVAL_MESSAGE,
} from './maintenance.js';
import {
  addDaysYmd,
  computeNextDueAt,
  computeNextDueUsage,
  usageNeedsNudge,
  buildMaintenanceSendKey,
  buildMaintenanceUsageKey,
  maintenanceEventType,
  USAGE_NUDGE_RATIO,
} from '../maintenance-schedule.js';

/**
 * Todo 50 acceptance (shared side):
 *  - a 180-day/10000km plan parses; a plan with NO interval is rejected with a clear message
 *  - a usage-only plan parses (intervalDays null)
 *  - next_due_at = done_at + interval_days and next_due_usage = usage_at + interval_usage
 *  - the usage nudge fires within 10% of the threshold (and never when the ratio is exceeded)
 *  - first log reschedules; the maths always takes the LATEST input
 */

describe('createMaintenancePlanSchema', () => {
  it('accepts a 180-day / 10000km plan and every asset kind', () => {
    const parsed = createMaintenancePlanSchema.parse({
      assetName: '大众迈腾',
      assetKind: 'vehicle',
      intervalDays: 180,
      intervalUsage: 10_000,
      usageUnit: 'km',
      currentUsage: 52_000,
      lastDoneAt: '2026-01-01',
      nextDueAt: '2026-06-30',
      nextDueUsage: 62_000,
    });
    expect(parsed.intervalDays).toBe(180);
    expect(parsed.intervalUsage).toBe(10_000);

    for (const assetKind of ASSET_KINDS) {
      expect(createMaintenancePlanSchema.safeParse({ assetName: 'A', assetKind, intervalDays: 30 }).success).toBe(true);
    }
  });

  it('rejects a plan with NEITHER interval with the explicit message', () => {
    const result = createMaintenancePlanSchema.safeParse({ assetName: '空调' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toContain(NO_INTERVAL_MESSAGE);
    }
  });

  it('accepts a usage-only plan (date interval null) and a date-only plan', () => {
    const usageOnly = createMaintenancePlanSchema.parse({
      assetName: '发电机',
      intervalUsage: 250,
      usageUnit: 'hours',
    });
    expect(usageOnly.intervalDays).toBeUndefined();
    expect(usageOnly.intervalUsage).toBe(250);

    const dateOnly = createMaintenancePlanSchema.parse({ assetName: '净水器', intervalDays: 90 });
    expect(dateOnly.intervalUsage).toBeUndefined();
  });

  it('rejects non-positive intervals and non-numeric values', () => {
    expect(createMaintenancePlanSchema.safeParse({ assetName: 'A', intervalDays: 0 }).success).toBe(false);
    expect(createMaintenancePlanSchema.safeParse({ assetName: 'A', intervalDays: -30 }).success).toBe(false);
    expect(createMaintenancePlanSchema.safeParse({ assetName: 'A', intervalUsage: 1.5 }).success).toBe(false);
    expect(createMaintenancePlanSchema.safeParse({ assetName: 'A', intervalDays: '180' }).success).toBe(false);
    expect(createMaintenancePlanSchema.safeParse({ assetName: 'A', intervalDays: 30, usageUnit: 'lightyears' }).success).toBe(false);
  });

  it('update schema stays partial (a notes-only patch is valid)', () => {
    expect(updateMaintenancePlanSchema.safeParse({ notes: 'x' }).success).toBe(true);
    expect(updateMaintenancePlanSchema.safeParse({ intervalDays: null, intervalUsage: null }).success).toBe(true);
  });
});

describe('recordMaintenanceLogSchema', () => {
  it('requires doneAt and accepts usage/cost/notes', () => {
    expect(recordMaintenanceLogSchema.safeParse({}).success).toBe(false);
    expect(recordMaintenanceLogSchema.safeParse({ doneAt: '2026/06/01' }).success).toBe(false);
    const parsed = recordMaintenanceLogSchema.parse({
      doneAt: '2026-06-01',
      usageAt: 62_000,
      costCents: 45_000,
      notes: '更换机油',
    });
    expect(parsed.usageAt).toBe(62_000);
  });

  it('rejects negative usage and negative cost', () => {
    expect(recordMaintenanceLogSchema.safeParse({ doneAt: '2026-06-01', usageAt: -1 }).success).toBe(false);
    expect(recordMaintenanceLogSchema.safeParse({ doneAt: '2026-06-01', costCents: -1 }).success).toBe(false);
    expect(recordMaintenanceLogSchema.safeParse({ doneAt: '2026-06-01', costCents: 1.5 }).success).toBe(false);
  });
});

describe('maintenance reschedule maths', () => {
  it('next_due_at = done_at + 180d and next_due_usage = usage_at + 10000', () => {
    expect(computeNextDueAt('2026-06-01', 180)).toBe('2026-11-28');
    expect(computeNextDueUsage(62_000, 10_000)).toBe(72_000);
  });

  it('a second log from a later date reschedules from the LATEST log', () => {
    const first = computeNextDueAt('2026-06-01', 180);
    const second = computeNextDueAt('2026-06-10', 180);
    expect(first).toBe('2026-11-28');
    expect(second).toBe('2026-12-07');
    expect(computeNextDueUsage(62_000, 10_000)).toBe(72_000);
    expect(computeNextDueUsage(70_000, 10_000)).toBe(80_000);
  });

  it('crosses month/year boundaries correctly and rejects a missing interval', () => {
    expect(addDaysYmd('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysYmd('2024-02-28', 1)).toBe('2024-02-29');
    expect(computeNextDueAt('2026-06-01', null)).toBeNull();
    expect(computeNextDueAt('2026-06-01', 0)).toBeNull();
    expect(computeNextDueUsage(null, 10_000)).toBeNull();
    expect(computeNextDueUsage(100, null)).toBeNull();
  });
});

describe('usage nudge threshold (10%)', () => {
  it('fires exactly at/below 10% remaining and not above', () => {
    // interval 10000, threshold = 1000: remaining 1000 fires, 1001 does not.
    expect(usageNeedsNudge({ currentUsage: 9_000, nextDueUsage: 10_000, intervalUsage: 10_000 })).toBe(true);
    expect(usageNeedsNudge({ currentUsage: 8_999, nextDueUsage: 10_000, intervalUsage: 10_000 })).toBe(false);
    // overdue counts (remaining negative)
    expect(usageNeedsNudge({ currentUsage: 10_500, nextDueUsage: 10_000, intervalUsage: 10_000 })).toBe(true);
    expect(USAGE_NUDGE_RATIO).toBe(0.1);
  });

  it('never fires when any value is missing', () => {
    expect(usageNeedsNudge({ currentUsage: null, nextDueUsage: 10_000, intervalUsage: 10_000 })).toBe(false);
    expect(usageNeedsNudge({ currentUsage: 9_000, nextDueUsage: null, intervalUsage: 10_000 })).toBe(false);
    expect(usageNeedsNudge({ currentUsage: 9_000, nextDueUsage: 10_000, intervalUsage: null })).toBe(false);
  });

  it('isolates the send keys and event type', () => {
    expect(buildMaintenanceSendKey('2026-06-01', 7, '09:00')).toBe('maintenance:2026-06-01#d7#t09:00');
    expect(buildMaintenanceUsageKey(11, 72_000)).toBe('maintenance:usage#11#u72000');
    expect(buildMaintenanceUsageKey(11, 72_000)).not.toBe(buildMaintenanceUsageKey(11, 62_000));
    expect(maintenanceEventType('vehicle')).toBe('maintenance_vehicle');
  });
});
