import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';

interface AnnualReportData {
  year: number;
  totalEvents: number;
  notificationsSent: number;
  notificationsSuccess: number;
  notificationsFailed: number;
  activeChannels: number;
  eventsByType: Array<{ type: string; count: number }>;
}

const PIE_COLORS = ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444'];

export default function AnnualReport() {
  const navigate = useNavigate();
  const [data, setData] = useState<AnnualReportData | null>(null);

  useEffect(() => {
    api.get<AnnualReportData>('/features/annual-report').then(setData).catch(console.error);
  }, []);

  if (!data) {
    return <div className="p-8 text-center">加载中...</div>;
  }

  const successRate = data.notificationsSent > 0
    ? Math.round((data.notificationsSuccess / data.notificationsSent) * 100)
    : 0;

  const notificationPie = [
    { name: '成功', value: data.notificationsSuccess },
    { name: '失败', value: data.notificationsFailed },
  ].filter((d) => d.value > 0);

  return (
    <div className="min-h-screen p-6 max-w-4xl mx-auto">
      <div className="flex gap-2">
        <Button variant="ghost" onClick={() => navigate('/dashboard')}>← 返回</Button>
        <Button variant="outline" onClick={() => window.print()}>导出 PDF</Button>
      </div>
      <Card className="mt-4 glass-panel border-0">
        <CardHeader>
          <CardTitle>{data.year} 年度提醒报告</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="p-4 rounded-lg bg-blue-50 dark:bg-blue-950">
              <div className="text-2xl font-bold">{data.totalEvents}</div>
              <div className="text-sm text-muted-foreground">事件总数</div>
            </div>
            <div className="p-4 rounded-lg bg-green-50 dark:bg-green-950">
              <div className="text-2xl font-bold">{data.notificationsSuccess}</div>
              <div className="text-sm text-muted-foreground">成功通知</div>
            </div>
            <div className="p-4 rounded-lg bg-amber-50 dark:bg-amber-950">
              <div className="text-2xl font-bold">{successRate}%</div>
              <div className="text-sm text-muted-foreground">通知成功率</div>
            </div>
            <div className="p-4 rounded-lg bg-purple-50 dark:bg-purple-950">
              <div className="text-2xl font-bold">{data.activeChannels}</div>
              <div className="text-sm text-muted-foreground">活跃渠道</div>
            </div>
          </div>

          <div className="grid md:grid-cols-2 gap-6">
            {notificationPie.length > 0 && (
              <div>
                <h3 className="font-medium mb-3">通知结果分布</h3>
                <div className="h-[220px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={notificationPie} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} label>
                        {notificationPie.map((_, i) => (
                          <Cell key={i} fill={i === 0 ? '#10b981' : '#ef4444'} />
                        ))}
                      </Pie>
                      <Tooltip />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {data.eventsByType.length > 0 && (
              <div>
                <h3 className="font-medium mb-3">事件类型分布</h3>
                <div className="h-[220px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={data.eventsByType} dataKey="count" nameKey="type" cx="50%" cy="50%" outerRadius={80} label={({ type, count }) => `${type}: ${count}`}>
                        {data.eventsByType.map((_, i) => (
                          <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
