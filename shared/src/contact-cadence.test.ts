import { describe, expect, it } from 'vitest';
import {
  buildCadenceSendKey,
  cadenceNextDueYmd,
  isCadenceDue,
} from './contact-cadence.js';

/**
 * checkbox 62 的纯函数契约：周期起点 + cadence_days 的到期判定与去重键。
 * 去重键必须包含周期起点 —— 若只凭联系人 id 去重，用户记录互动后的新周期
 * 将永远无法再提醒（window-reset 会被破坏）。
 */
describe('contact cadence — due arithmetic', () => {
  it('adds calendar days to the period start', () => {
    expect(cadenceNextDueYmd('2026-05-01', 30)).toBe('2026-05-31');
    expect(cadenceNextDueYmd('2026-06-15', 7)).toBe('2026-06-22');
  });

  it('crosses month and year boundaries as calendar days', () => {
    // 2026-01-31 + 30 = 2026-03-02（2026 年 2 月只有 28 天）
    expect(cadenceNextDueYmd('2026-01-31', 30)).toBe('2026-03-02');
    expect(cadenceNextDueYmd('2025-12-31', 1)).toBe('2026-01-01');
  });

  it('is due on and after the computed date, not before', () => {
    expect(isCadenceDue('2026-05-30', '2026-05-01', 30)).toBe(false);
    expect(isCadenceDue('2026-05-31', '2026-05-01', 30)).toBe(true);
    expect(isCadenceDue('2026-06-10', '2026-05-01', 30)).toBe(true);
  });

  it('rejects malformed cadence values (no due date, never due)', () => {
    expect(cadenceNextDueYmd('2026-05-01', 0)).toBeNull();
    expect(cadenceNextDueYmd('2026-05-01', -5)).toBeNull();
    expect(cadenceNextDueYmd('not-a-date', 30)).toBeNull();
    expect(isCadenceDue('2026-05-31', '2026-05-01', 0)).toBe(false);
    expect(isCadenceDue('', '2026-05-01', 30)).toBe(false);
  });
});

describe('contact cadence — dedup key', () => {
  it('contains the contact id AND the period start', () => {
    const key = buildCadenceSendKey(12, '2026-05-01');
    expect(key).toBe('contact:cadence#c12#p2026-05-01');
    expect(key).toContain('12');
    expect(key).toContain('2026-05-01');
  });

  it('changes when the period start moves (interaction resets the window)', () => {
    const before = buildCadenceSendKey(12, '2026-05-01');
    const after = buildCadenceSendKey(12, '2026-06-15');
    expect(after).not.toBe(before);
    // 同一周期内重复调用必须稳定（cron 每分钟跑也会命中同一 claim）
    expect(buildCadenceSendKey(12, '2026-05-01')).toBe(before);
  });

  it('separates contacts with the same period start', () => {
    expect(buildCadenceSendKey(1, '2026-05-01')).not.toBe(buildCadenceSendKey(2, '2026-05-01'));
  });
});
