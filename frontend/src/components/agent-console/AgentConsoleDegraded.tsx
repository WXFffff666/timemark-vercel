import { Bot, ExternalLink, WifiOff } from 'lucide-react';
import { AI_DOCS_HREF } from '@/components/ai/DegradedBanner';
import { cn } from '@/lib/utils';

/**
 * The explicit degraded state for the console.
 *
 * Rendered INSTEAD of the empty charts when the AI is disabled AND no worker is known
 * (`/api/ai/status`.enabled === false + `/api/agent/health`.worker.workers.length === 0).
 * A blank chart must never stand in for "nothing is running" - the console says WHY and
 * links the enablement docs.
 */
export interface AgentConsoleDegradedProps {
  docsHref?: string;
  workerCount: number;
  degradedReasons?: string[];
  className?: string;
}

export function AgentConsoleDegraded({
  docsHref = AI_DOCS_HREF,
  workerCount,
  degradedReasons = [],
  className,
}: AgentConsoleDegradedProps) {
  return (
    <section
      data-testid="agent-console-degraded"
      role="status"
      aria-live="polite"
      className={cn(
        'glass-panel rounded-[2.5rem] p-8 ring-1 ring-amber-300/60 dark:ring-amber-500/30',
        'bg-amber-50/70 dark:bg-amber-500/5',
        className,
      )}
    >
      <div className="flex items-start gap-4">
        <div className="h-14 w-14 shrink-0 rounded-2xl bg-amber-100 dark:bg-amber-500/15 flex items-center justify-center text-amber-600 dark:text-amber-400">
          <Bot size={28} aria-hidden />
        </div>
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-amber-900 dark:text-amber-200 tracking-tight">
            AI 后台未启用，且没有 worker 在线
          </h2>
          <p className="mt-2 text-sm text-amber-800 dark:text-amber-200/90 leading-relaxed">
            当前队列、运行历史与成本图表会保持为空 —— 这不是「一切正常」，而是后台 AI 根本没有运行。
            TimeMark 的提醒 / 待办 / 集成等核心功能不受影响，缺失的只是 AI 能力。
          </p>
          <ul className="mt-3 space-y-1.5 text-sm text-amber-800 dark:text-amber-200/90">
            <li className="flex items-center gap-2">
              <WifiOff size={15} aria-hidden /> 已知 worker：{workerCount} 个（0 = 从未上报心跳）
            </li>
            <li>未配置任何 <code className="font-mono text-xs">AI_*</code> / <code className="font-mono text-xs">OLLAMA_*</code> 变量，或在部署中设置了 <code className="font-mono text-xs">AGENT_TOOLS_ENABLED=false</code>。</li>
            {degradedReasons.length > 0 && (
              <li>最近降级原因：{degradedReasons.join('、')}</li>
            )}
          </ul>
          <div className="mt-4 flex flex-wrap gap-3">
            <a
              href={docsHref}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-full bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-700 transition-colors"
            >
              <ExternalLink size={15} aria-hidden /> 查看 docs/AI.md 启用说明
            </a>
            <a
              href="https://github.com/WXFffff666/timemark-vercel/blob/main/docs/CRON.md"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/70 px-4 py-2 text-sm font-semibold text-amber-800 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-500/10 transition-colors"
            >
              <ExternalLink size={15} aria-hidden /> 配置 worker 心跳（docs/CRON.md）
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
