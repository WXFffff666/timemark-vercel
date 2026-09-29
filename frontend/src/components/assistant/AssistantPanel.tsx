import { useMemo, useState } from 'react';
import { Check, ChevronDown, Send, ShieldAlert, Sparkles, Wrench, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { ASSISTANT_QUICK_PROMPTS } from '@/lib/assistant-intent';
import type {
  AssistantConfirmation,
  AssistantController,
  AssistantMessage,
  AssistantTranscript,
} from '@/hooks/useAssistant';

function formatJson(value: unknown): string {
  if (value === undefined) return '{}';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const STATUS_LABEL: Record<AssistantTranscript['status'], string> = {
  pending: '调用中…',
  executed: '已执行',
  confirm_required: '待确认',
  failed: '失败',
};

/** checkbox 109: the destructive/confirm-required card. Renders the backend preview verbatim. */
function ConfirmationCard({
  confirmation,
  onConfirm,
  onCancel,
}: {
  confirmation: AssistantConfirmation;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { preview, state, error } = confirmation;
  const settled = state === 'done' || state === 'cancelled' || state === 'failed';

  return (
    <div
      data-testid="assistant-confirmation"
      role="group"
      aria-label="确认执行"
      className="mt-3 rounded-2xl border border-amber-300 bg-amber-50/80 p-4 dark:border-amber-500/40 dark:bg-amber-500/10"
    >
      <div className="flex items-center gap-2">
        <Badge variant="destructive" className="gap-1">
          <ShieldAlert size={12} aria-hidden /> 需要确认
        </Badge>
        <span data-testid="assistant-confirmation-tool" className="font-mono text-sm font-bold text-slate-900 dark:text-white">
          {preview.tool}
        </span>
      </div>

      {/* The preview is already redacted + human-readable by design: shown exactly as received. */}
      <p data-testid="assistant-confirmation-description" className="mt-2 text-sm text-slate-700 dark:text-slate-200">
        {preview.description}
      </p>
      <pre
        data-testid="assistant-confirmation-preview"
        className="mt-2 overflow-x-auto rounded-xl bg-white/70 p-3 text-xs text-slate-700 dark:bg-black/30 dark:text-slate-200"
      >
        {formatJson(preview.args)}
      </pre>
      {preview.expiresAt && (
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          有效期至 {new Date(preview.expiresAt).toLocaleString('zh-CN')}
        </p>
      )}

      {settled ? (
        state === 'done' ? (
          <p data-testid="assistant-confirmation-done" className="mt-3 text-sm font-semibold text-emerald-600 dark:text-emerald-400">
            已确认并执行
          </p>
        ) : state === 'cancelled' ? (
          <p data-testid="assistant-confirmation-cancelled" className="mt-3 text-sm font-semibold text-slate-500">
            已取消（未执行）
          </p>
        ) : (
          <p data-testid="assistant-confirmation-error" role="alert" className="mt-3 text-sm font-semibold text-red-600 dark:text-red-400">
            {error}
          </p>
        )
      ) : (
        <div className="mt-3 flex gap-2">
          <Button
            type="button"
            variant="destructive"
            data-testid="assistant-confirm"
            onClick={onConfirm}
            disabled={state === 'busy'}
          >
            <Check size={16} aria-hidden /> {state === 'busy' ? '执行中…' : '确认'}
          </Button>
          <Button
            type="button"
            variant="outline"
            data-testid="assistant-cancel"
            onClick={onCancel}
            disabled={state === 'busy'}
          >
            <X size={16} aria-hidden /> 取消
          </Button>
        </div>
      )}
    </div>
  );
}

function TranscriptBlock({ transcript }: { transcript: AssistantTranscript }) {
  return (
    <div
      data-testid="assistant-transcript"
      className="mt-2 rounded-2xl border border-slate-200 bg-white/60 p-3 dark:border-white/10 dark:bg-black/20"
    >
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
        <Wrench size={13} aria-hidden /> 工具调用
        <Badge
          variant={
            transcript.status === 'executed'
              ? 'success'
              : transcript.status === 'failed'
                ? 'destructive'
                : transcript.status === 'confirm_required'
                  ? 'default'
                  : 'secondary'
          }
        >
          {STATUS_LABEL[transcript.status]}
        </Badge>
      </div>
      <div className="mt-2 text-xs">
        <span className="text-slate-500 dark:text-slate-400">工具：</span>
        <span data-testid="assistant-tool-name" className="font-mono font-bold text-slate-900 dark:text-white">
          {transcript.tool}
        </span>
      </div>
      <div className="mt-1 text-xs">
        <span className="text-slate-500 dark:text-slate-400">参数：</span>
        <pre data-testid="assistant-tool-args" className="mt-1 overflow-x-auto text-xs text-slate-700 dark:text-slate-200">
          {formatJson(transcript.args)}
        </pre>
      </div>
      {transcript.status === 'executed' && (
        <div className="mt-1 text-xs">
          <span className="text-slate-500 dark:text-slate-400">结果：</span>
          <pre data-testid="assistant-tool-result" className="mt-1 overflow-x-auto text-xs text-slate-700 dark:text-slate-200">
            {formatJson(transcript.result)}
          </pre>
        </div>
      )}
      {transcript.status === 'failed' && transcript.error && (
        <p data-testid="assistant-tool-error" role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
          {transcript.error}
        </p>
      )}
    </div>
  );
}

function MessageRow({
  message,
  assistant,
}: {
  message: AssistantMessage;
  assistant: AssistantController;
}) {
  const isUser = message.role === 'user';
  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')} data-role={message.role}>
      <div className={cn('max-w-[92%]', isUser ? 'text-right' : 'text-left')}>
        <div
          data-testid={isUser ? 'assistant-message-user' : 'assistant-message-assistant'}
          className={cn(
            'inline-block rounded-2xl px-4 py-2 text-sm',
            isUser
              ? 'bg-primary-500 text-white'
              : 'bg-slate-100 text-slate-800 dark:bg-white/10 dark:text-slate-100',
          )}
        >
          {message.text}
        </div>
        {message.transcript && <TranscriptBlock transcript={message.transcript} />}
        {message.confirmation && (
          <ConfirmationCard
            confirmation={message.confirmation}
            onConfirm={() => assistant.confirm(message.id)}
            onCancel={() => assistant.cancel(message.id)}
          />
        )}
      </div>
    </div>
  );
}

/** Manual fallback form: pick a registry tool and pass explicit JSON args. Never auto-runs. */
function ManualToolForm({ assistant }: { assistant: AssistantController }) {
  const [tool, setTool] = useState('');
  const [argsText, setArgsText] = useState('{}');
  const [error, setError] = useState('');

  const run = () => {
    setError('');
    let parsed: unknown;
    try {
      parsed = argsText.trim() ? JSON.parse(argsText) : {};
    } catch {
      setError('参数必须是合法 JSON。');
      return;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setError('参数必须是一个 JSON 对象。');
      return;
    }
    if (!tool) {
      setError('请先选择工具。');
      return;
    }
    void assistant.invokeManual(tool, parsed as Record<string, unknown>);
  };

  return (
    <details className="mt-3 rounded-2xl border border-slate-200 bg-white/50 p-3 dark:border-white/10 dark:bg-black/20">
      <summary className="cursor-pointer text-xs font-semibold text-slate-600 dark:text-slate-300">
        手动调用工具（解析失败时的兜底）
      </summary>
      <div className="mt-2 space-y-2">
        <label className="block text-xs text-slate-500" htmlFor="assistant-manual-tool">
          工具
        </label>
        <select
          id="assistant-manual-tool"
          data-testid="assistant-manual-tool"
          value={tool}
          onChange={(e) => setTool(e.target.value)}
          className="h-10 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
        >
          <option value="">请选择…</option>
          {assistant.tools.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name}
              {t.requiresConfirmation ? '（需确认）' : ''}
            </option>
          ))}
        </select>
        <label className="block text-xs text-slate-500" htmlFor="assistant-manual-args">
          参数（JSON）
        </label>
        <textarea
          id="assistant-manual-args"
          data-testid="assistant-manual-args"
          value={argsText}
          onChange={(e) => setArgsText(e.target.value)}
          rows={3}
          className="w-full rounded-xl border border-slate-300 bg-white p-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
        />
        {error && (
          <p data-testid="assistant-manual-error" role="alert" className="text-xs text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        <Button type="button" variant="outline" size="sm" data-testid="assistant-manual-run" onClick={run}>
          调用
        </Button>
      </div>
    </details>
  );
}

export interface AssistantPanelProps {
  assistant: AssistantController;
  variant?: 'page' | 'dock';
  onClose?: () => void;
  className?: string;
}

/** checkbox 109: the shared assistant surface used by both the /assistant page and the dock. */
export function AssistantPanel({ assistant, variant = 'page', onClose, className }: AssistantPanelProps) {
  const [draft, setDraft] = useState('');
  const empty = assistant.messages.length === 0;
  const quick = useMemo(() => [...ASSISTANT_QUICK_PROMPTS], []);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    void assistant.submit(text);
  };

  return (
    <section
      data-testid="assistant-panel"
      aria-label="智能助手"
      className={cn(
        'flex flex-col gap-3 rounded-[2rem] glass-panel p-4 ring-1 ring-black/5 dark:ring-white/10',
        variant === 'dock' ? 'h-full' : 'min-h-[60vh]',
        className,
      )}
    >
      <header className="flex items-center gap-2">
        <Sparkles size={18} className="text-primary-500" aria-hidden />
        <h2 className="text-base font-bold text-slate-900 dark:text-white">智能助手</h2>
        <p className="ml-2 hidden text-xs text-slate-500 sm:block dark:text-slate-400">
          工具调用全程可见 · 破坏性操作需确认
        </p>
        {onClose && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="ml-auto rounded-full"
            aria-label="收起智能助手"
            data-testid="assistant-dock-close"
            onClick={onClose}
          >
            <X size={18} aria-hidden />
          </Button>
        )}
      </header>

      <div
        data-testid="assistant-message-list"
        role="log"
        aria-live="polite"
        aria-label="助手对话记录"
        className="flex-1 space-y-3 overflow-y-auto rounded-2xl bg-white/40 p-3 dark:bg-black/20 min-h-40"
      >
        {empty ? (
          <p className="py-6 text-center text-sm text-slate-400">
            试试下面的快捷指令，或直接说你想做什么。
          </p>
        ) : (
          assistant.messages.map((message) => (
            <MessageRow key={message.id} message={message} assistant={assistant} />
          ))
        )}
      </div>

      <div className="flex flex-wrap gap-2" data-testid="assistant-quick-prompts">
        {quick.map((prompt) => (
          <button
            key={prompt}
            type="button"
            onClick={() => void assistant.submit(prompt)}
            className="min-h-9 rounded-full border border-slate-200 bg-white/70 px-3 py-1 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary-500/20 dark:border-white/10 dark:bg-white/5 dark:text-slate-200 dark:hover:bg-white/10"
          >
            {prompt}
          </button>
        ))}
      </div>

      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <div className="flex-1">
          <label htmlFor="assistant-input" className="sr-only">
            给助手发消息
          </label>
          <Input
            id="assistant-input"
            data-testid="assistant-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="例如：明天提醒我给妈妈打电话"
            autoComplete="off"
          />
        </div>
        <Button type="submit" variant="vision" size="icon" aria-label="发送" data-testid="assistant-submit">
          <Send size={18} aria-hidden />
        </Button>
      </form>

      {variant === 'page' && <ManualToolForm assistant={assistant} />}

      <details className="text-xs text-slate-400">
        <summary className="flex cursor-pointer items-center gap-1">
          <ChevronDown size={12} aria-hidden /> 关于工具透明度
        </summary>
        <p className="mt-1">
          每次请求都会显示真实的工具名与参数；需要确认的操作在你点击「确认」之前不会执行。
        </p>
      </details>
    </section>
  );
}
