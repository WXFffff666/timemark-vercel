import { describe, expect, it } from 'vitest';
import {
  assetKindLabel,
  formatCostCents,
  formatUsage,
  maintenanceDueText,
  usageProgress,
  usageUnitLabel,
  type MaintenancePlan,
} from './maintenance-utils';

const base: MaintenancePlan = {
  id: 1,
  user_id: 1,
  profile_id: null,
  asset_name: '家用轿车',
  asset_kind: 'vehicle',
  interval_days: 180,
  interval_usage: 10000,
  usage_unit: 'km',
  current_usage: 43000,
  last_done_at: '2026-01-01',
  next_due_at: '2026-07-01',
  next_due_usage: 50000,
  notes: null,
  reminder_config: null,
  is_active: true,
  created_at: null,
  updated_at: null,
};

function plan(overrides: Partial<MaintenancePlan>): MaintenancePlan {
  return { ...base, ...overrides };
}

describe('usageProgress', () => {
  it('computes the used fraction within the current service window', () => {
    const progress = usageProgress(plan({}));
    expect(progress).not.toBeNull();
    expect(progress?.ratio).toBeCloseTo(0.3, 5);
    expect(progress?.percentage).toBe(30);
    expect(progress?.currentLabel).toBe('43000 公里');
    expect(progress?.nextLabel).toBe('50000 公里');
  });

  it('clamps out-of-range usage to 0..1 so the bar never overflows', () => {
    expect(usageProgress(plan({ current_usage: 39000 }))?.ratio).toBe(0);
    expect(usageProgress(plan({ current_usage: 50000 }))?.ratio).toBe(1);
    expect(usageProgress(plan({ current_usage: 999999 }))?.percentage).toBe(100);
  });

  it('returns null when there is no usage interval (date-only plan)', () => {
    expect(usageProgress(plan({ interval_usage: null, next_due_usage: null }))).toBeNull();
    expect(usageProgress(plan({ next_due_usage: null }))).toBeNull();
    expect(usageProgress(plan({ interval_usage: 0 }))).toBeNull();
  });

  it('never emits NaN in the labels', () => {
    const progress = usageProgress(plan({ current_usage: Number.NaN }));
    expect(progress).not.toBeNull();
    expect(progress?.currentLabel).toBe('40000 公里');
    expect(JSON.stringify(progress)).not.toContain('NaN');
  });
});

describe('maintenanceDueText', () => {
  const now = new Date(2026, 0, 1, 12, 0, 0);

  it('renders a real countdown when next_due_at is set', () => {
    const due = maintenanceDueText(plan({ next_due_at: '2026-01-22' }), now);
    expect(due.kind).toBe('future');
    expect(due.text).toBe('还有 20 天');
  });

  it('marks an overdue plan as overdue', () => {
    const due = maintenanceDueText(plan({ next_due_at: '2025-12-20' }), now);
    expect(due.kind).toBe('overdue');
    expect(due.text).toContain('已逾期');
  });

  it('renders 按用量保养 for usage-only plans and never Invalid Date', () => {
    const due = maintenanceDueText(plan({ next_due_at: null, interval_days: null }), now);
    expect(due).toEqual({ kind: 'usage', text: '按用量保养' });
    expect(due.text).not.toContain('Invalid');
  });

  it('renders 无下次保养 for a plan with neither a date nor a usage interval', () => {
    const due = maintenanceDueText(plan({ next_due_at: null, interval_usage: null }), now);
    expect(due).toEqual({ kind: 'none', text: '无下次保养' });
  });

  it('treats malformed next_due_at as no date instead of NaN', () => {
    const due = maintenanceDueText(plan({ next_due_at: 'garbage', interval_usage: null }), now);
    expect(due.text).not.toContain('NaN');
    expect(due.text).not.toContain('Invalid');
  });
});

describe('labels and formatting', () => {
  it('labels asset kinds and usage units, with fallbacks', () => {
    expect(assetKindLabel('vehicle')).toBe('车辆');
    expect(assetKindLabel('appliance')).toBe('家电');
    expect(assetKindLabel('unknown')).toBe('unknown');
    expect(usageUnitLabel('km')).toBe('公里');
    expect(usageUnitLabel('hours')).toBe('小时');
    expect(usageUnitLabel(null)).toBe('');
  });

  it('formats usage and cost with safe fallbacks', () => {
    expect(formatUsage(1200, 'km')).toBe('1200 公里');
    expect(formatUsage(Number.NaN, 'km')).toBe('—');
    expect(formatCostCents(12345)).toBe('¥123.45');
    expect(formatCostCents(null)).toBe('—');
  });
});
