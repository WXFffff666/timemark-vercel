import { useCallback, useEffect, useState } from 'react';
import { Archive, ChevronDown, Database, Loader2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';

/**
 * v2.26 批次 B：数据管理卡（设置页「安全与数据」）。
 *
 * 展示日志保留策略（与 nightly 清理同一来源）、上一次清理状态，支持手动
 * 「立即清理」；下方列出 digest_archive 里的 AI 月报归档——原始触发日志
 * 90 天后清掉，AI 提炼的月报在这里永久留存。
 */

type RetentionData = {
  policy: Record<string, number>;
  archives: Array<{
    id: number;
    period: string;
    period_start: string;
    period_end: string;
    narrative_preview: string | null;
    stats: Record<string, unknown> | null;
    created_at: string;
  }>;
  lastPurge: { status: string; updatedAt: string } | null;
};

const POLICY_LABELS: Array<[string, string]> = [
  ['eventTriggerLogs', '触发日志'],
  ['emailLogs', '邮件日志'],
  ['loginAttempts', '登录尝试'],
  ['notificationQueue', '通知队列'],
  ['agentAuditLogs', 'Agent 审计'],
  ['reminderSendClaims', '发送认领'],
  ['schedulerTicks', '调度 tick'],
  ['securityEvents', '安全事件'],
  ['auditLogs', '审计日志'],
  ['cronExecutionLogs', 'Cron 失败明细'],
  ['greetingHistory', '祝福历史'],
];

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('zh-CN');
}

export function DataManagement() {
  const [data, setData] = useState<RetentionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [purging, setPurging] = useState(false);
  const [purgeResult, setPurgeResult] = useState<string | null>(null);
  const [showArchives, setShowArchives] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<RetentionData>('/retention');
      setData(res);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const purgeNow = async () => {
    if (!confirm('立即清理所有已过期日志？此操作不可恢复。')) return;
    setPurging(true);
    setPurgeResult(null);
    try {
      const res = await api.post<Record<string, number>>('/retention/purge-now');
      const counts = Object.entries(res ?? {});
      const total = counts.reduce((sum, [, n]) => sum + (typeof n === 'number' ? n : 0), 0);
      setPurgeResult(total > 0 ? `已清理 ${total} 条过期记录` : '没有需要清理的过期记录');
      void load();
    } catch (e) {
      setPurgeResult(e instanceof Error ? e.message : '清理失败');
    } finally {
      setPurging(false);
    }
  };

  const archives = data?.archives ?? [];

  return (
    <div className="flex items-start justify-between p-4 rounded-[2rem]">
      <div className="flex items-start gap-4 flex-1 min-w-0">
        <div className="w-11 h-11 shrink-0 rounded-2xl bg-teal-50 dark:bg-teal-900/30 text-teal-600 flex items-center justify-center shadow-inner border border-teal-100 dark:border-teal-800/50">
          <Database size={22} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-bold text-slate-900 dark:text-white">数据管理</h3>
          <p className="text-xs text-slate-500 mt-0.5">
            {loading ? (
              '加载保留策略…'
            ) : data ? (
              <>
                日志保留 90–180 天自动清理
                {data.lastPurge ? (
                  <>
                    {' · '}上次清理{' '}
                    {formatDate(data.lastPurge.updatedAt)}
                    {data.lastPurge.status !== 'success' ? '（异常）' : ''}
                  </>
                ) : null}
              </>
            ) : (
              '日志到期自动清理，无需手动维护'
            )}
          </p>

          {purgeResult && (
            <p className="text-xs text-teal-600 dark:text-teal-400 mt-1">{purgeResult}</p>
          )}

          {archives.length > 0 && (
            <div className="mt-3">
              <button
                type="button"
                className="flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-indigo-500"
                onClick={() => setShowArchives((v) => !v)}
              >
                <Archive size={13} />
                AI 月报归档（{archives.length} 份）
                <ChevronDown
                  size={13}
                  className={`transition-transform ${showArchives ? 'rotate-180' : ''}`}
                />
              </button>
              {showArchives && (
                <ul className="mt-2 space-y-2 max-h-64 overflow-y-auto overscroll-contain pr-1">
                  {archives.map((a) => (
                    <li
                      key={a.id}
                      className="rounded-xl border border-slate-200/70 dark:border-slate-700/50 p-3 text-xs"
                    >
                      <p className="font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
                        <Sparkles size={12} className="text-amber-500" />
                        {a.period === 'yearly' ? '年度' : '月度'} · {formatDate(a.period_start)} ~{' '}
                        {formatDate(a.period_end)}
                      </p>
                      {a.narrative_preview && (
                        <p className="mt-1 text-slate-500 dark:text-slate-400 line-clamp-3 whitespace-pre-line">
                          {a.narrative_preview}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="mt-3">
            <Button variant="secondary" size="sm" className="min-h-11" disabled={purging} onClick={purgeNow}>
              {purging ? (
                <>
                  <Loader2 size={14} className="animate-spin mr-1" /> 清理中…
                </>
              ) : (
                '立即清理'
              )}
            </Button>
          </div>

          {data && (
            <details className="mt-3 text-xs text-slate-500">
              <summary className="cursor-pointer select-none">查看保留策略明细</summary>
              <ul className="mt-2 space-y-1">
                {POLICY_LABELS.filter(([key]) => typeof data.policy[key] === 'number').map(
                  ([key, label]) => (
                    <li key={key}>
                      {label}：{data.policy[key]} 天
                    </li>
                  ),
                )}
              </ul>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}
