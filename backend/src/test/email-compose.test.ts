import { describe, expect, it } from 'vitest';
import {
  buildNaturalReminderText,
  buildReminderSubject,
  buildReminderEmailBodies,
} from '@timemark/shared';

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
