import { describe, expect, it } from 'vitest';
import {
  buildNaturalReminderText,
  buildReminderSubject,
  buildReminderEmailBodies,
  composeDualCalendarDate,
  formatLunarDateLabel,
  formatLunarMonthDay,
} from '@timemark/shared';

/**
 * 公历默认模板的「捕获基线」——checkbox 169 之前的确切输出。
 * 逐字节相等即是双历改动没有污染公历路径的回归护栏。
 */
const GREG_SUBJECT = '周年纪念';
const GREG_TEXT = '提醒你一下：周年纪念，2026-10-05。\n永远幸福';
const GREG_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.6;color:#222">
<p style="margin:0;white-space:pre-wrap">提醒你一下：周年纪念，2026-10-05。\n永远幸福</p>
</body>
</html>`;

describe('email-compose natural reminders', () => {
  it('uses conversational subject without brand name', () => {
    expect(buildReminderSubject('妈妈生日', 'birthday', '2026-05-10')).not.toMatch(/TimeMark/i);
    expect(buildReminderSubject('期末考试', 'exam', '2026-05-10')).toMatch(/别忘了|明天|今天/);
  });

  it('prefers custom message as plain body', () => {
    const text = buildNaturalReminderText({
      name: '妈妈生日',
      date: '2026-05-10',
      type: 'birthday',
      customMessage: '记得给妈打个电话。',
      blessing: '🎂 生日快乐',
    });
    expect(text).toContain('记得给妈打个电话');
    expect(text).not.toMatch(/TimeMark/i);
  });

  it('generates minimal html without marketing footer', () => {
    const { html, text } = buildReminderEmailBodies({
      name: '周报截止',
      date: '2026-05-12',
      type: 'other',
      blessing: '加油',
    });
    expect(text).toContain('周报截止');
    expect(html).not.toContain('TimeMark');
    expect(html).not.toContain('box-shadow');
  });
});

describe('email-compose dual calendar (checkbox 169)', () => {
  it('renders BOTH the Gregorian and the lunar date for a both-calendar default reminder', () => {
    const subject = buildReminderSubject('妈妈生日', 'birthday', '2026-10-05', '农历八月十五', 'both');
    expect(subject).toContain('2026-10-05');
    expect(subject).toContain('农历八月十五');

    const { text, html } = buildReminderEmailBodies({
      name: '妈妈生日',
      date: '2026-10-05',
      type: 'birthday',
      lunarDate: '农历八月十五',
      calendarType: 'both',
      blessing: '生日快乐',
    });
    expect(text).toContain('2026-10-05（农历八月十五）');
    expect(html).toContain('2026-10-05（农历八月十五）');
  });

  it('keeps a Gregorian-only default reminder byte-identical to before', () => {
    expect(buildReminderSubject('周年纪念', 'anniversary', '2026-10-05')).toBe(GREG_SUBJECT);
    const { html, text } = buildReminderEmailBodies({
      name: '周年纪念',
      date: '2026-10-05',
      type: 'anniversary',
      blessing: '永远幸福',
    });
    expect(text).toBe(GREG_TEXT);
    expect(html).toBe(GREG_HTML);
  });

  it('never merges the lunar slot into a Gregorian event, even if a label is passed', () => {
    // 负向护栏：日历类型为公历时，即使误传 lunarDate 也绝不并入。
    expect(buildReminderSubject('周年纪念', 'anniversary', '2026-10-05', '农历八月十五', 'gregorian')).toBe(GREG_SUBJECT);
    const { text, html } = buildReminderEmailBodies({
      name: '周年纪念',
      date: '2026-10-05',
      type: 'anniversary',
      blessing: '永远幸福',
      lunarDate: '农历八月十五',
      calendarType: 'gregorian',
    });
    expect(text).toBe(GREG_TEXT);
    expect(html).toBe(GREG_HTML);
  });

  it('formats a leap month encoded as a negative month', () => {
    expect(formatLunarDateLabel({ year: 2025, month: -2, day: 1, isLeap: false })).toBe('农历闰二月初一');
    expect(formatLunarDateLabel({ year: 2025, month: 2, day: 1, isLeap: true })).toBe('农历闰二月初一');
    expect(formatLunarDateLabel('{"year":2025,"month":-2,"day":1}')).toBe('农历闰二月初一');
    expect(formatLunarDateLabel({ year: 2025, month: 8, day: 15 })).toBe('农历八月十五');
    expect(formatLunarMonthDay({ year: 2025, month: 8, day: 15 })).toBe('八月十五');
  });

  it('degrades gracefully when a lunar/both event has no lunar_date', () => {
    const withoutLunar = buildReminderEmailBodies({
      name: '中秋',
      date: '2026-09-25',
      type: 'holiday',
      calendarType: 'lunar',
    });
    const gregorian = buildReminderEmailBodies({ name: '中秋', date: '2026-09-25', type: 'holiday' });
    expect(withoutLunar.text).toBe(gregorian.text);
    expect(withoutLunar.text).not.toContain('农历');
    expect(withoutLunar.html).toBe(gregorian.html);
  });

  it('rejects missing/malformed persisted lunar values without guessing', () => {
    expect(formatLunarDateLabel(undefined)).toBe('');
    expect(formatLunarDateLabel(null)).toBe('');
    expect(formatLunarDateLabel('')).toBe('');
    expect(formatLunarDateLabel('not-json')).toBe('');
    expect(formatLunarDateLabel({ month: 13, day: 1 })).toBe('');
    expect(formatLunarDateLabel({ month: 0, day: 1 })).toBe('');
    expect(formatLunarDateLabel({ month: 8, day: 31 })).toBe('');
  });

  it('composeDualCalendarDate merges only for lunar/both and only with a label', () => {
    expect(composeDualCalendarDate('2026-10-05', '农历八月十五', 'both')).toBe('2026-10-05（农历八月十五）');
    expect(composeDualCalendarDate('2026-10-05', '农历八月十五', 'lunar')).toBe('2026-10-05（农历八月十五）');
    expect(composeDualCalendarDate('2026-10-05', '农历八月十五', 'gregorian')).toBe('2026-10-05');
    expect(composeDualCalendarDate('2026-10-05', undefined, 'both')).toBe('2026-10-05');
    expect(composeDualCalendarDate('2026-10-05', '', 'both')).toBe('2026-10-05');
  });
});

