import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Maximize2, Minimize2, Send, ShieldAlert, Sparkles, Wrench, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { stripMarkdownLight } from '@/lib/local-ai/text-clean';
import { ASSISTANT_QUICK_PROMPTS } from '@/lib/assistant-intent';
import type {
  AssistantConfirmation,
  AssistantController,
  AssistantMessage,
  AssistantTranscript,
} from '@/hooks/useAssistant';

/**
 * v2.35 R30（用户报告"不是自然语言"）：把工具结果转成一句人话——
 * 递归找第一个非空对象数组，取前 3 条的可读名；找不到数组就报"操作完成"。
 * 原始 JSON 折叠进 <details>，透明度不丢但不再霸屏。
 */
function summarizeResult(result: unknown): string | null {
  if (result == null || typeof result !== 'object') return null;
  const findArr = (v: unknown, depth = 0): readonly unknown[] | null => {
    if (depth > 4 || v == null || typeof v !== 'object') return null;
    if (Array.isArray(v)) return v.length > 0 ? v : null;
    for (const val of Object.values(v as Record<string, unknown>)) {
      const found = findArr(val, depth + 1);
      if (found) return found;
    }
    return null;
  };
  const arr = findArr(result);
  if (arr) {
    const names = arr.slice(0, 3).map((item) => {
      if (item == null || typeof item !== 'object') return String(item);
      const o = item as Record<string, unknown>;
      const readable = [o.name, o.title, o.label, o.summary, o.day, o.id].find(
        (candidate) => candidate !== undefined && candidate !== null && String(candidate).trim() !== '',
      );
      return String(readable ?? '?');
    });
    const more = arr.length > 3 ? ` 等（共 ${arr.length} 条）` : '';
    return `找到 ${arr.length} 条：${names.join('、')}${more}`;
  }
  return '操作完成。';
}

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
          <p data-testid="assistant-confirmation-cancelled" className="mt-3 text-sm font-semibold text-slate-500 dark:text-slate-400">
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
        {/* v2.35 R27（用户报告）：max-h 帽——大 JSON 会把输入区顶出 70vh 面板 */}
        <details className="mt-1">
          <summary className="cursor-pointer text-slate-400 hover:text-slate-600 dark:hover:text-slate-300">查看参数</summary>
          <pre data-testid="assistant-tool-args" className="mt-1 max-h-40 overflow-auto text-xs text-slate-700 dark:text-slate-200">
            {formatJson(transcript.args)}
          </pre>
        </details>
      </div>
      {transcript.status === 'executed' && (
        <div className="mt-1 text-xs">
          <span className="text-slate-500 dark:text-slate-400">结果：</span>
          {/* v2.35 R30（用户报告"mdx 格式"）：自然语言摘要一行，原始 JSON 折叠收起 */}
          <span data-testid="assistant-tool-result" className="text-slate-800 dark:text-slate-100">
            {summarizeResult(transcript.result) ?? '已完成'}
          </span>
          {transcript.result != null && typeof transcript.result === 'object' && (
            <details className="mt-1">
              <summary className="cursor-pointer text-slate-400 hover:text-slate-600 dark:hover:text-slate-300">原始数据</summary>
              <pre className="mt-1 max-h-40 overflow-auto text-[10px] leading-4 text-slate-500 dark:text-slate-400">
                {formatJson(transcript.result)}
              </pre>
            </details>
          )}
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
          {isUser ? message.text : stripMarkdownLight(message.text)}
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
        <label className="block text-xs text-slate-500 dark:text-slate-400" htmlFor="assistant-manual-tool">
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
        <label className="block text-xs text-slate-500 dark:text-slate-400" htmlFor="assistant-manual-args">
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
  /** v2.39：dock 大窗/还原切换（expanded 由 AssistantDock 持有） */
  expanded?: boolean;
  onToggleExpand?: () => void;
  className?: string;
}

/** checkbox 109: the shared assistant surface used by both the /assistant page and the dock. */
export function AssistantPanel({ assistant, variant = 'page', onClose, expanded, onToggleExpand, className }: AssistantPanelProps) {
  // v2.28：消息列表自动滚底 —— 此前完全没有滚动控制，长回答尾部在可视区外
  // v2.30：依赖加最后一条消息的文本长度——流式/长回答增长时也持续滚底。
  const listRef = useRef<HTMLDivElement | null>(null);
  const messageCount = assistant.messages.length;
  const lastTextLength = assistant.messages[messageCount - 1]?.text.length ?? 0;
  // v2.39：列表是否真的溢出（可滚）。overscroll-contain 只应在"确实在滚"的容器上：
  // 内容不满时 contain 会把整个列表区变成手势死区——列表滚不了，手势也链不到
  // 背后页面（手机上即"没办法挪动视角"的根因之一）。
  const [listScrollable, setListScrollable] = useState(false);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    if (el) setListScrollable(el.scrollHeight > el.clientHeight + 4);
  }, [messageCount, lastTextLength]);

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
        // v2.39：dock 不再是滚动容器（此前 section 和 list 双层 overflow-y-auto +
        // 双层 overscroll-contain，list 滚到边界后手势被吞、链不到 section，
        // 矮视口下面板内部溢出时输入区永远够不着 = "无法上下滑动"的根因）。
        // 现在 dock：section 只裁剪（overflow-hidden），消息 list 是唯一滚动区，
        // header/表单恒定可见；page 变体（整页）保持随页面增高。
        variant === 'dock' ? 'min-h-0 flex-1 overflow-hidden' : 'min-h-[60vh]',
        className,
      )}
    >
      <header className="flex items-center gap-2">
        <Sparkles size={18} className="text-primary-500" aria-hidden />
        <h2 className="text-base font-bold text-slate-900 dark:text-white">智能助手</h2>
        <p className="ml-2 hidden text-xs text-slate-500 sm:block dark:text-slate-400">
          工具调用全程可见 · 破坏性操作需确认
        </p>
        {/* v2.39：大窗/还原切换——用户反馈面板太小"看不全"，展开后手机近全屏、桌面 42rem */}
        {onToggleExpand && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="ml-auto rounded-full"
            aria-label={expanded ? '还原面板大小' : '放大面板'}
            data-testid="assistant-dock-expand"
            onClick={onToggleExpand}
          >
            {expanded ? <Minimize2 size={16} aria-hidden /> : <Maximize2 size={16} aria-hidden />}
          </Button>
        )}
        {onClose && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn('rounded-full', !onToggleExpand && 'ml-auto')}
            aria-label="收起智能助手"
            data-testid="assistant-dock-close"
            onClick={onClose}
          >
            <X size={18} aria-hidden />
          </Button>
        )}
      </header>

      <div
        ref={listRef}
        data-testid="assistant-message-list"
        role="log"
        aria-live="polite"
        aria-label="助手对话记录"
        // v2.35 R27：dock 列表滚到边界后不链到背后页面。
        // v2.39 两处修订：①去掉 min-h-40（与 min-h-0 twMerge 冲突，且固定下限会把
        // 面板内容顶过容器上限，重新制造"外层必须滚"的死结）；②overscroll-contain
        // 改为动态——只有列表真的溢出在滚时才 contain，内容不满时放手势穿透到页面
        // （此前不满时 contain 把列表区变成手势死区，手机上"挪不动视角"）。
        // page 变体保留 min-h-40（页面可滚，下限只是占位视觉）。
        className={cn(
          'mt-2 space-y-3 rounded-2xl bg-white/40 p-3 dark:bg-black/20',
          variant === 'dock'
            ? cn('flex-1 min-h-0 overflow-y-auto', listScrollable ? 'overscroll-contain' : 'overscroll-auto')
            : 'flex-1 min-h-0 overflow-y-auto min-h-40',
        )}
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

      {/* v2.39：dock 变体快捷指令改单行横滚——多行 wrap 在矮视口 70vh 面板里
          挤占消息区高度；page 变体保持多行 wrap */}
      <div
        className={cn('gap-2', variant === 'dock' ? 'flex flex-nowrap overflow-x-auto pb-1' : 'flex flex-wrap')}
        data-testid="assistant-quick-prompts"
      >
        {quick.map((prompt) => (
          <button
            key={prompt}
            type="button"
            onClick={() => void assistant.submit(prompt)}
            className={cn(
              'min-h-9 shrink-0 rounded-full border border-slate-200 bg-white/70 px-3 py-1 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary-500/20 dark:border-white/10 dark:bg-white/5 dark:text-slate-200 dark:hover:bg-white/10',
            )}
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
        {assistant.runningTool ? (
          /* v2.28：工具执行中提供真实停止（中止 HTTP 调用） */
          <Button
            type="button"
            variant="destructive"
            size="icon"
            aria-label="停止"
            data-testid="assistant-stop"
            onClick={(e) => {
              e.preventDefault();
              assistant.stop();
            }}
          >
            <X size={18} aria-hidden />
          </Button>
        ) : (
          <Button type="submit" variant="vision" size="icon" aria-label="发送" data-testid="assistant-submit">
            <Send size={18} aria-hidden />
          </Button>
        )}
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
