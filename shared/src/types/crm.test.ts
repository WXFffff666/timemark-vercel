import { describe, expect, it } from 'vitest';
import {
  CADENCE_DAY_PRESETS,
  CADENCE_DAYS_MAX,
  GIFT_DIRECTIONS,
  INTERACTION_KINDS,
  cadenceDaysSchema,
  createContactPromiseSchema,
  createGiftRecordSchema,
  createInteractionSchema,
} from './crm.js';
import { createFixedContactSchema, updateFixedContactSchema } from '../schemas/contact.schema.js';

/**
 * D4 personal-CRM validation (todos 60/61): interaction kinds, gift directions,
 * promise due dates (null allowed) and the cadence-days contract (presets or a
 * custom positive integer, null clears; 0/negative/non-numeric/over-cap rejected).
 */
describe('crm interaction schema', () => {
  it('accepts every documented kind and both optional fields', () => {
    for (const kind of INTERACTION_KINDS) {
      const parsed = createInteractionSchema.safeParse({ kind, summary: '见面', mood: '开心' });
      expect(parsed.success, kind).toBe(true);
    }
    expect(createInteractionSchema.safeParse({ kind: 'call' }).success).toBe(true);
  });

  it('rejects an unknown kind and a missing kind', () => {
    expect(createInteractionSchema.safeParse({ kind: 'smoke-signal' }).success).toBe(false);
    expect(createInteractionSchema.safeParse({ summary: '没有 kind' }).success).toBe(false);
  });

  it('accepts ISO instants, date-only strings and rejects malformed times', () => {
    expect(createInteractionSchema.safeParse({ kind: 'call', occurredAt: '2026-09-01T10:00:00.000Z' }).success).toBe(true);
    expect(createInteractionSchema.safeParse({ kind: 'call', occurredAt: '2026-09-01' }).success).toBe(true);
    expect(createInteractionSchema.safeParse({ kind: 'call', occurredAt: 'yesterday' }).success).toBe(false);
  });
});

describe('crm promise schema', () => {
  it('accepts a promise with no due date (null or omitted)', () => {
    expect(createContactPromiseSchema.safeParse({ text: '周末回电话', dueAt: null }).success).toBe(true);
    expect(createContactPromiseSchema.safeParse({ text: '周末回电话' }).success).toBe(true);
  });

  it('rejects empty text and a non-ISO due date', () => {
    expect(createContactPromiseSchema.safeParse({ text: '' }).success).toBe(false);
    expect(createContactPromiseSchema.safeParse({ text: 'x', dueAt: '31/12/2026' }).success).toBe(false);
  });
});

describe('crm gift schema', () => {
  it('accepts given/received with an amount and rejects anything else', () => {
    for (const direction of GIFT_DIRECTIONS) {
      expect(createGiftRecordSchema.safeParse({ description: '茶叶', direction }).success, direction).toBe(true);
    }
    expect(createGiftRecordSchema.safeParse({ description: '茶叶', direction: 'stolen' }).success).toBe(false);
    expect(createGiftRecordSchema.safeParse({ description: '茶叶', direction: 'given', amountCents: -1 }).success).toBe(false);
    expect(createGiftRecordSchema.safeParse({ description: '茶叶', direction: 'given', amountCents: 199.5 }).success).toBe(false);
  });
});

describe('cadence days contract', () => {
  it('accepts every preset and a custom positive integer', () => {
    for (const days of CADENCE_DAY_PRESETS) {
      expect(cadenceDaysSchema.safeParse(days).success, String(days)).toBe(true);
    }
    expect(cadenceDaysSchema.safeParse(45).success).toBe(true);
    expect(cadenceDaysSchema.safeParse(CADENCE_DAYS_MAX).success).toBe(true);
  });

  it('rejects 0, negatives, fractions, numeric strings and values over the cap', () => {
    for (const days of [0, -30, 3.5, '30', Number.NaN, CADENCE_DAYS_MAX + 1]) {
      expect(cadenceDaysSchema.safeParse(days).success, String(days)).toBe(false);
    }
  });

  it('surfaces the cadence fields on the contact create/update schemas', () => {
    const create = createFixedContactSchema.safeParse({
      name: '张三',
      email: 'zhang@example.com',
      cadenceDays: 30,
      cadenceEnabled: true,
    });
    expect(create.success).toBe(true);

    expect(createFixedContactSchema.safeParse({ name: '张三', email: 'z@e.com', cadenceDays: 0 }).success).toBe(false);
    expect(updateFixedContactSchema.safeParse({ cadenceDays: null }).success).toBe(true);
    expect(updateFixedContactSchema.safeParse({ cadenceDays: 90, cadenceEnabled: false }).success).toBe(true);
    expect(updateFixedContactSchema.safeParse({ cadenceDays: '30' }).success).toBe(false);
  });
});
