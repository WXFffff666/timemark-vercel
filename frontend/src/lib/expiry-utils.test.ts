import { describe, expect, it } from 'vitest';
import {
  annualiseSpend,
  bucketFor,
  cycleLabel,
  daysUntil,
  formatExpiryCountdown,
  formatMoney,
  kindLabel,
  parseLocalYmd,
  summariseBuckets,
  type ExpiryCosts,
} from './expiry-utils';

/** Fixed local reference: 2026-01-15 (month boundaries are deterministic). */
const REF = new Date(2026, 0, 15, 10, 0, 0);

describe('expiry-utils / bucketFor (failure scenario: a past due date is never hidden)', () => {
  it('places a past next_due_date in the overdue bucket', () => {
    expect(bucketFor('2026-01-01', REF)).toBe('overdue');
    expect(bucketFor('2025-12-31', REF)).toBe('overdue');
  });

  it('places today..+7 days in the week bucket', () => {
    expect(bucketFor('2026-01-15', REF)).toBe('week');
    expect(bucketFor('2026-01-22', REF)).toBe('week');
  });

  it('places a later date in the same calendar month in the month bucket', () => {
    expect(bucketFor('2026-01-23', REF)).toBe('month');
    expect(bucketFor('2026-01-31', REF)).toBe('month');
  });

  it('places next-month dates in the later bucket', () => {
    expect(bucketFor('2026-02-01', REF)).toBe('later');
  });

  it('treats null / malformed dates as none (no crash, no NaN)', () => {
    expect(bucketFor(null, REF)).toBe('none');
    expect(bucketFor(undefined, REF)).toBe('none');
    expect(bucketFor('', REF)).toBe('none');
    expect(bucketFor('not-a-date', REF)).toBe('none');
    expect(bucketFor('2026-13-40', REF)).toBe('none');
  });
});

describe('expiry-utils / daysUntil + parseLocalYmd', () => {
  it('computes whole-day differences against local midnight', () => {
    expect(daysUntil('2026-01-15', REF)).toBe(0);
    expect(daysUntil('2026-01-16', REF)).toBe(1);
    expect(daysUntil('2026-01-10', REF)).toBe(-5);
  });

  it('parses the date part of an ISO timestamp and rejects garbage', () => {
    expect(parseLocalYmd('2026-01-15T09:30:00.000Z')?.getDate()).toBe(15);
    expect(parseLocalYmd('')).toBeNull();
    expect(parseLocalYmd('2026/01/15')).toBeNull();
  });
});

describe('expiry-utils / summariseBuckets', () => {
  const items = [
    { next_due_date: '2026-01-01', is_active: true }, // overdue
    { next_due_date: '2026-01-16', is_active: true }, // week
    { next_due_date: '2026-01-28', is_active: true }, // month
    { next_due_date: '2026-03-01', is_active: true }, // later
    { next_due_date: '2026-01-02', is_active: false }, // inactive → ignored
  ];

  it('counts week + month and prefers the authoritative overdue count', () => {
    expect(summariseBuckets(items, REF, 1)).toEqual({ overdue: 1, week: 1, month: 1 });
  });

  it('falls back to a local overdue count when the API count is missing', () => {
    expect(summariseBuckets(items, REF)).toEqual({ overdue: 1, week: 1, month: 1 });
  });

  it('returns zeros for an empty list (not null, not NaN)', () => {
    expect(summariseBuckets([], REF, 0)).toEqual({ overdue: 0, week: 0, month: 0 });
  });
});

describe('expiry-utils / formatMoney (malformed input must not show NaN)', () => {
  it('formats a normal CNY amount', () => {
    expect(formatMoney(1999, 'CNY')).toContain('19.99');
  });

  it('formats a very large amount without NaN', () => {
    const text = formatMoney(9_999_999_999_999, 'CNY');
    expect(text).not.toContain('NaN');
    expect(text).toContain('99,999,999,999');
  });

  it('shows a placeholder for null / non-finite input', () => {
    expect(formatMoney(null, 'CNY')).toBe('—');
    expect(formatMoney(undefined, null)).toBe('—');
    expect(formatMoney(Number.NaN, 'CNY')).toBe('—');
    expect(formatMoney(Number.POSITIVE_INFINITY, 'CNY')).toBe('—');
  });

  it('handles an unknown currency code without throwing', () => {
    const text = formatMoney(500, 'ZZZZ');
    expect(text).not.toContain('NaN');
    expect(text).toContain('5.00');
  });
});

describe('expiry-utils / annualiseSpend', () => {
  const single: ExpiryCosts = {
    totalCents: 1000,
    currency: 'CNY',
    mixedCurrencies: false,
    byCurrency: { CNY: 1000 },
    byKind: [],
    monthly: [],
    once: { totalCents: 0, currency: null, byCurrency: {}, count: 0 },
  };

  it('multiplies the monthly normalised cost by 12 for a single currency', () => {
    const result = annualiseSpend(single);
    expect(result.mixed).toBe(false);
    expect(result.text).toContain('120.00');
  });

  it('never sums across currencies; flags mixed and shows the largest bucket', () => {
    const result = annualiseSpend({
      ...single,
      totalCents: 0,
      currency: null,
      mixedCurrencies: true,
      byCurrency: { CNY: 1000, USD: 5000 },
    });
    expect(result.mixed).toBe(true);
    expect(result.text).toContain('600.00'); // 5000 * 12 / 100
  });

  it('returns a placeholder for empty / malformed cost payloads', () => {
    expect(annualiseSpend(null).text).toBe('—');
    expect(annualiseSpend(undefined).text).toBe('—');
    // The a11y mock returns `[]` for `/api/expiry/costs` — must not crash.
    expect(annualiseSpend([] as unknown as ExpiryCosts).text).toBe('—');
    expect(
      annualiseSpend({ totalCents: 0, currency: null, mixedCurrencies: false, byCurrency: {} } as ExpiryCosts).text,
    ).not.toContain('NaN');
  });
});

describe('expiry-utils / labels + countdown text', () => {
  it('maps known kinds and falls back for an unknown kind from the API', () => {
    expect(kindLabel('subscription')).toBe('订阅');
    expect(kindLabel('nonsense-kind')).toBe('nonsense-kind');
    expect(kindLabel(null)).toBe('未知');
  });

  it('maps cycles and falls back for unknown cycles', () => {
    expect(cycleLabel('monthly')).toBe('每月');
    expect(cycleLabel('fortnightly')).toBe('fortnightly');
    expect(cycleLabel(null)).toBe('—');
  });

  it('renders overdue / future countdown text', () => {
    expect(formatExpiryCountdown({ days: 6, hours: 3, minutes: 5, isPast: false }).text).toBe('还有 6 天');
    expect(formatExpiryCountdown({ days: 12, hours: 1, minutes: 0, isPast: true }).text).toBe('已逾期 12 天');
    expect(formatExpiryCountdown({ days: 0, hours: 0, minutes: 0, isPast: true }).text).toBe('今天已到期');
  });
});
