import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Cpu, Database, Loader2, Send, Sparkles, Square } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { probeDeviceCapability, isLocalChatCapable } from '@/lib/local-ai/device';
import { isWebLlmWeightReachable, resetWebLlmEngine } from '@/lib/local-ai/engine';
import { buildKbIndex } from '@/lib/local-ai/kb';
import { answerQuestion, type RagAnswer } from '@/lib/local-ai/rag';

type HistoryEntry = {
  question: string;
  answer: string;
  sources: RagAnswer['sources'];
  mode: RagAnswer['mode'];
};

/**
 * 本地 AI（实验）：模型跑在浏览器 WebGPU（知屋同款 WebLLM + Qwen2.5-0.5B），
 * 知识库 = 用户自己的事件/文档（向量索引存 IndexedDB，哈希增量构建）。
 * 数据全程不出本机——这正是它相对于云端 AI 的存在理由。
 */
export function LocalAI() {
  const navigate = useNavigate();

  const [device, setDevice] = useState<'checking' | 'ok' | 'unsupported'>('checking');
  const [weightsOk, setWeightsOk] = useState<boolean | null>(null);
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
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void (async () => {
      const cap = await probeDeviceCapability();
      setDevice(isLocalChatCapable(cap) ? 'ok' : 'unsupported');
      if (isLocalChatCapable(cap)) {
        setWeightsOk(await isWebLlmWeightReachable().catch(() => false));
      }
    })();
    return () => {
      abortRef.current?.abort();
      // 离开页面释放 WebGPU 显存；IndexedDB 缓存仍在，下次秒级重载
      resetWebLlmEngine();
    };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
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
    setHistory((prev) => [...prev, { question: q, answer: '…', sources: [], mode: 'local-ai' }]);
    try {
      const result = await answerQuestion(q, {
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
        if (last) next[next.length - 1] = { question: q, answer: result.answer, sources: result.sources, mode: result.mode };
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
  }, [question, busy]);

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
            <Cpu size={18} className="text-violet-500" /> 运行环境
          </h2>
          {device === 'checking' && <p className="text-sm text-slate-500">正在探测 WebGPU 能力…</p>}
          {device === 'unsupported' && (
            <div className="rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
              当前浏览器不支持 WebGPU（或缺少 shader-f16）。本地对话需要 Chrome/Edge 113+ 且显卡支持
              f16 shader；仍可使用下方的知识库检索（关键词/向量匹配），但不生成本地回答。
            </div>
          )}
          {device === 'ok' && (
            <ul className="text-sm text-slate-600 dark:text-slate-300 space-y-1.5">
              <li>✅ WebGPU + shader-f16 就绪（Qwen2.5-0.5B q4f16 可跑，实测 40+ tok/s）</li>
              <li>
                {weightsOk === null && '检查同源权重…'}
                {weightsOk === true && '✅ 模型权重已随站点直发（首次下载 ~278MB 后 IndexedDB 永久缓存，之后离线可用）'}
                {weightsOk === false && '❌ 权重不可达：部署时需包含 frontend/public/models/mlc-ai/'}
              </li>
              <li>对话/向量权重均来自本站同源，运行时零第三方 CDN、零云端 API 调用。</li>
            </ul>
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
          <h2 className="text-base font-semibold flex items-center gap-2 mb-3">
            <Sparkles size={18} className="text-blue-500" /> 问问你的数据
          </h2>
          <div className="space-y-4 max-h-[26rem] overflow-y-auto mb-4" aria-live="polite">
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
            <div ref={bottomRef} />
          </div>
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
      </main>
    </div>
  );
}

export default LocalAI;
