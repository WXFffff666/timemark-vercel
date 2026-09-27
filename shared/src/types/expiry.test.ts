import { describe, expect, it } from 'vitest';
import {
  createExpiryItemSchema,
  updateExpiryItemSchema,
  EXPIRY_KINDS,
  EXPIRY_CYCLES,
} from './expiry.js';

/**
 * Todo 44 acceptance: the Zod schema validates create/update payloads and rejects
 *  - a negative amount_cents
 *  - an unknown kind
 *  - next_due_date before start_date
 * while allowing a lapsed item (past next_due_date) as long as it is explicit.
 */

const MINIMAL = { kind: 'subscription', title: 'Netflix 会员', nextDueDate: '2026-02-01' } as const;

describe('createExpiryItemSchema', () => {
  it('accepts a minimal payload and defaults nothing implicitly', () => {
    const parsed = createExpiryItemSchema.parse(MINIMAL);
    expect(parsed.kind).toBe('subscription');
    expect(parsed.title).toBe('Netflix 会员');
    expect(parsed.nextDueDate).toBe('2026-02-01');
    expect(parsed.amountCents).toBeUndefined();
    expect(parsed.cycle).toBeUndefined();
  });

  it('accepts a full payload for every supported kind', () => {
    for (const kind of EXPIRY_KINDS) {
      const parsed = createExpiryItemSchema.parse({
        kind,
        title: `${kind} item`,
        vendor: 'ACME',
        amountCents: 1999,
        currency: 'cny',
        cycle: 'monthly',
        cycleDays: null,
        startDate: '2026-01-01',
        nextDueDate: '2026-02-01',
        autoRenew: true,
        notes: 'note',
        tags: ['a', 'b'],
        reminderConfig: { enabled: true, daysBeforeList: [30, 7, 3, 1, 0], reminderTimes: ['09:00'], channels: ['email'] },
        isActive: true,
      });
      expect(parsed.kind).toBe(kind);
      expect(parsed.amountCents).toBe(1999);
    }
  });

  it('rejects a negative amount_cents', () => {
    const result = createExpiryItemSchema.safeParse({ ...MINIMAL, amountCents: -1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = JSON.stringify(result.error.issues);
      expect(issues).toContain('金额不能为负数');
    }
  });

  it('rejects a non-integer amount_cents', () => {
    expect(createExpiryItemSchema.safeParse({ ...MINIMAL, amountCents: 19.99 }).success).toBe(false);
  });

  it('rejects an unknown kind', () => {
    const result = createExpiryItemSchema.safeParse({ ...MINIMAL, kind: 'nonsense' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.') === 'kind')).toBe(true);
    }
  });

  it('rejects next_due_date before start_date', () => {
    const result = createExpiryItemSchema.safeParse({
      ...MINIMAL,
      startDate: '2026-03-01',
      nextDueDate: '2026-02-28',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message === 'next_due_date 不能早于 start_date')).toBe(true);
    }
  });

  it('allows next_due_date in the past with is_active=true (expiry items may lapse)', () => {
    const result = createExpiryItemSchema.safeParse({
      ...MINIMAL,
      startDate: '2025-01-01',
      nextDueDate: '2025-12-31',
      isActive: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects malformed dates', () => {
    expect(createExpiryItemSchema.safeParse({ ...MINIMAL, nextDueDate: '2026/02/01' }).success).toBe(false);
    expect(createExpiryItemSchema.safeParse({ ...MINIMAL, nextDueDate: '2026-2-1' }).success).toBe(false);
  });

  it('rejects a missing or null next_due_date but allows a null start_date', () => {
    expect(createExpiryItemSchema.safeParse({ kind: 'bill', title: 'x' }).success).toBe(false);
    expect(createExpiryItemSchema.safeParse({ ...MINIMAL, nextDueDate: null }).success).toBe(false);
    expect(createExpiryItemSchema.safeParse({ ...MINIMAL, startDate: null }).success).toBe(true);
  });

  it('rejects a non 3-letter currency', () => {
    expect(createExpiryItemSchema.safeParse({ ...MINIMAL, currency: 'RMB' }).success).toBe(true);
    expect(createExpiryItemSchema.safeParse({ ...MINIMAL, currency: 'CN' }).success).toBe(false);
    expect(createExpiryItemSchema.safeParse({ ...MINIMAL, currency: 'CNYX' }).success).toBe(false);
  });

  it('requires cycle_days when cycle is custom', () => {
    expect(createExpiryItemSchema.safeParse({ ...MINIMAL, cycle: 'custom' }).success).toBe(false);
    expect(createExpiryItemSchema.safeParse({ ...MINIMAL, cycle: 'custom', cycleDays: 45 }).success).toBe(true);
  });

  it('rejects an unknown cycle', () => {
    expect(createExpiryItemSchema.safeParse({ ...MINIMAL, cycle: 'weekly' }).success).toBe(false);
    for (const cycle of EXPIRY_CYCLES) {
      // `custom` additionally requires cycleDays (checked in its own test).
      const payload = cycle === 'custom' ? { ...MINIMAL, cycle, cycleDays: 30 } : { ...MINIMAL, cycle };
      expect(createExpiryItemSchema.safeParse(payload).success, `cycle ${cycle}`).toBe(true);
    }
  });

  it('rejects a malformed reminder time', () => {
    expect(
      createExpiryItemSchema.safeParse({ ...MINIMAL, reminderConfig: { reminderTimes: ['9:00'] } }).success,
    ).toBe(false);
    expect(
      createExpiryItemSchema.safeParse({ ...MINIMAL, reminderConfig: { reminderTimes: ['09:00'] } }).success,
    ).toBe(true);
  });

  it('rejects an empty title', () => {
    expect(createExpiryItemSchema.safeParse({ ...MINIMAL, title: '' }).success).toBe(false);
  });
});

describe('updateExpiryItemSchema', () => {
  it('accepts a single-field partial update', () => {
    const parsed = updateExpiryItemSchema.parse({ title: '新名称' });
    expect(parsed.title).toBe('新名称');
    expect(parsed.nextDueDate).toBeUndefined();
  });

  it('rejects the same malformed values when present', () => {
    expect(updateExpiryItemSchema.safeParse({ amountCents: -5 }).success).toBe(false);
    expect(updateExpiryItemSchema.safeParse({ kind: 'nonsense' }).success).toBe(false);
    expect(
      updateExpiryItemSchema.safeParse({ startDate: '2026-03-01', nextDueDate: '2026-02-28' }).success,
    ).toBe(false);
    expect(updateExpiryItemSchema.safeParse({ cycle: 'custom' }).success).toBe(false);
  });

  it('accepts an empty object (no-op patch)', () => {
    expect(updateExpiryItemSchema.safeParse({}).success).toBe(true);
  });
});
