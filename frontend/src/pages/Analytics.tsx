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
import { ArrowLeft, BarChart3, Bell, Calendar, Radio } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';

interface StatsData {
  totalEvents: number;
  activeEvents: number;
  triggerStats: Array<{ status: string; count: string | number }>;
  channelUsage: Array<{ type: string; count: string | number }>;
  monthlyTriggers: Array<{ month: string; status: string; count: number }>;
  eventsByType: Array<{ type: string; count: number }>;
}

const PIE_COLORS = ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#06b6d4'];

export default function Analytics() {
  const navigate = useNavigate();
  const [stats, setStats] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<StatsData>('/stats')
      .then(setStats)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

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
    return <div className="min-h-screen flex items-center justify-center text-slate-500">加载统计数据...</div>;
  }

  if (!stats) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4">
        <p className="text-slate-500">无法加载统计数据</p>
        <Button onClick={() => navigate('/dashboard')}>返回首页</Button>
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-24">
      <header className="sticky top-6 z-40 px-4 max-w-5xl mx-auto">
        <div className="glass-panel rounded-full px-6 py-3.5 flex justify-between items-center ring-1 ring-black/5 dark:ring-white/10 shadow-sm">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" className="rounded-full" onClick={() => navigate('/dashboard')}>
              <ArrowLeft size={20} />
            </Button>
            <div>
              <h1 className="text-lg font-bold flex items-center gap-2">
                <BarChart3 size={20} className="text-indigo-500" />
                数据看板
              </h1>
              <p className="text-xs text-slate-500">近 30 天提醒与事件概览</p>
            </div>
          </div>
        </div>
      </header>

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

        <div className="grid md:grid-cols-2 gap-6">
          <Card className="glass-panel border-0">
            <CardHeader>
              <CardTitle className="text-base">月度通知趋势</CardTitle>
            </CardHeader>
            <CardContent>
              {monthlyChartData.length === 0 ? (
                <p className="text-sm text-slate-500 text-center py-12">暂无通知记录</p>
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

          <Card className="glass-panel border-0">
            <CardHeader>
              <CardTitle className="text-base">事件类型分布</CardTitle>
            </CardHeader>
            <CardContent>
              {stats.eventsByType.length === 0 ? (
                <p className="text-sm text-slate-500 text-center py-12">暂无事件数据</p>
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
                        label={({ type, count }) => `${type}: ${count}`}
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
