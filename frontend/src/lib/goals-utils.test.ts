import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GoalWithMilestones } from '@timemark/shared';
import { dueCountdownLabel, goalPercent } from './goals-utils';

/**
 * Plan todo 82: the goals card derives its percentage from the milestone
 * checklist when the goal has no numeric target, and from the server-clamped
 * value progress otherwise. Zero milestones is 0 - never NaN.
 */

function goal(partial: Partial<GoalWithMilestones>): GoalWithMilestones {
  return {
    id: 1,
    user_id: 1,
    profile_id: null,
    title: 'g',
    description: null,
    category: null,
    target_value: null,
    current_value: 0,
    unit: null,
    start_date: '2026-01-01',
    target_date: null,
    status: 'active',
    created_at: null,
    updated_at: null,
    progress: null,
    milestone_count: 0,
    milestone_done_count: 0,
    milestones: [],
    ...partial,
  };
}

describe('goalPercent', () => {
  it('is 33 for 1 of 3 milestones and 67 for 2 of 3 (no numeric target)', () => {
    expect(goalPercent(goal({ milestone_count: 3, milestone_done_count: 1 }))).toBe(33);
    expect(goalPercent(goal({ milestone_count: 3, milestone_done_count: 2 }))).toBe(67);
    expect(goalPercent(goal({ milestone_count: 2, milestone_done_count: 1 }))).toBe(50);
  });

  it('is 0 (never NaN) for a goal with 0 milestones and no target', () => {
    const value = goalPercent(goal({ milestone_count: 0, milestone_done_count: 0 }));
    expect(Number.isNaN(value)).toBe(false);
    expect(value).toBe(0);
  });

  it('prefers the server value progress when a target_value exists', () => {
    expect(goalPercent(goal({ target_value: 100, current_value: 150, progress: 100 }))).toBe(100);
    expect(goalPercent(goal({ target_value: 10, progress: 40.4 }))).toBe(40);
    // target exists but server has not derived yet -> milestone ratio fallback
    expect(goalPercent(goal({ target_value: 4, milestone_count: 2, milestone_done_count: 1 }))).toBe(50);
  });
});

describe('dueCountdownLabel', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null for a missing or invalid date', () => {
    expect(dueCountdownLabel(null)).toBeNull();
    expect(dueCountdownLabel('not-a-date')).toBeNull();
  });

  it('counts down future days and flags the past deterministically', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 28, 0, 0, 0));
    expect(dueCountdownLabel('2026-10-08')).toBe('还有 10 天');
    expect(dueCountdownLabel('2026-09-28')).toBe('今天到期');
    expect(dueCountdownLabel('2026-09-01')).toBe('已过期 27 天');
  });
});
