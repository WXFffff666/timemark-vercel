import { describe, expect, it } from 'vitest';
import {
  categoryLabel,
  countLowStock,
  formatQuantity,
  groupByCategory,
  inventoryExpiryText,
  isLowStock,
  type InventoryItem,
} from './inventory-utils';

const base: InventoryItem = {
  id: 1,
  user_id: 1,
  profile_id: null,
  name: '牛奶',
  category: 'food',
  quantity: 3,
  unit: '盒',
  low_stock_threshold: 2,
  purchased_at: null,
  expires_at: null,
  location: '冰箱',
  notes: null,
  reminder_config: null,
  is_active: true,
  created_at: null,
  updated_at: null,
};

function item(overrides: Partial<InventoryItem>): InventoryItem {
  return { ...base, ...overrides };
}

describe('isLowStock', () => {
  it('is true at or below the threshold and false above it', () => {
    expect(isLowStock(item({ quantity: 3, low_stock_threshold: 2 }))).toBe(false);
    expect(isLowStock(item({ quantity: 2, low_stock_threshold: 2 }))).toBe(true);
    expect(isLowStock(item({ quantity: 1, low_stock_threshold: 2 }))).toBe(true);
  });

  it('never treats a null threshold as low stock', () => {
    expect(isLowStock(item({ quantity: 0, low_stock_threshold: null }))).toBe(false);
  });

  it('proof: an inverted comparison would MISS the low-stock item', () => {
    // If the badge logic were `quantity >= threshold`, this low item would render
    // 3 >= 2 = true (wrong)… the real predicate is `<=`, so we pin the correct
    // direction here — inverting the operator flips these two expectations.
    const above = item({ quantity: 3, low_stock_threshold: 2 });
    const below = item({ quantity: 2, low_stock_threshold: 2 });
    const inverted = (i: InventoryItem) => i.quantity >= (i.low_stock_threshold ?? Infinity);
    expect(isLowStock(above)).toBe(false);
    expect(inverted(above)).toBe(true);
    expect(isLowStock(below)).toBe(true);
  });

  it('ignores non-finite numbers instead of producing NaN comparisons', () => {
    expect(isLowStock(item({ quantity: Number.NaN, low_stock_threshold: 2 }))).toBe(false);
    expect(isLowStock(item({ quantity: 2, low_stock_threshold: Number.NaN }))).toBe(false);
  });
});

describe('inventoryExpiryText', () => {
  const now = new Date(2026, 0, 1, 12, 0, 0);

  it('renders 无保质期 for a null expiry and never NaN/Invalid Date', () => {
    const text = inventoryExpiryText(null, now);
    expect(text).toEqual({ kind: 'none', text: '无保质期' });
    expect(text.text).not.toContain('NaN');
    expect(text.text).not.toContain('Invalid');
  });

  it('renders 无保质期 for garbage input (malformed wire data)', () => {
    for (const bad of ['', 'not-a-date', '2026-13-40', '2026-02-31']) {
      const text = inventoryExpiryText(bad, now);
      expect(text.kind).toBe('none');
      expect(text.text).toBe('无保质期');
    }
  });

  it('renders a real countdown for a future expiry', () => {
    const text = inventoryExpiryText('2026-01-22', now);
    expect(text.kind).toBe('future');
    expect(text.text).toBe('还有 20 天');
  });
});

describe('formatQuantity', () => {
  it('formats integers and decimals with the unit', () => {
    expect(formatQuantity(3, '盒')).toBe('3 盒');
    expect(formatQuantity(0.5, 'kg')).toBe('0.5 kg');
  });

  it('falls back to the em dash for non-finite values', () => {
    expect(formatQuantity(Number.NaN, '盒')).toBe('—');
    expect(formatQuantity(null, null)).toBe('—');
  });
});

describe('categoryLabel / groupByCategory / countLowStock', () => {
  it('labels known categories and falls back for unknown ones', () => {
    expect(categoryLabel('food')).toBe('食品');
    expect(categoryLabel('medicine')).toBe('药品');
    expect(categoryLabel('weird')).toBe('weird');
    expect(categoryLabel(null)).toBe('其它');
  });

  it('groups items in the canonical order and folds unknown categories into other', () => {
    const groups = groupByCategory([
      item({ id: 1, category: 'supply' }),
      item({ id: 2, category: 'food' }),
      item({ id: 3, category: 'weird' }),
    ]);
    expect(groups.map((g) => g.category)).toEqual(['food', 'supply', 'other']);
    expect(groups.find((g) => g.category === 'other')?.items.map((i) => i.id)).toEqual([3]);
  });

  it('counts only rows at or below their threshold', () => {
    expect(
      countLowStock([
        item({ id: 1, quantity: 1, low_stock_threshold: 2 }),
        item({ id: 2, quantity: 5, low_stock_threshold: 2 }),
        item({ id: 3, quantity: 0, low_stock_threshold: null }),
      ]),
    ).toBe(1);
  });
});
