import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Cake, Cpu, Database, Download, Loader2, Send, Sparkles, Square } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { probeDeviceCapability, isLocalChatCapable } from '@/lib/local-ai/device';
import { chatWebLlm, isTierWeightReady, unloadEngines } from '@/lib/local-ai/engine';
import { buildKbIndex } from '@/lib/local-ai/kb';
import { answerQuestion, type RagAnswer } from '@/lib/local-ai/rag';
import {
  WEBLLM_MODELS,
  WEBLLM_TIER_IDS,
  WEBLLM_TIER_STORAGE_KEY,
  formatWeightsMB,
  type WebLlmTierId,
} from '@/lib/local-ai/models';
import { clearChatHistory, loadChatHistory, saveChatHistory } from '@/lib/local-ai/chat-history-db';

type HistoryEntry = {
  question: string;
  answer: string;
  sources: RagAnswer['sources'];
  mode: RagAnswer['mode'];
  at: number;
};

/** 快捷指令（v2.26 E）：一键把常用问法填进输入框，回车即问。 */
const QUICK_PROMPTS: string[] = [
  '我最近有什么重要的事？',
  '下个月有哪些提醒？',
  '快过期的物品和证件有哪些？',
  '帮我总结一下我的联系人',
];

function loadStoredTier(): WebLlmTierId {
  try {
    const v = localStorage.getItem(WEBLLM_TIER_STORAGE_KEY) as WebLlmTierId | null;
    if (v && v in WEBLLM_MODELS) return v;
  } catch { /* 隐私模式忽略 */ }
  return 'phone';
}

/**
 * 本地 AI（实验）：模型跑在浏览器 WebGPU（三档：内置 0.5B 秒开 / 在线获取
 * Qwen3-1.7B 中文档 / Hermes-3 无审查档），知识库 = 用户自己的事件/文档/联系人
 * （向量索引存 IndexedDB，哈希增量构建）。数据全程不出本机。
 */
export function LocalAI() {
  const navigate = useNavigate();

  const [device, setDevice] = useState<'checking' | 'ok' | 'unsupported'>('checking');
  const [tier, setTier] = useState<WebLlmTierId>(loadStoredTier);
  const [bundledReady, setBundledReady] = useState<boolean | null>(null);
  const [modelStatus, setModelStatus] = useState('');
  const [modelProgress, setModelProgress] = useState<number | null>(null);

  const [indexStatus, setIndexStatus] = useState('');
  const [indexProgress, setIndexProgress] = useState<number | null>(null);
  const [indexBuilding, setIndexBuilding] = useState(false);
  const [indexSummary, setIndexSummary] = useState('');

  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const historyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void (async () => {
      const cap = await probeDeviceCapability();
      setDevice(isLocalChatCapable(cap) ? 'ok' : 'unsupported');
      if (isLocalChatCapable(cap)) {
        setBundledReady(await isTierWeightReady(WEBLLM_MODELS.phone).catch(() => false));
      }
      // v2.26 E：恢复上次会话（IndexedDB），刷新/重进不丢对话
      const saved = await loadChatHistory().catch(() => []);
      setHistory(saved.map((e) => ({ question: e.question, answer: e.answer, sources: e.sources, mode: e.mode, at: e.at })));
    })();
    return () => {
      abortRef.current?.abort();
      // 离开页面释放 WebGPU 显存；IndexedDB 缓存仍在，下次秒级重载
      void unloadEngines();
    };
  }, []);

  // 会话快照持久化：history 一变就整包写回（低频操作，上限 100 条裁剪在库层做）
  useEffect(() => {
    if (history.length === 0) return;
    void saveChatHistory(history).catch(() => undefined);
  }, [history]);

  const handleClearHistory = useCallback(async () => {
    if (!confirm('清空本地对话记录？')) return;
    await clearChatHistory().catch(() => undefined);
    setHistory([]);
  }, []);

  const handleTierChange = useCallback((next: WebLlmTierId) => {
    setTier(next);
    try {
      localStorage.setItem(WEBLLM_TIER_STORAGE_KEY, next);
    } catch { /* 隐私模式忽略 */ }
  }, []);

  useEffect(() => {
    // 修复：scrollIntoView 会滚动所有可滚祖先（整页），导致发消息后页面跳走、
    // 对话区无法正常上下滑。改为只滚对话容器自身。
    const container = historyRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [history]);

  const handleBuildIndex = useCallback(async () => {
    setIndexBuilding(true);
    setIndexSummary('');
    setIndexProgress(0);
    try {
      const r = await buildKbIndex((msg, p) => {
        setIndexStatus(msg);
        if (typeof p === 'number') setIndexProgress(p);
      });
      setIndexSummary(`新建 ${r.built} · 跳过 ${r.skipped} · 失败 ${r.failed} · 共 ${r.total} 条`);
    } catch (err) {
      setIndexSummary(err instanceof Error ? err.message : '索引构建失败');
    } finally {
      setIndexBuilding(false);
      setIndexProgress(null);
    }
  }, []);

  const handleAsk = useCallback(async () => {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setQuestion('');
    abortRef.current = new AbortController();
    setHistory((prev) => [...prev, { question: q, answer: '…', sources: [], mode: 'local-ai', at: Date.now() }]);
    try {
      const result = await answerQuestion(q, {
        tier,
        signal: abortRef.current.signal,
        onStatus: (msg, p) => {
          setModelStatus(msg);
          setModelProgress(typeof p === 'number' ? p : null);
        },
        onToken: (partial) => {
          setHistory((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last) next[next.length - 1] = { ...last, answer: partial };
            return next;
          });
        },
      });
      setHistory((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last) next[next.length - 1] = { ...last, question: q, answer: result.answer, sources: result.sources, mode: result.mode };
        return next;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : '生成失败';
      setHistory((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last) next[next.length - 1] = { ...last, answer: `失败：${message}`, sources: [], mode: 'no-engine' };
        return next;
      });
    } finally {
      setBusy(false);
      abortRef.current = null;
      setModelProgress(null);
      setModelStatus('');
    }
  }, [question, busy, tier]);

  return (
    <div className="min-h-screen pb-24">
      <header className="sticky top-6 z-40 px-4 max-w-4xl mx-auto">
        <div className="glass-panel rounded-full px-6 py-3.5 flex justify-between items-center ring-1 ring-black/5 dark:ring-white/10 shadow-xs">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" className="rounded-full" onClick={() => navigate(-1)} aria-label="返回">
              <ArrowLeft size={20} />
            </Button>
            <div>
              <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">本地 AI（实验）</h1>
              <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">模型跑在浏览器 · 数据不出本机</p>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 mt-6 space-y-5">
        {/* 设备与权重状态 */}
        <section className="glass-panel rounded-[2rem] p-6 ring-1 ring-black/5 dark:ring-white/10">
          <h2 className="text-base font-semibold flex items-center gap-2 mb-3">
            <Cpu size={18} className="text-violet-500" /> 运行环境与模型档位
          </h2>
          {device === 'checking' && <p className="text-sm text-slate-500">正在探测 WebGPU 能力…</p>}
          {device === 'unsupported' && (
            <div className="rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
              当前浏览器不支持 WebGPU（或缺少 shader-f16）。本地对话需要 Chrome/Edge 113+ 且显卡支持
              f16 shader；仍可使用下方的知识库检索（关键词/向量匹配），但不生成本地回答。
            </div>
          )}
          {device === 'ok' && (
            <>
              <ul className="text-sm text-slate-600 dark:text-slate-300 space-y-1.5 mb-3">
                <li>✅ WebGPU + shader-f16 就绪</li>
                <li>
                  {bundledReady === null && '检查内置权重…'}
                  {bundledReady === true && '✅ 轻快档（0.5B）已随站点直发，秒开'}
                  {bundledReady === false && '❌ 内置权重不可达：部署时需包含 frontend/public/models/mlc-ai/'}
                </li>
              </ul>
              <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="模型档位">
                {WEBLLM_TIER_IDS.map((id) => {
                  const m = WEBLLM_MODELS[id];
                  const active = tier === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => handleTierChange(id)}
                      className={`text-left rounded-2xl border px-4 py-3 transition-colors ${active ? 'border-violet-400 dark:border-violet-600 bg-violet-50 dark:bg-violet-900/30' : 'border-slate-200 dark:border-slate-700 hover:border-violet-300'}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-slate-800 dark:text-slate-200">{m.label}</span>
                        {m.source === 'remote' && <Download size={13} className="text-slate-400 shrink-0" />}
                      </div>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">{m.description}</p>
                      <p className="text-[11px] text-slate-400 mt-1">{formatWeightsMB(m.weightsBytes)} · {m.source === 'bundled' ? '内置' : '首次点击下载'}</p>
                    </button>
                  );
                })}
              </div>
            </>
          )}
          {(modelProgress !== null || modelStatus) && (
            <div className="mt-3">
              {modelProgress !== null && (
                <div className="h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden mb-1.5">
                  <div className="h-full rounded-full bg-violet-500 transition-all" style={{ width: `${Math.max(Math.round(modelProgress * 100), 2)}%` }} />
                </div>
              )}
              <p className="text-xs text-slate-400">{modelStatus}</p>
            </div>
          )}
        </section>

        {/* 知识库索引 */}
        <section className="glass-panel rounded-[2rem] p-6 ring-1 ring-black/5 dark:ring-white/10">
          <h2 className="text-base font-semibold flex items-center gap-2 mb-3">
            <Database size={18} className="text-emerald-500" /> 知识库索引
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 mb-3">
            把你的事件与文档在本浏览器内向量化（MiniLM，384 维，存 IndexedDB）。内容没变的条目自动跳过——
            第一次要跑一阵子，之后同一浏览器秒级完成。
          </p>
          <Button variant="secondary" size="sm" className="rounded-full" onClick={handleBuildIndex} disabled={indexBuilding}>
            {indexBuilding ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : <Sparkles size={14} className="mr-1.5" />}
            {indexBuilding ? '构建中…' : '构建 / 增量刷新索引'}
          </Button>
          {(indexProgress !== null || indexStatus) && (
            <div className="mt-3">
              {indexProgress !== null && (
                <div className="h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden mb-1.5">
                  <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${Math.max(Math.round(indexProgress), 2)}%` }} />
                </div>
              )}
              <p className="text-xs text-slate-400">{indexStatus}</p>
            </div>
          )}
          {indexSummary && <p className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">{indexSummary}</p>}
        </section>

        {/* 对话 */}
        <section className="glass-panel rounded-[2rem] p-6 ring-1 ring-black/5 dark:ring-white/10">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold flex items-center gap-2">
              <Sparkles size={18} className="text-blue-500" /> 问问你的数据
            </h2>
            {history.length > 0 && (
              <button
                type="button"
                onClick={() => void handleClearHistory()}
                className="text-xs text-slate-400 hover:text-red-500 transition"
              >
                清空对话
              </button>
            )}
          </div>
          <div
            ref={historyRef}
            className="space-y-4 max-h-[26rem] overflow-y-auto overscroll-contain mb-4"
            aria-live="polite"
          >
            {history.length === 0 && (
              <p className="text-sm text-slate-400">
                示例：「妈妈的生日是什么时候」「下个月有什么到期」「总结一下我的事件」。回答只依据你的知识库，末尾带来源编号。
              </p>
            )}
            {history.map((h, i) => (
              <div key={i} className="space-y-2">
                <div className="text-sm font-medium text-slate-800 dark:text-slate-200">{h.question}</div>
                <div className="rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-700/50 px-4 py-3 text-sm whitespace-pre-wrap text-slate-700 dark:text-slate-300">
                  {h.answer}
                  {h.sources.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-slate-200/60 dark:border-slate-700/50 flex flex-wrap gap-1.5">
                      {h.sources.map((s) => (
                        <span key={s.id} className="text-[11px] px-2 py-0.5 rounded-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-500" title={s.snippet}>
                          {s.title}
                        </span>
                      ))}
                    </div>
                  )}
                  {h.mode === 'retrieval-only' && (
                    <p className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400">（仅检索结果——本机对话模型不可用）</p>
                  )}
                </div>
              </div>
            ))}
          </div>
          {/* v2.26 E：快捷指令——一键填入常用问法 */}
          {history.length === 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {QUICK_PROMPTS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setQuestion(p)}
                  className="text-xs px-3 py-1.5 rounded-full border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
                >
                  {p}
                </button>
              ))}
            </div>
          )}
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void handleAsk();
            }}
          >
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder={device === 'ok' ? '问点关于你自己的事…' : '检索你的知识库（对话模型不可用）'}
              className="flex-1 h-11 px-4 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm"
              aria-label="问题"
            />
            {busy ? (
              <Button type="button" variant="outline" size="icon" className="rounded-xl min-h-11 min-w-11" onClick={() => abortRef.current?.abort()} aria-label="停止生成">
                <Square size={16} />
              </Button>
            ) : (
              <Button type="submit" variant="vision" size="icon" className="rounded-xl min-h-11 min-w-11" disabled={!question.trim()} aria-label="发送">
                <Send size={16} />
              </Button>
            )}
          </form>
        </section>

        {/* v2.25: 本地 AI 祝福草稿——选联系人，本地模型生成，数据不出本机 */}
        <GreetingDraftTool device={device} tier={tier} onStatus={(msg, p) => { setModelStatus(msg); setModelProgress(typeof p === 'number' ? p : null); }} onDone={() => { setModelProgress(null); setModelStatus(''); }} />
      </main>
    </div>
  );
}

/** 祝福草稿工具：联系人下拉 + 附加语气 → 本地 WebGPU 生成 → 复制 */
function GreetingDraftTool({
  device,
  tier,
  onStatus,
  onDone,
}: {
  device: 'checking' | 'ok' | 'unsupported';
  tier: WebLlmTierId;
  onStatus: (msg: string, progress?: number) => void;
  onDone: () => void;
}) {
  const [contacts, setContacts] = useState<Array<{ id: number; name: string; relationship?: string | null; notes?: string | null }>>([]);
  const [contactId, setContactId] = useState<string>('');
  const [tone, setTone] = useState('');
  const [draft, setDraft] = useState('');
  const [gifts, setGifts] = useState('');
  const [busy, setBusy] = useState(false);
  const [giftBusy, setGiftBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    api.get<Array<{ id: number; name: string; relationship?: string | null; notes?: string | null }>>('/contacts')
      .then((list) => setContacts(list ?? []))
      .catch(() => undefined);
  }, []);

  const generate = async () => {
    const contact = contacts.find((c) => String(c.id) === contactId);
    if (!contact || busy) return;
    setBusy(true);
    setDraft('');
    abortRef.current = new AbortController();
    try {
      const relationBits = [
        contact.relationship ? `与机主关系：${contact.relationship}。` : '',
        contact.notes?.trim() ? `机主备注：${contact.notes.trim().slice(0, 120)}。` : '',
        tone.trim() ? `语气要求：${tone.trim()}。` : '',
      ].filter(Boolean).join('');
      const messages = [
        {
          role: 'system' as const,
          content: '你是机主的私人助手，为机主的好友写一条生日祝福。60-120 字中文，温暖自然像朋友写的；直接输出正文，不要标题、不要签名、不要解释。',
        },
        { role: 'user' as const, content: `给好友「${contact.name}」写生日祝福。${relationBits}` },
      ];
      const text = await chatWebLlm(messages, { tier, maxTokens: 400, onStatus, signal: abortRef.current.signal });
      setDraft(text);
    } catch (err) {
      setDraft(`生成失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setBusy(false);
      abortRef.current = null;
      onDone();
    }
  };

  // v2.26 F：礼物建议——同样走本地模型，按关系/备注给 3-4 个带价位的点子
  const suggestGifts = async () => {
    const contact = contacts.find((c) => String(c.id) === contactId);
    if (!contact || giftBusy) return;
    setGiftBusy(true);
    setGifts('');
    abortRef.current = new AbortController();
    try {
      const relationBits = [
        contact.relationship ? `与机主关系：${contact.relationship}。` : '',
        contact.notes?.trim() ? `机主备注：${contact.notes.trim().slice(0, 120)}。` : '',
      ].filter(Boolean).join('');
      const messages = [
        {
          role: 'system' as const,
          content: '你是机主的私人礼物顾问。根据关系与备注，给 3-4 个生日礼物建议，每个一行：礼物 + 一句话理由 + 大概价位（人民币）。不要开场白和总结。',
        },
        { role: 'user' as const, content: `给好友「${contact.name}」挑生日礼物。${relationBits}` },
      ];
      const text = await chatWebLlm(messages, { tier, maxTokens: 350, onStatus, signal: abortRef.current.signal });
      setGifts(text);
    } catch (err) {
      setGifts(`生成失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setGiftBusy(false);
      abortRef.current = null;
      onDone();
    }
  };

  if (device !== 'ok' || contacts.length === 0) return null;
  return (
    <section className="glass-panel rounded-[2rem] p-6 ring-1 ring-black/5 dark:ring-white/10">
      <h2 className="text-base font-semibold flex items-center gap-2 mb-3">
        <Cake size={18} className="text-pink-500" /> 写祝福（本地生成）
      </h2>
      <div className="grid gap-2 sm:grid-cols-2 mb-2">
        <select
          value={contactId}
          onChange={(e) => setContactId(e.target.value)}
          className="h-11 px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm"
          aria-label="选择联系人"
        >
          <option value="">选择联系人…</option>
          {contacts.map((c) => (
            <option key={c.id} value={String(c.id)}>{c.name}{c.relationship ? `（${c.relationship}）` : ''}</option>
          ))}
        </select>
        <input
          value={tone}
          onChange={(e) => setTone(e.target.value)}
          placeholder="语气要求（可选，如：幽默一点）"
          className="h-11 px-4 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm"
          aria-label="语气要求"
        />
      </div>
      {draft && (
        <div className="rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-700/50 px-4 py-3 text-sm whitespace-pre-wrap text-slate-700 dark:text-slate-300 mb-2">
          {draft}
        </div>
      )}
      {gifts && (
        <div className="rounded-xl bg-pink-50/60 dark:bg-pink-950/30 border border-pink-200/60 dark:border-pink-800/50 px-4 py-3 text-sm whitespace-pre-wrap text-pink-800 dark:text-pink-200 mb-2">
          {gifts}
        </div>
      )}
      <div className="flex gap-2 flex-wrap">
        <Button variant="secondary" size="sm" className="rounded-full" onClick={() => void generate()} disabled={!contactId || busy || giftBusy}>
          {busy ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : <Sparkles size={14} className="mr-1.5" />}
          {busy ? '生成中…' : '生成祝福'}
        </Button>
        {/* v2.26 F：礼物建议（本地生成） */}
        <Button variant="outline" size="sm" className="rounded-full" onClick={() => void suggestGifts()} disabled={!contactId || busy || giftBusy}>
          {giftBusy ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : <Cake size={14} className="mr-1.5" />}
          {giftBusy ? '生成中…' : '礼物建议'}
        </Button>
        {draft && (
          <Button
            variant="outline"
            size="sm"
            className="rounded-full"
            onClick={() => void navigator.clipboard.writeText(draft).catch(() => undefined)}
          >
            复制
          </Button>
        )}
      </div>
      <p className="text-xs text-slate-400 mt-2">生成在你浏览器的 GPU 上完成，内容不出本机。要直接发给联系人请用「联系人」页或设置里的祝福草稿流程。</p>
    </section>
  );
}

export default LocalAI;
