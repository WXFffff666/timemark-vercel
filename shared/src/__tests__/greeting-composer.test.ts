import { describe, expect, it } from 'vitest';
import {
  composeBirthdayGreeting,
  pickVariant,
  resolveGreetingName,
  relationshipLine,
} from '../greeting-composer';

describe('greeting composer (v2.25 祝福组合引擎)', () => {
  it('is deterministic: same (contactId, year) → identical output', () => {
    const input = { contactId: 7, year: '2026', name: '妈妈' };
    const a = composeBirthdayGreeting(input);
    const b = composeBirthdayGreeting(input);
    expect(a.html).toBe(b.html);
    expect(a.subject).toBe(b.subject);
    expect(a.greetingText).toBe(b.greetingText);
  });

  it('rotates across years (different year → different seed → different text, with high probability)', () => {
    const input = { contactId: 7, name: '妈妈' };
    const texts = new Set<string>();
    for (let year = 2026; year < 2046; year++) {
      texts.add(composeBirthdayGreeting({ ...input, year: String(year) }).greetingText);
    }
    // 20 年里至少 15 种不同组合（组合空间 ~3×14×3=126，碰撞容忍）
    expect(texts.size).toBeGreaterThanOrEqual(15);
  });

  it('prefers nickname over name, falls back to 朋友', () => {
    expect(resolveGreetingName({ name: '张丽', nickname: '老妈' })).toBe('老妈');
    expect(resolveGreetingName({ name: '张丽', nickname: null })).toBe('张丽');
    expect(resolveGreetingName({})).toBe('朋友');
  });

  it('pickVariant stays inside the pool and is stable', () => {
    const pool = ['a', 'b', 'c'];
    expect(pool).toContain(pickVariant(pool, 'x'));
    expect(pickVariant(pool, 'x')).toBe(pickVariant(pool, 'x'));
    expect(pickVariant([], 'x')).toBe('');
  });

  it('relationship line maps known relations and falls back generically', () => {
    expect(relationshipLine('朋友')).toContain('友谊长存');
    expect(relationshipLine('羽毛球球友')).toContain('羽毛球球友');
    expect(relationshipLine(null)).toBe('');
    expect(relationshipLine('x'.repeat(30))).toBe('');
  });

  it('embeds notes line only when notes exist', () => {
    const withNotes = composeBirthdayGreeting({ contactId: 1, year: '2026', name: '小明', notes: '每周三电话' });
    const without = composeBirthdayGreeting({ contactId: 1, year: '2026', name: '小明' });
    expect(withNotes.greetingText).toContain('一直记着');
    expect(without.greetingText).not.toContain('一直记着');
  });

  it('html includes the name, cake emoji and inline styles (no external assets)', () => {
    const g = composeBirthdayGreeting({ contactId: 3, year: '2026', name: '王阿姨' });
    expect(g.html).toContain('王阿姨');
    expect(g.html).toContain('🎂');
    expect(g.html).not.toMatch(/src=/); // 无外链图片（邮件拦截敏感）
    expect(g.subject).toContain('生日快乐');
  });
});
