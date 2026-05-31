import { describe, it, expect } from 'vitest';
import { getBlessing, blessings } from '@timemark/shared/blessings';

describe('Blessings', () => {
  const types = ['birthday', 'anniversary', 'exam', 'holiday', 'meeting', 'deadline', 'travel', 'graduation', 'wedding', 'medical'];

  it('returns string for each type', () => {
    for (const t of types) {
      const r = getBlessing(t);
      expect(typeof r).toBe('string');
      expect(r.length).toBeGreaterThan(0);
    }
  });

  it('returns custom message when provided', () => {
    expect(getBlessing('birthday', '自定义')).toBe('自定义');
  });

  it('has blessings object entries for all types', () => {
    for (const t of types) {
      expect(blessings[t as keyof typeof blessings]).toBeDefined();
    }
  });
});
