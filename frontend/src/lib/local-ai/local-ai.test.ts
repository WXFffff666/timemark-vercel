import { describe, expect, it } from 'vitest';
import { contactDocText, documentDocText, eventDocText, keywordScore } from './kb';
import { formatSourceBlock, buildRagMessages } from './rag';
import { vectorCosine, sliceForEmbedding } from './embeddings';
import { hashText } from './idb';
import { isLocalChatCapable } from './device';
import { WEBLLM_MODELS, modelWeightsBaseUrl, sameOriginKernelUrl, webLlmModelBaseUrl } from './models';

describe('local-ai kb document builders', () => {
  it('eventDocText joins name/type/date/person/custom message', () => {
    const text = eventDocText({
      name: '妈妈生日',
      type: 'birthday',
      date: '2026-10-15',
      personName: '妈妈',
      reminderConfig: { customMessage: '记得订蛋糕' },
    });
    expect(text).toContain('事件：妈妈生日');
    expect(text).toContain('类型：birthday');
    expect(text).toContain('日期：2026-10-15');
    expect(text).toContain('相关人：妈妈');
    expect(text).toContain('备注：记得订蛋糕');
  });

  it('eventDocText omits empty optional fields', () => {
    const text = eventDocText({ name: '交报告', type: 'deadline', date: '2026-11-01' });
    expect(text).not.toContain('相关人');
    expect(text).not.toContain('备注');
  });

  it('contactDocText joins name/nickname/relationship/notes', () => {
    const text = contactDocText({ name: '王阿姨', nickname: '老王', relationship: '邻居', notes: '每周三电话' });
    expect(text).toContain('联系人：王阿姨');
    expect(text).toContain('昵称：老王');
    expect(text).toContain('关系：邻居');
    expect(text).toContain('备注：每周三电话');
  });

  it('documentDocText joins title/kind/owner/expiry/notes', () => {
    const text = documentDocText({
      title: '护照',
      kind: 'id',
      owner_name: '我',
      expiry_date: '2030-01-01',
      notes: '放在抽屉',
    });
    expect(text).toContain('文档：护照');
    expect(text).toContain('到期：2030-01-01');
  });
});

describe('local-ai keyword fallback scoring', () => {
  const doc = { id: 'event:1', kind: 'event' as const, title: '妈妈生日', text: '事件：妈妈生日\n类型：birthday\n日期：2026-10-15' };

  it('scores title hits higher than body hits', () => {
    expect(keywordScore('妈妈', doc)).toBe(2);
    expect(keywordScore('birthday', doc)).toBe(1);
  });

  it('averages over terms and returns 0 for no match / empty query', () => {
    expect(keywordScore('妈妈 birthday', doc)).toBeCloseTo(1.5);
    expect(keywordScore('不存在的词', doc)).toBe(0);
    expect(keywordScore('   ', doc)).toBe(0);
  });
});

describe('local-ai vector math', () => {
  it('vectorCosine: identical = 1, orthogonal = 0, mismatched length = 0', () => {
    expect(vectorCosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(vectorCosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(vectorCosine([1, 0], [1, 0, 0])).toBe(0);
    expect(vectorCosine([], [1])).toBe(0);
  });

  it('sliceForEmbedding collapses whitespace and truncates', () => {
    expect(sliceForEmbedding('a  \n b')).toBe('a b');
    expect(sliceForEmbedding('x'.repeat(3000), 2000)).toHaveLength(2000);
  });
});

describe('local-ai rag prompt', () => {
  const hits = [
    { doc: { id: 'event:1', kind: 'event' as const, title: '妈妈生日', text: '事件：妈妈生日 日期：2026-10-15' }, score: 0.8 },
  ];

  it('formatSourceBlock numbers entries and truncates snippets', () => {
    const block = formatSourceBlock(hits, 20);
    expect(block).toContain('[1] 妈妈生日');
    expect(block.length).toBeLessThan(120);
  });

  it('formatSourceBlock explains when nothing was found', () => {
    expect(formatSourceBlock([])).toContain('没有找到');
  });

  it('buildRagMessages puts sources in system prompt and question in user turn', () => {
    const messages = buildRagMessages('妈妈生日是什么时候', hits);
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toContain('<知识库>');
    expect(messages[0]!.content).toContain('妈妈生日');
    expect(messages[1]!).toEqual({ role: 'user', content: '妈妈生日是什么时候' });
  });

  it('buildRagMessages injects the last 3 turns as context (追问可答)', () => {
    const history = [
      { question: '最早一轮不该出现', answer: '被裁掉' },
      { question: '我最近有什么重要的事？', answer: '有妈妈生日和护照续期。' },
      { question: '还有呢？', answer: '还有燃气费要交。' },
      { question: '保险呢？', answer: '车险 11 月到期。' },
    ];
    const messages = buildRagMessages('它呢？', hits, 150, history);
    // system + 3 轮（6 条）+ 当前问题
    expect(messages).toHaveLength(8);
    expect(messages[1]).toEqual({ role: 'user', content: '我最近有什么重要的事？' });
    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: '它呢？' });
    const all = messages.map((m) => m.content).join('\n');
    expect(all).not.toContain('最早一轮不该出现');
    expect(all).toContain('车险 11 月到期');
  });

  it('system prompt bans markdown output', () => {
    const messages = buildRagMessages('x', hits);
    expect(messages[0]!.content).toContain('禁止任何 Markdown');
  });
});

describe('local-ai idb hash', () => {
  it('hashText is stable and content-sensitive', () => {
    expect(hashText('a', 'b')).toBe(hashText('a', 'b'));
    expect(hashText('a', 'b')).not.toBe(hashText('ab'));
    expect(hashText('a')).not.toBe(hashText('b'));
  });
});

describe('local-ai device gate', () => {
  it('requires webgpu + adapter + shader-f16 together', () => {
    expect(isLocalChatCapable({ webgpu: true, adapterOk: true, shaderF16: true })).toBe(true);
    expect(isLocalChatCapable({ webgpu: true, adapterOk: true, shaderF16: false })).toBe(false);
    expect(isLocalChatCapable({ webgpu: false, adapterOk: false, shaderF16: false })).toBe(false);
  });
});

describe('local-ai model contract', () => {
  it('phone tier: weights byte total counts only .bin shards, 8 shards under GitHub 100MB limit', () => {
    const phone = WEBLLM_MODELS.phone;
    expect(phone.source).toBe('bundled');
    expect(phone.weightsBytes).toBe(277996288);
    expect(phone.files.filter((f) => f.file.endsWith('.bin')).length).toBe(8);
    // GitHub 100MB 硬限：入库档任何分片都不得超
    for (const f of phone.files) expect(f.bytes).toBeLessThanOrEqual(100 * 1024 * 1024);
  });

  it('remote tiers declare real sha256 contracts and stay out of the bundle', () => {
    for (const tier of ['chinese', 'uncensored'] as const) {
      const model = WEBLLM_MODELS[tier];
      expect(model.source).toBe('remote');
      expect(model.remoteBaseUrl).toMatch(/^https:\/\/hf-mirror\.com\/.+\/resolve\/main\/$/);
      const shards = model.files.filter((f) => f.file.endsWith('.bin'));
      expect(shards.length).toBeGreaterThan(0);
      for (const f of shards) expect(f.sha256, `${tier} ${f.file}`).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('base URLs follow the HF resolve/main mirror layout', () => {
    expect(webLlmModelBaseUrl()).toMatch(/\/models\/$/);
    expect(modelWeightsBaseUrl(WEBLLM_MODELS.phone)).toContain('/resolve/main/');
    expect(sameOriginKernelUrl(WEBLLM_MODELS.uncensored)).toMatch(/^http:\/\/localhost:\d+\/models\/.+\.wasm$/);
  });
});
