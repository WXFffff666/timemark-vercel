import { useState } from 'react';
import { Power, RotateCcw, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  isPausedGlobally,
  pauseAllRoutines,
  readPausedRoutineIds,
  resumeAllRoutines,
  type AgentRoutine,
} from '@/pages/agent-console/agent-console-api';

export interface KillSwitchProps {
  routines: AgentRoutine[];
  aiEnabled: boolean;
  workerCount: number;
  onChanged: () => void;
}

/**
 * Global kill switch.
 *
 * The deployment-level env switch (`AGENT_TOOLS_ENABLED` / `AGENT_JOBS_ENABLED`) is read-only
 * at runtime - there is no HTTP endpoint to flip it. So the console's kill switch stops the
 * PRODUCERS instead: it disables every enabled routine (no scheduler => no new agent work) and
 * remembers the exact set in localStorage so resume restores it.
 */
export function KillSwitch({ routines, aiEnabled, workerCount, onChanged }: KillSwitchProps) {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const enabledCount = routines.filter((routine) => routine.enabled).length;
  const remembered = readPausedRoutineIds();
  const paused = isPausedGlobally(routines) || (remembered.length > 0 && enabledCount === 0);

  async function pause() {
    if (!window.confirm(`确定暂停全部例行任务？将停用 ${enabledCount} 个已启用任务，后台 AI 将不再产生新的调度工作。`)) return;
    setBusy(true);
    setFeedback(null);
    try {
      const result = await pauseAllRoutines(routines);
      setFeedback({
        tone: result.failures.length > 0 ? 'err' : 'ok',
        text:
          result.failures.length > 0
            ? `已停用 ${result.changed.length} 个，另有 ${result.failures.length} 个停用失败`
            : `已停用全部 ${result.changed.length} 个例行任务`,
      });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function resume() {
    setBusy(true);
    setFeedback(null);
    try {
      const result = await resumeAllRoutines(routines);
      setFeedback({
        tone: result.failures.length > 0 ? 'err' : 'ok',
        text:
          result.failures.length > 0
            ? `已恢复 ${result.changed.length} 个，另有 ${result.failures.length} 个恢复失败`
            : `已恢复 ${result.changed.length} 个例行任务`,
      });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      data-testid="kill-switch"
      className={`glass-panel rounded-[2rem] p-6 ring-1 flex flex-col gap-3 ${
        paused ? 'ring-red-300/70 dark:ring-red-500/40' : 'ring-black/5 dark:ring-white/10'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ShieldAlert size={20} className={paused ? 'text-red-600 dark:text-red-400' : 'text-slate-500 dark:text-slate-300'} aria-hidden />
          <h2 className="text-lg font-bold tracking-tight text-slate-900 dark:text-white">全局暂停（Kill Switch）</h2>
          <Badge variant={paused ? 'destructive' : 'success'} data-testid="kill-switch-state">
            {paused ? '已暂停' : `${enabledCount} 个任务运行中`}
          </Badge>
        </div>
        {paused ? (
          <Button variant="outline" className="rounded-full border-red-300 dark:border-red-500/40" disabled={busy} onClick={() => void resume()}>
            <RotateCcw size={16} className="mr-1" aria-hidden /> {busy ? '恢复中…' : '恢复全部'}
          </Button>
        ) : (
          <Button variant="destructive" className="rounded-full" disabled={busy || enabledCount === 0} onClick={() => void pause()}>
            <Power size={16} className="mr-1" aria-hidden /> {busy ? '暂停中…' : '全部暂停'}
          </Button>
        )}
      </div>

      <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
        停用所有例行任务以冻结后台 AI 的调度。这是运行时唯一可用的「停止生产」操作。
        部署级环境开关 <code className="font-mono">AGENT_TOOLS_ENABLED</code> / <code className="font-mono">AGENT_JOBS_ENABLED</code> 只能在部署配置中修改，控制台仅做展示。
      </p>

      {!aiEnabled && (
        <p className="rounded-xl bg-sky-50/70 dark:bg-sky-500/10 px-3 py-2 text-xs text-sky-800 dark:text-sky-200 ring-1 ring-sky-200/70 dark:ring-sky-500/30">
          当前部署的 AI 供应商未启用（<code className="font-mono">provider.enabled=false</code>），
          且已知 worker {workerCount} 个。即使例行任务处于启用状态，也不会有 AI 输出产生。
        </p>
      )}

      {feedback && (
        <p className={`text-xs font-medium ${feedback.tone === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
          {feedback.text}
        </p>
      )}
    </section>
  );
}
