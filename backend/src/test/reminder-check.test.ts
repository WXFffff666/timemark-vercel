import { describe, it, expect } from 'vitest';

function diffDaysLocal(dateA: string, dateB: string): number {
  const a = new Date(dateA + 'T00:00:00Z');
  const b = new Date(dateB + 'T00:00:00Z');
  return Math.round((b.getTime() - a.getTime()) / (86400 * 1000));
}

describe('reminder-check helpers', () => {
  it('diffDays calculates day difference', () => {
    expect(diffDaysLocal('2026-01-01', '2026-01-08')).toBe(7);
    expect(diffDaysLocal('2026-01-08', '2026-01-01')).toBe(-7);
  });
});
