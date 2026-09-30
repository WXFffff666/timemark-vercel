import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, Bot, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAiDegradedState } from '@/hooks/useAiDegradedState';
import { DegradedBanner } from '@/components/ai/DegradedBanner';
import { useAgentConsoleData, useAgentHealth } from '@/pages/agent-console/agent-console-api';
import { AgentConsoleDegraded } from '@/components/agent-console/AgentConsoleDegraded';
import { QueueMonitor } from '@/components/agent-console/QueueMonitor';
import { WorkerStrip } from '@/components/agent-console/WorkerStrip';
import { BudgetMeter } from '@/components/agent-console/BudgetMeter';
import { RoutineControls } from '@/components/agent-console/RoutineControls';
import { RunHistory } from '@/components/agent-console/RunHistory';
import { KillSwitch } from '@/components/agent-console/KillSwitch';

/**
 * Task 120: `/agent-console` - the AI background control plane.
 *
 * Read data: `/api/admin/agent/{stats,workers,routines,runs,jobs/:id}` (task 119) and
 * `/api/agent/health` (task 130, via the shared degraded-state hook). Writes:
 * `POST /routines/:id/run-now` and `PATCH /routines/:id`.
 *
 * A failing endpoint never blanks a panel, and a disabled AI with zero workers renders an
 * explicit degraded surface (linking `docs/AI.md`) instead of empty charts.
 */
export default function AgentConsole() {
  const navigate = useNavigate();
  const data = useAgentConsoleData();
  const agentHealth = useAgentHealth();
  const health = useAiDegradedState();

  const refresh = () => {
    data.refresh();
    agentHealth.refresh();
    health.refresh();
  };

  const degradedByRoutineId: Record<string, string> = {};
  for (const routine of health.degradedRoutines) {
    if (routine.routineId) degradedByRoutineId[routine.routineId] = routine.reason;
  }

  const onlineWorkers = data.workers.filter((worker) => worker.online).length;
  const showDegraded =
    health.aiStatusKnown && !health.aiEnabled && data.workers.length === 0;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="min-h-screen pb-24"
    >
      <header className="sticky top-6 z-40 px-4 max-w-5xl mx-auto">
        <div className="glass-panel rounded-full px-6 py-3.5 flex justify-between items-center ring-1 ring-black/5 dark:ring-white/10 shadow-xs">
          <div className="flex items-center gap-4 min-w-0">
            <Button variant="ghost" size="icon" className="rounded-full shrink-0" onClick={() => navigate(-1)} aria-label="返回">
              <ArrowLeft size={20} />
            </Button>
            <div className="min-w-0">
              <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight flex items-center gap-2">
                <Bot size={20} className="text-blue-600 dark:text-blue-400" aria-hidden /> 控制台
              </h1>
              <p className="text-xs text-slate-500 dark:text-slate-400 font-medium truncate">
                控制平面 · 队列 {data.stats?.byStatus?.queued ?? 0} · worker {onlineWorkers}/{data.workers.length} 在线
                {data.lastUpdated ? ` · ${new Date(data.lastUpdated).toLocaleTimeString()}` : ''}
              </p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full min-h-11 min-w-11 shrink-0"
            onClick={refresh}
            disabled={data.loading}
            aria-label="刷新"
          >
            <RefreshCw size={20} className={data.loading ? 'animate-spin' : ''} />
          </Button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8 mt-2 space-y-6">
        <DegradedBanner state={health} />

        <KillSwitch routines={data.routines} aiEnabled={health.aiEnabled} workerCount={data.workers.length} onChanged={refresh} />

        {showDegraded ? (
          <AgentConsoleDegraded
            workerCount={data.workers.length}
            degradedReasons={health.degradedRoutines.map((routine) => routine.reason)}
          />
        ) : (
          <>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <QueueMonitor stats={data.stats} loading={data.loading} error={data.errors.stats} />
              <WorkerStrip
                workers={data.workers}
                loading={data.loading}
                error={data.errors.workers}
                staleAfterMs={agentHealth.health ? agentHealth.health.worker.staleAfterSeconds * 1000 : null}
              />
              <BudgetMeter
                stats={data.stats}
                tokens={agentHealth.health ? agentHealth.health.budget.tokens : null}
                calls={agentHealth.health ? agentHealth.health.budget.calls : null}
                month={agentHealth.health ? agentHealth.health.budget.month : null}
                loading={data.loading}
                error={data.errors.stats}
              />
              <RunHistory runs={data.runs} loading={data.loading} error={data.errors.runs} />
            </div>
          </>
        )}

        <RoutineControls
          routines={data.routines}
          loading={data.loading}
          error={data.errors.routines}
          degradedByRoutineId={degradedByRoutineId}
          onChanged={refresh}
        />
      </main>
    </motion.div>
  );
}
