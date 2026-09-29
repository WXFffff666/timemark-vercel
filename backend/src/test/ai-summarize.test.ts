import { describe, expect, it, vi } from 'vitest';

/**
 * Checkbox 108 — opt-in summarisation / tagging / translation.
 *
 * The provider is ALWAYS injected so no test performs a real request. The cache proof
 * uses the REAL gateway (checkbox 98) with an injected fetch, so "exactly one upstream
 * call across two renders" exercises the shipped sha256-keyed cache, not a re-mock.
 *
 * Acceptance map:
 *   numeral guard   - real number accepted, fabricated number rejected (both directions)
 *   (a) narrative   - fabricated total rejected -> deterministic digest, no `999`
 *   (b) tagging     - suggestion object with `accepted:false`, never applied
 *   (c) translation - placeholders preserved, invented number rejected
 *   cache           - two renders, ONE upstream call
 *   degradation     - disabled / provider error -> deterministic result, never throws
 */

import {
  AiDisabledError,
  createAiGateway,
  type AiChatResult,
  type AiGateway,
} from '../services/ai/gateway.js';
import {
  digestFacts,
  extractNumerals,
  isDigestNarrativeEnabled,
  isEventTaggingEnabled,
  isTemplateTranslationEnabled,
  numeralsGrounded,
  suggestEventTags,
  summarizeDigestNarrative,
  translatePresetTemplate,
  translateTemplate,
  type SummarizerAi,
} from '../services/ai/summarize.js';
import { renderDigestHtml, type DigestData } from '../services/digest.service.js';

function digestData(overrides: Partial<DigestData> = {}): DigestData {
  const base: DigestData = {
    userId: 1,
    period: 'monthly',
    from: '2026-09-01',
    to: '2026-09-30',
    today: '2026-10-01',
    upcoming: [{ id: 1, name: '妈妈生日', type: 'birthday', date: '2026-10-05' }],
    overdue: [{ kind: 'expiry', title: '域名续费', due: '2026-09-20', daysOverdue: 11 }],
    spend: { from: '2026-09-01', to: '2026-09-30', byCurrency: { CNY: 1000 }, onceByCurrency: {}, onceCount: 0, byKind: [] },
    habits: [{ name: '晨跑', logged: 3, target: 6, rate: 50 }],
    medications: {
      taken: 2,
      skipped: 1,
      missed: 0,
      total: 3,
      percentage: 67,
      perMedication: [{ name: '布洛芬', taken: 2, skipped: 1, missed: 0, total: 3, percentage: 67 }],
    },
    maintenance: [],
    goals: [],
    isEmpty: false,
  };
  return { ...base, ...overrides };
}

function stubAi(content: string): { ai: SummarizerAi; chat: ReturnType<typeof vi.fn> } {
  const chat = vi.fn(
    async (): Promise<AiChatResult> => ({ content, model: 'stub', provider: 'primary', cached: false }),
  );
  return { ai: { chat }, chat };
}

function asFetch(mock: unknown): typeof fetch {
  return mock as unknown as typeof fetch;
}

function jsonResponse(payload: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) };
}

function completion(content: string) {
  return { model: 'stub-model', choices: [{ message: { role: 'assistant', content } }] };
}

const PRIMARY_ENV = { AI_BASE_URL: 'https://primary.example/v1', AI_API_KEY: 'sk-test', AI_MODEL: 'primary-model' };

function realGateway(fetchMock: unknown): AiGateway {
  return createAiGateway({ fetchImpl: asFetch(fetchMock), env: { ...PRIMARY_ENV }, random: () => 0 });
}

describe('numeral grounding guard (both directions)', () => {
  it('extracts every maximal digit-run', () => {
    expect(extractNumerals('2026-12-05 有 3 项')).toEqual(['2026', '12', '05', '3']);
    expect(extractNumerals('no digits here')).toEqual([]);
  });

  it('accepts a numeral the prompt contained (including a date fragment)', () => {
    expect(numeralsGrounded('本期共有 3 项逾期事项', '逾期事项：3')).toBe(true);
    expect(numeralsGrounded('2026-12-02 是统计首日', '统计区间：2026-12-02 至 2026-12-31')).toBe(true);
    // `12` inside `2026-12-02` is its own run and the prompt carries it.
    expect(numeralsGrounded('还有 12', '统计区间：2026-12-02 至 2026-12-31')).toBe(true);
  });

  it('normalises full-width digits and thousands separators', () => {
    expect(numeralsGrounded('合计 １２３４', '合计：1234')).toBe(true);
    expect(numeralsGrounded('合计 1,234', '合计：1234')).toBe(true);
  });

  it('rejects a fabricated numeral the prompt never contained', () => {
    expect(numeralsGrounded('本期共有 999 项逾期事项', '逾期事项：3')).toBe(false);
    // A date the prompt never carried is a fabricated numeral too.
    expect(numeralsGrounded('截至 2026-12-05', '统计区间：2026-12-02 至 2026-12-31')).toBe(false);
  });
});

describe('(a) digest narrative', () => {
  it('accepts a narrative whose only number is one of the computed facts', async () => {
    const { ai } = stubAi('本期用药记录共 3 条。');
    const result = await summarizeDigestNarrative(digestData(), { enabled: true, ai });
    expect(result.narrative).toBe('本期用药记录共 3 条。');
    expect(result.usedAi).toBe(true);
  });

  it('REJECTS a fabricated total and renders the deterministic digest (no 999)', async () => {
    const data = digestData();
    const { ai } = stubAi('本期用药记录共 999 条。');
    const { narrative, usedAi } = await summarizeDigestNarrative(data, { enabled: true, ai });

    expect(narrative).toBeNull();
    expect(usedAi).toBe(false);

    // The final output is the deterministic digest: only the REAL total survives.
    const finalHtml = renderDigestHtml(narrative ? { ...data, narrative } : data);
    expect(Buffer.from(finalHtml)).toEqual(Buffer.from(renderDigestHtml(data)));
    expect(finalHtml).not.toContain('999');
    expect(finalHtml).not.toContain('本期叙述');
    expect(finalHtml).toContain('布洛芬');
  });

  it('computes facts from the already-computed counts only', () => {
    const facts = digestFacts(digestData());
    expect(facts).toEqual([
      { key: 'upcoming', label: '未来 30 天事项', value: 1 },
      { key: 'overdue', label: '逾期事项', value: 1 },
      { key: 'once_spend', label: '一次性支出笔数', value: 0 },
      { key: 'habits', label: '习惯', value: 1 },
      { key: 'medications', label: '用药记录条数', value: 3 },
      { key: 'maintenance', label: '保养到期', value: 0 },
      { key: 'goals', label: '目标', value: 0 },
    ]);
  });

  it('is off by default: no provider call, deterministic result', async () => {
    const { ai, chat } = stubAi('本期用药记录共 3 条。');
    const result = await summarizeDigestNarrative(digestData(), { enabled: false, ai });
    expect(result).toEqual({ narrative: null, usedAi: false });
    expect(chat).not.toHaveBeenCalled();
  });

  it('degrades silently when the provider is disabled (never throws)', async () => {
    const ai: SummarizerAi = {
      chat: async () => {
        throw new AiDisabledError();
      },
    };
    await expect(summarizeDigestNarrative(digestData(), { enabled: true, ai })).resolves.toEqual({
      narrative: null,
      usedAi: false,
    });
  });

  it('serves the narrative from the gateway cache: two renders, exactly ONE upstream call', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(completion('本期用药记录共 3 条。')));
    const gateway = realGateway(fetchMock);
    const ai: SummarizerAi = { chat: (messages, options) => gateway.chat(messages, options) };
    const data = digestData();

    const first = await summarizeDigestNarrative(data, { enabled: true, ai });
    const second = await summarizeDigestNarrative(data, { enabled: true, ai });

    expect(first.narrative).toBe('本期用药记录共 3 条。');
    expect(second.narrative).toBe(first.narrative);
    expect(fetchMock).toHaveBeenCalledTimes(1); // reused the gateway's bounded cache
    // Both renders prepend the same cached narrative.
    expect(renderDigestHtml({ ...data, narrative: first.narrative ?? '' })).toContain('本期用药记录共 3 条。');
    expect(renderDigestHtml({ ...data, narrative: second.narrative ?? '' })).toContain('本期用药记录共 3 条。');
  });
});

describe('(b) event auto-tagging', () => {
  it('returns a suggestion with accepted:false and never writes', async () => {
    const { ai } = stubAi('{"category":"工作","tags":["会议","项目"]}');
    const suggestion = await suggestEventTags({ title: '季度总结会', notes: '准备材料' }, { enabled: true, ai });

    expect(suggestion.category).toBe('工作');
    expect(suggestion.tags).toEqual(['会议', '项目']);
    expect(suggestion.accepted).toBe(false);
    expect(suggestion.usedAi).toBe(true);
    // The suggestion is a plain value - this module has no write path to the event.
    expect(Object.keys(suggestion).sort()).toEqual(['accepted', 'category', 'tags', 'usedAi']);
  });

  it('is off by default: empty suggestion, accepted:false, no provider call', async () => {
    const { ai, chat } = stubAi('{"category":"工作","tags":["会议"]}');
    const suggestion = await suggestEventTags({ title: '季度总结会' }, { enabled: false, ai });
    expect(suggestion).toEqual({ category: null, tags: [], accepted: false, usedAi: false });
    expect(chat).not.toHaveBeenCalled();
  });

  it('rejects a tag list carrying an invented numeral', async () => {
    const { ai } = stubAi('{"category":"工作","tags":["2026"]}');
    const suggestion = await suggestEventTags({ title: '季度总结会' }, { enabled: true, ai });
    expect(suggestion.tags).toEqual([]);
    expect(suggestion.accepted).toBe(false);
  });

  it('degrades silently when the provider throws', async () => {
    const ai: SummarizerAi = {
      chat: async () => {
        throw new AiDisabledError();
      },
    };
    await expect(suggestEventTags({ title: 'x' }, { enabled: true, ai })).resolves.toEqual({
      category: null,
      tags: [],
      accepted: false,
      usedAi: false,
    });
  });
});

describe('(c) template translation', () => {
  const template = {
    id: 'birthday_detailed',
    content: '🎂 {{person_name}} 的生日还有 {{days_until}} 天！',
    variables: ['person_name', 'days_until'],
  };

  it('accepts a translation that keeps every placeholder and adds no number', async () => {
    const { ai } = stubAi('🎂 ¡El cumpleaños de {{person_name}} es en {{days_until}} días!');
    const result = await translateTemplate(template, '西班牙语', { enabled: true, ai });
    expect(result.usedAi).toBe(true);
    expect(result.content).toContain('{{person_name}}');
    expect(result.content).toContain('{{days_until}}');
  });

  it('rejects a translation that drops a placeholder', async () => {
    const { ai } = stubAi('🎂 ¡Feliz cumpleaños de {{person_name}}!');
    const result = await translateTemplate(template, '西班牙语', { enabled: true, ai });
    expect(result.content).toBeNull();
    expect(result.usedAi).toBe(false);
  });

  it('rejects a translation that invents a number', async () => {
    const { ai } = stubAi('🎂 El cumpleaños de {{person_name}} es en 3 días, {{days_until}}!');
    const result = await translateTemplate(template, '西班牙语', { enabled: true, ai });
    expect(result.content).toBeNull();
  });

  it('is off by default and refuses an unknown preset id', async () => {
    const { ai, chat } = stubAi('🎂 {{person_name}} {{days_until}}');
    const disabled = await translateTemplate(template, '英语', { enabled: false, ai });
    expect(disabled).toEqual({ content: null, language: '英语', usedAi: false });
    expect(chat).not.toHaveBeenCalled();

    const unknown = await translatePresetTemplate('does_not_exist', '英语', { enabled: true, ai });
    expect(unknown).toEqual({ content: null, language: '英语', usedAi: false });
    expect(chat).not.toHaveBeenCalled();
  });

  it('translates a real shared preset through the template path', async () => {
    const { ai } = stubAi('Reminder: {{event_name}} is in {{days_until}} days.');
    const result = await translatePresetTemplate('generic', 'English', { enabled: true, ai });
    expect(result.usedAi).toBe(true);
    expect(result.content).toContain('{{event_name}}');
    expect(result.content).toContain('{{days_until}}');
  });
});

describe('opt-in flags', () => {
  it('all three are OFF unless the env var is exactly "true"', () => {
    expect(isDigestNarrativeEnabled({})).toBe(false);
    expect(isEventTaggingEnabled({})).toBe(false);
    expect(isTemplateTranslationEnabled({})).toBe(false);
    expect(isDigestNarrativeEnabled({ AI_DIGEST_NARRATIVE: '1' })).toBe(false);
    expect(isDigestNarrativeEnabled({ AI_DIGEST_NARRATIVE: 'true' })).toBe(true);
    expect(isEventTaggingEnabled({ AI_EVENT_TAGGING: 'TRUE' })).toBe(true);
    expect(isTemplateTranslationEnabled({ AI_TEMPLATE_TRANSLATION: 'true' })).toBe(true);
  });
});
