import { describe, expect, it } from 'vitest';
import {
  createInventoryItemSchema,
  updateInventoryItemSchema,
  consumeInventoryItemSchema,
  INVENTORY_CATEGORIES,
} from './inventory.js';
import { buildInventorySendKey, inventoryEventType } from '../inventory-schedule.js';

/**
 * Todo 49 acceptance (shared side):
 *  - a minimal inventory payload is valid; null expires_at (non-perishable) is allowed
 *  - negative quantity / negative threshold are rejected
 *  - consume quantity must be > 0 (0 and negatives rejected)
 *  - expires_at before purchased_at is rejected
 *  - the reminder send key is isolated in the `inventory:` key space
 */

describe('createInventoryItemSchema', () => {
  it('accepts a minimal payload and a non-perishable without expires_at', () => {
    const parsed = createInventoryItemSchema.parse({ name: '大米' });
    expect(parsed.name).toBe('大米');
    expect(parsed.expiresAt).toBeUndefined();
    expect(parsed.quantity).toBeUndefined();

    const explicitNull = createInventoryItemSchema.parse({ name: '洗衣液', expiresAt: null, quantity: 2 });
    expect(explicitNull.expiresAt).toBeNull();
    expect(explicitNull.quantity).toBe(2);
  });

  it('accepts every documented category', () => {
    for (const category of INVENTORY_CATEGORIES) {
      const parsed = createInventoryItemSchema.parse({ name: `${category} item`, category });
      expect(parsed.category).toBe(category);
    }
  });

  it('accepts a full payload with reminder config', () => {
    const parsed = createInventoryItemSchema.parse({
      name: '布洛芬',
      category: 'medicine',
      quantity: 2.5,
      unit: '盒',
      lowStockThreshold: 1,
      purchasedAt: '2026-01-01',
      expiresAt: '2026-12-31',
      location: '药箱',
      notes: '儿童用量',
      reminderConfig: { daysBeforeList: [30, 7], reminderTimes: ['09:00'], channels: ['email'] },
      profileId: 1,
    });
    expect(parsed.quantity).toBe(2.5);
    expect(parsed.unit).toBe('盒');
  });

  it('rejects a negative quantity and a negative low-stock threshold', () => {
    const negativeQty = createInventoryItemSchema.safeParse({ name: 'X', quantity: -1 });
    expect(negativeQty.success).toBe(false);
    if (!negativeQty.success) {
      expect(JSON.stringify(negativeQty.error.issues)).toContain('数量不能为负数');
    }

    const negativeThreshold = createInventoryItemSchema.safeParse({ name: 'X', lowStockThreshold: -2 });
    expect(negativeThreshold.success).toBe(false);
  });

  it('rejects expires_at before purchased_at', () => {
    const result = createInventoryItemSchema.safeParse({
      name: '牛奶',
      purchasedAt: '2026-06-01',
      expiresAt: '2026-05-01',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toContain('expires_at 不能早于 purchased_at');
    }
  });

  it('rejects a non-numeric quantity and an unknown category', () => {
    expect(createInventoryItemSchema.safeParse({ name: 'X', quantity: '2' }).success).toBe(false);
    expect(createInventoryItemSchema.safeParse({ name: 'X', category: 'nonsense' }).success).toBe(false);
  });
});

describe('updateInventoryItemSchema', () => {
  it('accepts a single-field patch (partial) and still rejects a bad pair', () => {
    expect(updateInventoryItemSchema.safeParse({ quantity: 3 }).success).toBe(true);
    expect(updateInventoryItemSchema.safeParse({}).success).toBe(true);

    const bad = updateInventoryItemSchema.safeParse({
      purchasedAt: '2026-06-01',
      expiresAt: '2026-05-01',
    });
    expect(bad.success).toBe(false);
  });
});

describe('consumeInventoryItemSchema', () => {
  it('requires a strictly positive quantity', () => {
    expect(consumeInventoryItemSchema.safeParse({ quantity: 1 }).success).toBe(true);
    expect(consumeInventoryItemSchema.safeParse({ quantity: 0.25 }).success).toBe(true);

    for (const bad of [{ quantity: 0 }, { quantity: -1 }, { quantity: '2' }, {}]) {
      expect(consumeInventoryItemSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('inventory schedule helpers', () => {
  it('builds a send key isolated in the inventory: key space', () => {
    expect(buildInventorySendKey('2026-06-01', 7, '09:00')).toBe('inventory:2026-06-01#d7#t09:00');
    expect(buildInventorySendKey('2026-06-01', 7, '09:00')).not.toMatch(/^expiry:/);
  });

  it('maps every category to a template event type', () => {
    for (const category of INVENTORY_CATEGORIES) {
      expect(inventoryEventType(category)).toBe(`inventory_${category}`);
    }
  });
});
