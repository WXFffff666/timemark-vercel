import { describe, expect, it } from 'vitest';
import {
  advanceExpiryDate,
  buildExpirySendKey,
  DEFAULT_EXPIRY_LEAD_DAYS,
  expiryEventType,
  normalizeMonthlyCostCents,
} from './expiry-schedule.js';

describe('advanceExpiryDate (todo 45)', () => {
  it('advances monthly from 2026-01-31 to a real month end (2026-02-28, never 2026-02-31)', () => {
    expect(advanceExpiryDate('2026-01-31', 'monthly')).toBe('2026-02-28');
    expect(advanceExpiryDate('2026-02-28', 'monthly')).toBe('2026-03-28');
    expect(advanceExpiryDate('2026-12-31', 'monthly')).toBe('2027-01-31');
  });

  it('clamps quarterly and yearly across month lengths', () => {
    expect(advanceExpiryDate('2026-01-31', 'quarterly')).toBe('2026-04-30');
    expect(advanceExpiryDate('2026-10-31', 'quarterly')).toBe('2027-01-31');
    expect(advanceExpiryDate('2024-02-29', 'yearly')).toBe('2025-02-28');
    expect(advanceExpiryDate('2026-08-31', 'yearly')).toBe('2027-08-31');
  });

  it('advances custom cycles by cycle_days', () => {
    expect(advanceExpiryDate('2026-01-01', 'custom', 45)).toBe('2026-02-15');
    expect(advanceExpiryDate('2026-01-01', 'custom', 365)).toBe('2027-01-01');
  });

  it('returns null for once, custom without cycle_days and malformed dates', () => {
    expect(advanceExpiryDate('2026-01-31', 'once')).toBeNull();
    expect(advanceExpiryDate('2026-01-31', 'custom')).toBeNull();
    expect(advanceExpiryDate('2026-01-31', 'custom', 0)).toBeNull();
    expect(advanceExpiryDate('not-a-date', 'monthly')).toBeNull();
    expect(advanceExpiryDate('', 'monthly')).toBeNull();
  });

  it('accepts Date values as produced by pg DATE columns', () => {
    expect(advanceExpiryDate(new Date('2026-01-31T00:00:00Z') as unknown as string, 'monthly')).toBe('2026-02-28');
  });
});

describe('normalizeMonthlyCostCents (todo 46 fixture maths)', () => {
  it('normalises monthly/quarterly/yearly to a per-month amount', () => {
    expect(normalizeMonthlyCostCents(1999, 'monthly')).toBe(1999);
    expect(normalizeMonthlyCostCents(3000, 'quarterly')).toBe(1000);
    expect(normalizeMonthlyCostCents(12000, 'yearly')).toBe(1000);
  });

  it('excludes once from recurring totals (null) and handles custom/cycle_days', () => {
    expect(normalizeMonthlyCostCents(50000, 'once')).toBeNull();
    expect(normalizeMonthlyCostCents(600, 'custom', 30)).toBe(600);
    expect(normalizeMonthlyCostCents(365, 'custom', 365)).toBe(30);
    expect(normalizeMonthlyCostCents(600, 'custom')).toBeNull();
    expect(normalizeMonthlyCostCents(null, 'monthly')).toBeNull();
  });

  it('rounds fractional monthly equivalents', () => {
    expect(normalizeMonthlyCostCents(1000, 'quarterly')).toBe(333);
    expect(normalizeMonthlyCostCents(1000, 'yearly')).toBe(83);
  });
});

describe('expiry reminder keys', () => {
  it('prefixes the send key so it can never collide with an event key', () => {
    const key = buildExpirySendKey('2026-01-20', 7, '09:00');
    expect(key).toBe('expiry:2026-01-20#d7#t09:00');
    expect(key.startsWith('expiry:')).toBe(true);
  });

  it('exposes sane defaults and a per-kind template family', () => {
    expect(DEFAULT_EXPIRY_LEAD_DAYS).toEqual([30, 7, 3, 1, 0]);
    expect(expiryEventType('subscription')).toBe('expiry_subscription');
    expect(expiryEventType('warranty')).toBe('expiry_warranty');
  });
});
