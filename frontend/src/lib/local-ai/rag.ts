/**
 * 检索增强问答（RAG）：知识库 top-k 命中拼进系统提示 → 本地 WebLLM 生成回答，
 * 回答必须基于来源（防小模型幻觉）。模型不可用/不支持 WebGPU 时返回
 * 明确的降级说明 + 命中片段，绝不假装智能。
 */
import { chatWebLlm, isWebLlmSupported, type WebLlmChatMessage } from './engine';
import { searchKb, type KbHit } from './kb';
import { WEBLLM_MODELS, type WebLlmTierId } from './models';

export type RagAnswer = {
  answer: string;
  sources: Array<{ id: string; title: string; snippet: string }>;
  mode: 'local-ai' | 'retrieval-only' | 'no-engine';
  /** 实际使用的档位（retrieval-only 时无意义） */
  tier: WebLlmTierId | null;
};

/** 档位 → 生成参数：0.5B 需要硬约束防跑飞；大模型放宽 */
export function generationParamsForTier(tier: WebLlmTierId): { maxWords: number; maxTokens: number } {
  switch (tier) {
    case 'phone':
      return { maxWords: 150, maxTokens: 400 };
    case 'chinese':
    case 'uncensored':
      return { maxWords: 300, maxTokens: 768 };
  }
}

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

/**
 * v2.35 R32（用户报告"mdx 文档"）：降级路径的自然语言回答——
 * 逐条组织成「标题：首句」的句子，不再倾倒 [1] 标题/片段结构块。
 * 纯函数，便于单测。三处降级路径（无 WebGPU / 模型空产出 / 生成失败）共用。
 */
export function composeRetrievalAnswer(hits: KbHit[], lead: string): string {
  if (hits.length === 0) return `${lead}知识库里没有找到相关内容。`;
  const sentences = hits.slice(0, 4).map((hit) => {
    const text = hit.doc.text.replace(/\s+/g, ' ').trim();
    const first = text.split(/(?<=[。！？.!?])/)[0]?.slice(0, 80) ?? text.slice(0, 80);
    return `· ${hit.doc.title}：${first}`;
  });
  return `${lead}帮你查了知识库，找到 ${hits.length} 条相关内容：\n${sentences.join('\n')}`;
}

const SYSTEM_PROMPT = [
  '你是 TimeMark 的本地助手，运行在用户浏览器里，只回答关于用户自己的事件、文档和联系人信息的问题。',
  '规则：',
  '1. 只依据 <知识库> 里的内容回答；知识库没有的信息就明确说"知识库里没有找到"。',
  '2. 回答末尾用 [编号] 标注用到的来源。',
  '3. 简洁中文回答，不超过 {maxWords} 字。',
  '4. 直接输出自然的中文短句，像说话一样回答；禁止任何 Markdown 记号——不要 #、*、-、`、表格和代码块。',
  '5. 对话历史里的问答只是上下文，回答只针对最后一问。',
].join('\n');

/** 最近几轮问答（追问上下文用）；答案截断防上下文爆炸 */
export interface RagHistoryTurn {
  question: string;
  answer: string;
}

/** 组装 RAG 消息（纯函数，便于单测）；history 为最近几轮问答，按时间正序 */
export function buildRagMessages(question: string, hits: KbHit[], maxWords = 150, history: RagHistoryTurn[] = []): WebLlmChatMessage[] {
  const block = formatSourceBlock(hits);
  const messages: WebLlmChatMessage[] = [
    { role: 'system', content: `${SYSTEM_PROMPT.replace('{maxWords}', String(maxWords))}\n\n<知识库>\n${block}\n</知识库>` },
  ];
  for (const turn of history.slice(-3)) {
    const q = turn.question.trim();
    const a = turn.answer.trim().slice(0, 400);
    if (q) messages.push({ role: 'user', content: q });
    if (a) messages.push({ role: 'assistant', content: a });
  }
  messages.push({ role: 'user', content: question });
  return messages;
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
    tier?: WebLlmTierId;
    /** 最近几轮问答（追问上下文，正序）；只带最近 3 轮 */
    history?: RagHistoryTurn[];
    onToken?: (partial: string) => void;
    onStatus?: (msg: string, progress?: number) => void;
    signal?: AbortSignal;
  } = {},
): Promise<RagAnswer> {
  const tier: WebLlmTierId = opts.tier && opts.tier in WEBLLM_MODELS ? opts.tier : 'phone';
  const { maxWords, maxTokens } = generationParamsForTier(tier);
  const { hits, mode: searchMode } = await searchKb(question, 6);
  const sources = hits.map(hitToSource);

  const supported = await isWebLlmSupported().catch(() => false);
  if (!supported) {
    // v2.35 R32（用户报告"mdx 文档"）：无 WebGPU 时的回答改为自然语言——
    // 逐条组织成句子（标题+首句），不再倾倒 [1] 标题/片段结构块。
    return {
      answer: composeRetrievalAnswer(hits, '本机暂不支持 AI 对话，'),
      sources,
      mode: 'retrieval-only',
      tier: null,
    };
  }

  try {
    const messages = buildRagMessages(question, hits, maxWords, opts.history ?? []);
    const answer = await chatWebLlm(messages, {
      tier,
      onToken: opts.onToken,
      onStatus: opts.onStatus,
      signal: opts.signal,
      maxTokens,
    });
    if (!answer) {
      return {
        answer: composeRetrievalAnswer(hits, '本机模型这次没有产出内容，'),
        sources,
        mode: 'retrieval-only',
        tier,
      };
    }
    return { answer, sources, mode: 'local-ai', tier };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      answer: composeRetrievalAnswer(hits, `本机模型生成失败（${reason.slice(0, 80)}），`),
      sources,
      mode: 'retrieval-only',
      tier,
    };
  }
}
