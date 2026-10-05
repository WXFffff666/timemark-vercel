/**
 * 检索增强问答（RAG）：知识库 top-k 命中拼进系统提示 → 本地 WebLLM 生成回答，
 * 回答必须基于来源（防 0.5B 小模型幻觉）。模型不可用/不支持 WebGPU 时返回
 * 明确的降级说明 + 命中片段，绝不假装智能。
 */
import { chatWebLlm, isWebLlmSupported, type WebLlmChatMessage } from './engine';
import { searchKb, type KbHit } from './kb';

export type RagAnswer = {
  answer: string;
  sources: Array<{ id: string; title: string; snippet: string }>;
  mode: 'local-ai' | 'retrieval-only' | 'no-engine';
};

/** 来源 → 引用块（纯函数，便于单测；控制每条 snippet 长度防上下文爆炸） */
export function formatSourceBlock(hits: KbHit[], maxSnippetChars = 160): string {
  if (hits.length === 0) return '（知识库中没有找到相关条目）';
  return hits
    .map((h, i) => {
      const snippet = h.doc.text.replace(/\s+/g, ' ').slice(0, maxSnippetChars);
      return `[${i + 1}] ${h.doc.title}\n${snippet}`;
    })
    .join('\n\n');
}

const SYSTEM_PROMPT = [
  '你是 TimeMark 的本地助手，运行在用户浏览器里，只回答关于用户自己的事件、文档和提醒的问题。',
  '规则：',
  '1. 只依据 <知识库> 里的内容回答；知识库没有的信息就明确说"知识库里没有找到"。',
  '2. 回答末尾用 [编号] 标注用到的来源。',
  '3. 简洁中文回答，不超过 150 字。',
].join('\n');

/** 组装 RAG 消息（纯函数，便于单测） */
export function buildRagMessages(question: string, hits: KbHit[]): WebLlmChatMessage[] {
  const block = formatSourceBlock(hits);
  return [
    { role: 'system', content: `${SYSTEM_PROMPT}\n\n<知识库>\n${block}\n</知识库>` },
    { role: 'user', content: question },
  ];
}

function hitToSource(h: KbHit): RagAnswer['sources'][number] {
  return {
    id: h.doc.id,
    title: h.doc.title,
    snippet: h.doc.text.replace(/\s+/g, ' ').slice(0, 120),
  };
}

/**
 * 回答一个关于个人数据的问题。
 * - WebGPU 可用：检索 → 本地模型生成（流式 onToken）。
 * - 模型不可用：返回命中片段原文（retrieval-only），不调用云端。
 */
export async function answerQuestion(
  question: string,
  opts: {
    onToken?: (partial: string) => void;
    onStatus?: (msg: string, progress?: number) => void;
    signal?: AbortSignal;
  } = {},
): Promise<RagAnswer> {
  const { hits, mode: searchMode } = await searchKb(question, 6);
  const sources = hits.map(hitToSource);

  const supported = await isWebLlmSupported().catch(() => false);
  if (!supported) {
    const lines = hits.length
      ? `本机不支持 WebGPU 对话，以下是知识库检索结果：\n\n${formatSourceBlock(hits)}`
      : '本机不支持 WebGPU 对话，且知识库里没有找到相关条目。';
    return { answer: lines, sources, mode: 'retrieval-only' };
  }

  try {
    const messages = buildRagMessages(question, hits);
    const answer = await chatWebLlm(messages, {
      onToken: opts.onToken,
      onStatus: opts.onStatus,
      signal: opts.signal,
      maxTokens: 400,
    });
    if (!answer) {
      return {
        answer: `（本机模型没有产出内容）检索模式：${searchMode === 'vector' ? '语义' : '关键词'}。命中：\n\n${formatSourceBlock(hits)}`,
        sources,
        mode: 'retrieval-only',
      };
    }
    return { answer, sources, mode: 'local-ai' };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      answer: `本机模型生成失败（${reason.slice(0, 120)}）。检索命中：\n\n${formatSourceBlock(hits)}`,
      sources,
      mode: 'retrieval-only',
    };
  }
}
