import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { BarChart3, Bell, Calendar, Database, Radio } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/layout/PageHeader';
import { EmptyState } from '@/components/ui/empty-state';
import { api } from '@/lib/api';

interface StatsData {
  totalEvents: number;
  activeEvents: number;
  triggerStats: Array<{ status: string; count: string | number }>;
  channelUsage: Array<{ type: string; count: string | number }>;
  monthlyTriggers: Array<{ month: string; status: string; count: number }>;
  eventsByType: Array<{ type: string; count: number }>;
  /** v2.31 R2（F61）：后台 AI 运行观测（checkbox 130 数据此前全站无消费者） */
  agent?: {
    recentRuns: Array<{ jobId: string; at: string; kind: string | null; tier: string | null; tokens: number; costUsd: number; outcome: string | null }>;
    ledger: {
      days: Array<{ day: string; runs: number; tokens: number; costUsd: number }>;
      month: { month: string; runs: number; tokens: number; costUsd: number } | null;
      projection: { month: string | null; daysElapsed: number; daysInMonth: number; basis: string } | null;
    };
    degradedLast24h: number;
  };
}

interface DailyStatsRow {
  day: string;
  events_count: number;
  triggers_total: number;
  triggers_success: number;
  triggers_failed: number;
}

const PIE_COLORS = ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#06b6d4'];

export default function Analytics() {
  const navigate = useNavigate();
  const [stats, setStats] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);
  // v2.31 R2（F60）：日粒度切换
  const [dailyRange, setDailyRange] = useState<7 | 30 | 90>(30);
  const [daily, setDaily] = useState<DailyStatsRow[]>([]);
  // v2.41 R22：生活域概览（quick-counts 六域计数）
  const [lifeCounts, setLifeCounts] = useState<{ contacts: number; inventory: number; maintenance: number; goals: number; habits: number; expiry: number } | null>(null);

  useEffect(() => {
    api.get<StatsData>('/stats')
      .then(setStats)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    api.get<{ contacts: number; inventory: number; maintenance: number; goals: number; habits: number; expiry: number }>('/stats/quick-counts')
      .then(setLifeCounts)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.get<DailyStatsRow[]>(`/stats/daily?days=${dailyRange}`)
      .then((rows) => { if (!cancelled) setDaily(Array.isArray(rows) ? rows : []); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [dailyRange]);

  const dailyChartData = useMemo(
    () => [...daily].reverse().map((r) => ({ day: r.day.slice(5), success: r.triggers_success, failed: r.triggers_failed })),
    [daily],
  );

  // v2.41 R22：生活域概览数据（count 未加载时显示 — 占位不渲染）
  const lifeDomains = useMemo(() => {
    if (lifeCounts === null) return null;
    return [
      { label: '联系人', count: lifeCounts.contacts, href: '/contacts' },
      { label: '物品', count: lifeCounts.inventory, href: '/inventory' },
      { label: '保养计划', count: lifeCounts.maintenance, href: '/maintenance' },
      { label: '进行中目标', count: lifeCounts.goals, href: '/goals' },
      { label: '活跃习惯', count: lifeCounts.habits, href: '/habits' },
      { label: '到期项目', count: lifeCounts.expiry, href: '/expiry' },
    ];
  }, [lifeCounts]);

  const monthlyChartData = useMemo(() => {
    if (!stats?.monthlyTriggers?.length) return [];
    const map = new Map<string, { month: string; success: number; failed: number }>();
    for (const row of stats.monthlyTriggers) {
      const entry = map.get(row.month) ?? { month: row.month, success: 0, failed: 0 };
      if (row.status === 'success') entry.success += row.count;
      else entry.failed += row.count;
      map.set(row.month, entry);
    }
    return Array.from(map.values());
  }, [stats]);

  const triggerSummary = useMemo(() => {
    const success = stats?.triggerStats?.find((s) => s.status === 'success')?.count ?? 0;
    const failed = stats?.triggerStats?.find((s) => s.status === 'failed')?.count ?? 0;
    return { success: Number(success), failed: Number(failed) };
  }, [stats]);

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center text-slate-500 dark:text-slate-400">加载统计数据...</div>;
  }

  if (!stats) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4">
        <p className="text-slate-500 dark:text-slate-400">无法加载统计数据</p>
        <Button onClick={() => navigate('/dashboard')}>返回首页</Button>
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-24">
      <PageHeader title="数据看板" subtitle="近 30 天提醒与事件概览" backTo="/dashboard" maxWidth="max-w-5xl" />

      <main className="max-w-5xl mx-auto px-4 mt-8 space-y-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card className="glass-panel border-0">
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <Calendar className="text-blue-500" size={22} />
                <div>
                  <p className="text-2xl font-bold">{stats.totalEvents}</p>
                  <p className="text-xs text-muted-foreground">事件总数</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="glass-panel border-0">
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <Bell className="text-emerald-500" size={22} />
                <div>
                  <p className="text-2xl font-bold">{stats.activeEvents}</p>
                  <p className="text-xs text-muted-foreground">活跃事件</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="glass-panel border-0">
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <BarChart3 className="text-violet-500" size={22} />
                <div>
                  <p className="text-2xl font-bold">{triggerSummary.success}</p>
                  <p className="text-xs text-muted-foreground">30天成功通知</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="glass-panel border-0">
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <Radio className="text-amber-500" size={22} />
                <div>
                  <p className="text-2xl font-bold">{stats.channelUsage.length}</p>
                  <p className="text-xs text-muted-foreground">活跃渠道</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* v2.41 R22：生活域概览——quick-counts 六域计数 + 管理跳转（NN/g 空态引导的落地形态） */}
        <Card className="glass-panel border-0">
          <CardHeader>
            <CardTitle className="text-base">生活域概览</CardTitle>
          </CardHeader>
          <CardContent>
            {lifeDomains === null ? (
              <p className="text-sm text-muted-foreground">正在统计…</p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {lifeDomains.map((d) => (
                  <a
                    key={d.label}
                    href={d.href}
                    className="rounded-2xl border border-slate-200/70 dark:border-slate-700/50 px-4 py-3 hover:border-primary-400 hover:bg-primary-500/5 transition-colors"
                  >
                    <p className="text-xl font-bold text-slate-800 dark:text-slate-100">{d.count}</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">{d.label}</p>
                  </a>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <div className="grid md:grid-cols-2 gap-6">
          <Card className="glass-panel border-0">
            <CardHeader>
              <CardTitle className="text-base">月度通知趋势</CardTitle>
            </CardHeader>
            <CardContent>
              {monthlyChartData.length === 0 ? (
                <EmptyState icon={Bell} title="暂无通知记录" />
              ) : (
                <div className="h-[260px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={monthlyChartData}>
                      <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                      <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                      <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                      <Tooltip />
                      <Legend />
                      <Bar dataKey="success" name="成功" fill="#10b981" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="failed" name="失败" fill="#ef4444" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>

          {/* v2.31 R2（F60）：日粒度趋势——stats_daily 此前只有外部 API 能看 */}
          <Card className="glass-panel border-0">
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-base">每日通知趋势</CardTitle>
                <div className="flex gap-1" role="group" aria-label="时间范围">
                  {([7, 30, 90] as const).map((d) => (
                    <Button
                      key={d}
                      size="sm"
                      variant={dailyRange === d ? 'default' : 'outline'}
                      className="rounded-full h-7 px-2.5 text-xs"
                      aria-pressed={dailyRange === d}
                      onClick={() => setDailyRange(d)}
                    >
                      {d} 天
                    </Button>
                  ))}
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {dailyChartData.length === 0 ? (
                <EmptyState icon={Bell} title="暂无日粒度数据" description="每日统计由定时任务聚合生成，运行几天后可见" />
              ) : (
                <div className="h-[260px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={dailyChartData}>
                      <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                      <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                      <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                      <Tooltip />
                      <Legend />
                      <Bar dataKey="success" name="成功" fill="#10b981" radius={[3, 3, 0, 0]} />
                      <Bar dataKey="failed" name="失败" fill="#ef4444" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="glass-panel border-0">
            <CardHeader>
              <CardTitle className="text-base">事件类型分布</CardTitle>
            </CardHeader>
            <CardContent>
              {stats.eventsByType.length === 0 ? (
                <EmptyState icon={Database} title="暂无事件数据" />
              ) : (
                <div className="h-[260px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={stats.eventsByType}
                        dataKey="count"
                        nameKey="type"
                        cx="50%"
                        cy="50%"
                        outerRadius={90}
                        label={({ name, value }) => `${name}: ${value}`}
                      >
                        {stats.eventsByType.map((_, i) => (
                          <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* v2.31 R2（F61）：后台 AI 运行与成本——checkbox 130 的观测数据此前全站无消费者 */}
        {stats.agent && (stats.agent.recentRuns.length > 0 || stats.agent.ledger.month) && (
          <Card className="glass-panel border-0">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Radio className="text-purple-500" size={18} aria-hidden /> 后台 AI 运行与成本
                {stats.agent.degradedLast24h > 0 && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-amber-50 text-amber-600 dark:bg-amber-900/30 dark:text-amber-300">
                    24h 降级 {stats.agent.degradedLast24h} 次
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {stats.agent.ledger.month && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                  <div className="rounded-xl border border-slate-200/70 dark:border-slate-700/50 px-3 py-2">
                    <p className="text-xs text-slate-400">本月运行</p>
                    <p className="text-lg font-bold tabular-nums">{stats.agent.ledger.month.runs}</p>
                  </div>
                  <div className="rounded-xl border border-slate-200/70 dark:border-slate-700/50 px-3 py-2">
                    <p className="text-xs text-slate-400">本月 tokens</p>
                    <p className="text-lg font-bold tabular-nums">{stats.agent.ledger.month.tokens.toLocaleString()}</p>
                  </div>
                  <div className="rounded-xl border border-slate-200/70 dark:border-slate-700/50 px-3 py-2">
                    <p className="text-xs text-slate-400">本月成本</p>
                    <p className="text-lg font-bold tabular-nums">${stats.agent.ledger.month.costUsd.toFixed(3)}</p>
                  </div>
                  <div className="rounded-xl border border-slate-200/70 dark:border-slate-700/50 px-3 py-2">
                    <p className="text-xs text-slate-400">月末预估</p>
                    <p className="text-lg font-bold tabular-nums">
                      {stats.agent.ledger.projection
                        ? `$${((stats.agent.ledger.month.costUsd / Math.max(1, stats.agent.ledger.projection.daysElapsed)) * stats.agent.ledger.projection.daysInMonth).toFixed(3)}`
                        : '—'}
                    </p>
                  </div>
                </div>
              )}
              {stats.agent.recentRuns.length > 0 && (
                <ul className="space-y-1.5 text-xs">
                  {stats.agent.recentRuns.slice(0, 5).map((run) => (
                    <li key={run.jobId} className="flex items-center gap-2 rounded-lg border border-slate-100 dark:border-slate-800 px-3 py-1.5">
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${run.outcome === 'success' ? 'bg-emerald-500' : run.outcome === 'skipped' ? 'bg-slate-400' : 'bg-red-500'}`} aria-hidden />
                      <span className="font-medium text-slate-700 dark:text-slate-200 truncate">{run.kind ?? '未知例程'}</span>
                      <span className="text-slate-400 ml-auto shrink-0 tabular-nums">
                        {run.tokens.toLocaleString()} tok · ${run.costUsd.toFixed(4)} · {new Date(run.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        )}

        {stats.channelUsage.length > 0 && (
          <Card className="glass-panel border-0">
            <CardHeader>
              <CardTitle className="text-base">渠道使用分布</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-[220px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={stats.channelUsage.map((c) => ({ type: c.type, count: Number(c.count) }))} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                    <XAxis type="number" allowDecimals={false} />
                    <YAxis type="category" dataKey="type" width={100} tick={{ fontSize: 12 }} />
                    <Tooltip />
                    <Bar dataKey="count" name="账户数" fill="#6366f1" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}
