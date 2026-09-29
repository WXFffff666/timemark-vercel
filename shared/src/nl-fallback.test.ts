import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  parseWithRegex,
  parsedOperationSchema,
  type NlParseContext,
} from './nl-fallback.js';

/**
 * Checkbox 99 - deterministic regex layer. It must parse ONLY the five simplest forms and
 * return null (→ the caller asks a clarifying question) for anything carrying a richer
 * modality marker. `now` is injected so every assertion is deterministic.
 */
const CTX: NlParseContext = { now: new Date('2026-09-29T01:00:00Z'), timezone: 'Asia/Shanghai' };

describe('parseWithRegex (checkbox 99 regex layer)', () => {
  it('parses `标题 @ 8月15日`', () => {
    expect(parseWithRegex('买牛奶 @ 8月15日', CTX)).toEqual({
      kind: 'create_event',
      title: '买牛奶',
      date: '2026-08-15',
      lunar: null,
      recurrence: null,
      leadDays: null,
      channels: [],
      confidence: 0.9,
    });
  });

  it('parses `in 3 days`', () => {
    expect(parseWithRegex('开会 in 3 days', CTX)).toEqual({
      kind: 'create_event',
      title: '开会',
      date: '2026-10-02',
      lunar: null,
      recurrence: null,
      leadDays: null,
      channels: [],
      confidence: 0.9,
    });
  });

  it('parses `每周一` as a weekly recurrence starting next Monday', () => {
    expect(parseWithRegex('开会 每周一', CTX)).toEqual({
      kind: 'create_event',
      title: '开会',
      date: '2026-10-05',
      lunar: null,
      recurrence: { frequency: 'weekly', interval: 1 },
      leadDays: null,
      channels: [],
      confidence: 0.9,
    });
  });

  it('parses `明天买菜`', () => {
    expect(parseWithRegex('明天买菜', CTX)).toEqual({
      kind: 'create_event',
      title: '买菜',
      date: '2026-09-30',
      lunar: null,
      recurrence: null,
      leadDays: null,
      channels: [],
      confidence: 0.9,
    });
  });

  it('parses `2026-10-05 交报告`', () => {
    expect(parseWithRegex('2026-10-05 交报告', CTX)).toEqual({
      kind: 'create_event',
      title: '交报告',
      date: '2026-10-05',
      lunar: null,
      recurrence: null,
      leadDays: null,
      channels: [],
      confidence: 0.9,
    });
  });

  it('parses `3天后交房租`', () => {
    expect(parseWithRegex('3天后交房租', CTX)).toEqual({
      kind: 'create_event',
      title: '交房租',
      date: '2026-10-02',
      lunar: null,
      recurrence: null,
      leadDays: null,
      channels: [],
      confidence: 0.9,
    });
  });

  it.each([
    '下周三给妈妈过农历八月十五生日',
    '每年10月1日提前30天提醒续费域名',
    '今天吃了半片药',
    '记一下昨天和 Ann 吃了饭',
    '完成买牛奶',
    '帮我查一下下周三有哪些安排',
  ])('refuses to guess the richer utterance %s', (utterance) => {
    expect(parseWithRegex(utterance, CTX)).toBeNull();
  });

  it('returns null when there is no date, recurrence or title', () => {
    expect(parseWithRegex('', CTX)).toBeNull();
    expect(parseWithRegex('随便写点什么', CTX)).toBeNull();
  });

  it('the schema validates the regex output and rejects an unknown kind', () => {
    expect(parsedOperationSchema.safeParse(parseWithRegex('明天买菜', CTX)).success).toBe(true);
    expect(parsedOperationSchema.safeParse({ kind: 'nope', confidence: 1 }).success).toBe(false);
    expect(DEFAULT_CONFIDENCE_THRESHOLD).toBe(0.5);
  });
});
