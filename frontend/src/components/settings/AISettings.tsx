import { useEffect, useState } from 'react';
import { Bot, Cpu } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  fetchAiStatus,
  runAiConnectionTest,
  type AiConnectionTestView,
  type AiProviderName,
  type AiProviderStatusView,
  type AiStatusView,
} from '@/lib/api';

/**
 * checkbox 107: pick an AI provider (cloud primary / cloud fallback / local
 * Ollama or LM Studio), prefill a model + base URL, and run a one-shot
 * "测试连接". Visual language mirrors the neighbouring Settings sections
 * (glass-panel, rounded-[2.5rem], ui Input/Select/Button).
 */

const PROVIDERS: ReadonlyArray<{ value: AiProviderName; label: string }> = [
  { value: 'primary', label: '云端主用（AI_BASE_URL）' },
  { value: 'fallback', label: '云端备用（AI_FALLBACK_*）' },
  { value: 'local', label: '本地模型（Ollama / LM Studio）' },
];

/** Dev-time default documented in docs/AI.md; local needs no API key. */
const LOCAL_DEFAULT_BASE_URL = 'http://localhost:11434/v1';

function isAiStatus(value: unknown): value is AiStatusView {
  return !!value && typeof value === 'object' && typeof (value as AiStatusView).enabled === 'boolean';
}

function slotOf(status: AiStatusView | null, provider: AiProviderName): AiProviderStatusView | null {
  if (!status) return null;
  return status[provider] ?? null;
}

export function AISettings() {
  const [status, setStatus] = useState<AiStatusView | null>(null);
  const [loading, setLoading] = useState(true);
  const [provider, setProvider] = useState<AiProviderName>('local');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState(LOCAL_DEFAULT_BASE_URL);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<AiConnectionTestView | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    fetchAiStatus()
      .then((data) => {
        if (cancelled || !isAiStatus(data)) return;
        setStatus(data);
        if (data.provider) setProvider(data.provider);
      })
      .catch(() => {
        // Degrade quietly: an unreachable/absent status endpoint never blocks Settings.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Prefill the fields from whichever provider is selected.
  useEffect(() => {
    const slot = slotOf(status, provider);
    setModel(slot?.model ?? '');
    setBaseUrl(provider === 'local' ? LOCAL_DEFAULT_BASE_URL : '');
  }, [provider, status]);

  async function handleTest() {
    setTesting(true);
    setTestError(null);
    setResult(null);
    try {
      setResult(await runAiConnectionTest(provider));
    } catch (error) {
      setTestError(error instanceof Error ? error.message : '测试失败');
    } finally {
      setTesting(false);
    }
  }

  const activeProvider = status?.provider ?? null;
  const activeSlot = activeProvider ? slotOf(status, activeProvider) : null;
  const reachability =
    activeSlot?.reachable === false ? '（不可达）' : activeSlot?.reachable === true ? '（可达）' : '';
  const activeLabel = activeProvider
    ? PROVIDERS.find((entry) => entry.value === activeProvider)?.label ?? activeProvider
    : null;

  return (
    <section>
      <h2 className="text-sm font-bold text-slate-500 dark:text-slate-400 mb-3 px-4 uppercase tracking-wider flex items-center gap-2">
        <Bot className="w-4 h-4" /> AI 助手（本地 / 云端）
      </h2>
      <div className="glass-panel rounded-[2.5rem] p-6 space-y-4 ring-1 ring-black/5 dark:ring-white/10">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          选择供应商，填入模型名与 Base URL（本地模型可编辑；云端地址与密钥由服务器环境变量决定）。
          「测试连接」只会发送一条极短的 ping。本地模型需运行在服务器可访问的地址上。
        </p>

        {/* v79: 浏览器端本地 AI（模仿知屋 WebLLM 方案）——不走服务器，数据不出本机 */}
        <div className="flex items-center justify-between rounded-2xl border border-violet-200 dark:border-violet-800/50 bg-violet-50/50 dark:bg-violet-900/20 px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-violet-700 dark:text-violet-300">浏览器本地推理（实验）</p>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Qwen2.5-0.5B 跑在浏览器 WebGPU，检索你自己的事件/文档作答——零云端调用，数据不出本机
            </p>
          </div>
          <Button variant="outline" size="sm" className="rounded-full shrink-0" onClick={() => navigate('/local-ai')}>
            <Cpu size={14} className="mr-1.5" /> 打开
          </Button>
        </div>

        <p className="text-xs text-slate-500 dark:text-slate-400" role="status">
          {loading
            ? '正在检测 AI 供应商…'
            : activeProvider
              ? `当前生效：${activeLabel}${reachability}`
              : '未配置任何 AI 供应商（不影响其他功能）'}
        </p>

        <div>
          <label className="text-xs font-semibold text-slate-500 mb-1 block">供应商</label>
          <Select
            value={provider}
            onChange={(e) => setProvider(e.target.value as AiProviderName)}
            aria-label="AI 供应商"
          >
            {PROVIDERS.map((entry) => {
              const configured = slotOf(status, entry.value)?.configured ?? false;
              return (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                  {configured ? '' : '（未配置）'}
                </option>
              );
            })}
          </Select>
        </div>

        <div>
          <label className="text-xs font-semibold text-slate-500 mb-1 block">模型</label>
          <Input
            placeholder={provider === 'local' ? 'qwen3:8b' : 'provider-model'}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            aria-label="AI 模型"
          />
        </div>

        <div>
          <label className="text-xs font-semibold text-slate-500 mb-1 block">Base URL</label>
          <Input
            placeholder={provider === 'local' ? LOCAL_DEFAULT_BASE_URL : '由服务器环境变量配置'}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            aria-label="AI Base URL"
          />
          <p className="text-xs text-slate-400 mt-1">
            {provider === 'local'
              ? 'Ollama 默认 http://localhost:11434/v1；LM Studio 通常为 http://localhost:1234/v1。Vercel 部署无法访问你本机的 localhost。'
              : `仅显示主机名（${slotOf(status, provider)?.host ?? '未配置'}），完整地址与密钥留在服务器环境变量中。`}
          </p>
          {provider === 'local' && (
            <pre className="mt-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white/60 dark:bg-black/20 p-3 text-xs font-mono overflow-x-auto">
              {`OLLAMA_BASE_URL=${baseUrl || LOCAL_DEFAULT_BASE_URL}\nOLLAMA_MODEL=${model || '<模型名>'}`}
            </pre>
          )}
        </div>

        <Button onClick={handleTest} disabled={testing} className="w-full" data-testid="ai-test-connection">
          {testing ? '测试中...' : '测试连接'}
        </Button>

        {testError && (
          <p className="text-sm text-red-500" role="status">
            测试失败：{testError}
          </p>
        )}
        {result &&
          (result.ok ? (
            <p className="text-sm text-emerald-600 dark:text-emerald-400" role="status">
              连接成功（{result.provider} · {result.model} · {result.latencyMs}ms）
            </p>
          ) : (
            <p className="text-sm text-red-500" role="status">
              连接失败：{result.error?.message ?? '未知错误'}
              {result.error ? `（${result.error.code}）` : ''}
            </p>
          ))}
      </div>
    </section>
  );
}
