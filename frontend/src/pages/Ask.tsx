import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { HelpCircle, Search, Send, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { MobileBottomNav } from '@/components/MobileBottomNav';
import { PageHeader } from '@/components/layout/PageHeader';
import { api } from '@/lib/api';

/**
 * 确定性问答（task 133）。
 *
 * - 问题 → 后端离线规则映射到已知意图 + 参数 → 真实查询 → 模板化回答；
 *   未识别的问题返回「可以问什么」的目录，绝不猜答案。
 * - 歧义时（如「这个月花了多少」没写类型）后端返回追问，这里把选项渲染成按钮，
 *   点击后带 `params` 重发同一个问题。
 * - 纯展示组件：请求全部走既有 `api` 封装（`/api/ask`），无任何 AI / 外部服务。
 */

interface AskParamInfo {
  name: string;
  description: string;
  required: boolean;
}

interface AskIntentInfo {
  id: string;
  title: string;
  description: string;
  template: string;
  examples: string[];
  params: AskParamInfo[];
}

interface AskCatalogue {
  version: number;
  intents: AskIntentInfo[];
}

interface AskOption {
  param: string;
  value: string;
  label: string;
}

interface AskAnswerResponse {
  kind: 'answer';
  intent: string;
  question: string;
  title: string;
  lines: string[];
}

interface AskClarifyResponse {
  kind: 'clarify';
  intent: string;
  question: string;
  message: string;
  options: AskOption[];
}

interface AskNotFoundResponse {
  kind: 'not-found';
  intent: string;
  question: string;
  message: string;
  available: string[];
}

interface AskCatalogueResponse {
  kind: 'catalogue';
  intent: null;
  question: string;
  message: string;
  intents: AskIntentInfo[];
}

type AskResponse = AskAnswerResponse | AskClarifyResponse | AskNotFoundResponse | AskCatalogueResponse;

function CatalogueList({
  intents,
  onPick,
}: {
  intents: AskIntentInfo[];
  onPick: (example: string) => void;
}) {
  return (
    <div className="space-y-3" data-testid="ask-catalogue">
      {intents.map((intent) => (
        <div
          key={intent.id}
          data-testid={`ask-catalogue-${intent.id}`}
          className="glass-panel rounded-2xl p-4 ring-1 ring-black/5 dark:ring-white/10"
        >
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-semibold text-slate-800 dark:text-slate-100">{intent.title}</h3>
            <Badge variant="secondary" className="text-[10px]">{intent.id}</Badge>
            {intent.params.length > 0 && (
              <span className="text-[11px] text-hint">
                参数：{intent.params.map((p) => p.name + (p.required ? '（必填）' : '')).join(' · ')}
              </span>
            )}
          </div>
          <p className="text-xs text-hint mt-1">{intent.description}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {intent.examples.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => onPick(example)}
                className="glass alive-interactive rounded-full px-3 py-1 text-xs text-primary-600 dark:text-primary-400"
              >
                {example}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function Ask() {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<AskResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [catalogue, setCatalogue] = useState<AskCatalogue | null>(null);
  const [params, setParams] = useState<Record<string, string>>({});
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<AskCatalogue>('/ask/catalogue')
      .then((data) => {
        if (!cancelled) setCatalogue(data);
      })
      .catch(() => {
        // 目录加载失败不阻塞提问：回答区照常可用。
        if (!cancelled) setCatalogue(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = useCallback(
    async (raw: string, nextParams: Record<string, string>) => {
      const q = raw.trim();
      if (q === '' || loading) return;
      setLoading(true);
      setError('');
      try {
        const data = await api.post<AskResponse>('/ask', {
          question: q,
          ...(Object.keys(nextParams).length > 0 ? { params: nextParams } : {}),
        });
        setAnswer(data);
        setParams(data.kind === 'clarify' ? nextParams : {});
      } catch (e) {
        setError(e instanceof Error ? e.message : '提问失败');
      } finally {
        setLoading(false);
      }
    },
    [loading],
  );

  const onFormSubmit = (event: FormEvent) => {
    event.preventDefault();
    setParams({});
    void submit(question, {});
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      setParams({});
      void submit(question, {});
    }
  };

  const onClarifyOption = (option: AskOption) => {
    if (!answer) return;
    const next = { ...params, [option.param]: option.value };
    setParams(next);
    void submit(answer.question, next);
  };

  const onPickExample = (example: string) => {
    setQuestion(example);
    inputRef.current?.focus();
  };

  const intentTitle = (id: string): string => {
    const fromCatalogue = catalogue?.intents.find((intent) => intent.id === id);
    if (fromCatalogue) return fromCatalogue.title;
    if (answer && answer.kind === 'catalogue') {
      const fromAnswer = answer.intents.find((intent) => intent.id === id);
      if (fromAnswer) return fromAnswer.title;
    }
    return id;
  };

  const catalogueIntents: AskIntentInfo[] =
    answer?.kind === 'catalogue' ? answer.intents : catalogue?.intents ?? [];

  return (
    <div className="min-h-screen pb-24">
      <PageHeader
        title="问答"
        subtitle="离线确定性回答 · 零外发 · 无 AI"
        back="smart"
        actions={<Sparkles size={18} className="text-primary-500 shrink-0" aria-hidden />}
      />

      <main id="main-content" className="max-w-4xl mx-auto px-4 py-6 space-y-6" tabIndex={-1}>
        <section aria-label="提问" className="glass-panel rounded-2xl p-4 ring-1 ring-black/5 dark:ring-white/10">
          <form onSubmit={onFormSubmit} className="flex items-center gap-2">
            <label className="sr-only" htmlFor="ask-question">问题</label>
            <Input
              id="ask-question"
              ref={inputRef}
              data-testid="ask-input"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={onInputKeyDown}
              placeholder="例如：这个月花了多少 / 证件30天内到期的有哪些 / 搜索 张三"
              autoComplete="off"
            />
            <Button type="submit" variant="vision" disabled={loading || question.trim() === ''} aria-label="提问" data-testid="ask-submit">
              <Send size={16} className="mr-1" aria-hidden />
              提问
            </Button>
          </form>
          <p className="text-[11px] text-hint mt-2">
            <HelpCircle size={12} className="inline-block mr-1" aria-hidden />
            识别不了的问题只会返回「可以问什么」的目录，绝不编造答案。
          </p>
        </section>

        {error && (
          <p className="text-sm text-destructive glass-panel rounded-2xl px-4 py-3" role="alert" data-testid="ask-error">
            {error}
          </p>
        )}

        <section aria-label="回答" aria-live="polite" data-testid="ask-answer">
          {loading && <p className="text-sm text-hint" role="status">查询中…</p>}
          {!loading && answer?.kind === 'answer' && (
            <div className="glass-panel rounded-2xl p-4 ring-1 ring-black/5 dark:ring-white/10">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="font-bold text-slate-800 dark:text-slate-100">{answer.title}</h2>
                <Badge variant="secondary" className="text-[10px]">{intentTitle(answer.intent)}</Badge>
              </div>
              <ul className="mt-3 space-y-1.5 text-sm text-slate-700 dark:text-slate-200">
                {answer.lines.map((line, index) => (
                  <li key={`${answer.title}-${index}`} className="leading-relaxed">{line}</li>
                ))}
              </ul>
            </div>
          )}
          {!loading && answer?.kind === 'clarify' && (
            <div className="glass-panel rounded-2xl p-4 ring-1 ring-primary-500/30" data-testid="ask-clarify">
              <h2 className="font-bold text-slate-800 dark:text-slate-100">需要确认</h2>
              <p className="text-sm text-hint mt-1">{answer.message}</p>
              {answer.options.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {answer.options.map((option) => (
                    <button
                      key={`${option.param}:${option.value}`}
                      type="button"
                      data-testid={`ask-clarify-${option.value}`}
                      onClick={() => onClarifyOption(option)}
                      className="glass alive-interactive rounded-full px-3 py-1.5 text-sm text-primary-600 dark:text-primary-400"
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {!loading && answer?.kind === 'not-found' && (
            <div className="glass-panel rounded-2xl p-4 ring-1 ring-destructive/30" data-testid="ask-not-found">
              <h2 className="font-bold text-slate-800 dark:text-slate-100">没有找到</h2>
              <p className="text-sm text-slate-700 dark:text-slate-200 mt-1">{answer.message}</p>
              {answer.available.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {answer.available.map((name) => (
                    <span key={name} className="rounded-full bg-slate-900/5 px-2.5 py-0.5 text-xs text-slate-600 dark:bg-white/10 dark:text-slate-300">
                      {name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
          {!loading && answer?.kind === 'catalogue' && (
            <div className="glass-panel rounded-2xl p-4 ring-1 ring-black/5 dark:ring-white/10" data-testid="ask-catalogue-message">
              <h2 className="font-bold text-slate-800 dark:text-slate-100">可以问什么</h2>
              <p className="text-sm text-hint mt-1">{answer.message}</p>
            </div>
          )}
        </section>

        <section aria-label="可以问什么" className="space-y-3">
          <div className="flex items-center gap-2">
            <Search size={16} className="text-hint" aria-hidden />
            <h2 className="text-sm font-bold text-hint">可以问什么</h2>
          </div>
          {catalogueIntents.length > 0 ? (
            <CatalogueList intents={catalogueIntents} onPick={onPickExample} />
          ) : (
            <p className="text-sm text-hint" role="status">目录加载中…</p>
          )}
        </section>

        <p className="text-[11px] text-hint text-center">
          <HelpCircle size={12} className="inline-block mr-1" aria-hidden />
          所有回答来自本地数据库查询与固定模板；关键词搜索走离线索引，不调用任何 AI。
        </p>
      </main>

      <MobileBottomNav />
    </div>
  );
}
