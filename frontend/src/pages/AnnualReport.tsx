import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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

export default function AnnualReport() {
  const navigate = useNavigate();
  const [data, setData] = useState<AnnualReportData | null>(null);

  useEffect(() => {
    api.get<AnnualReportData>('/features/annual-report').then(setData).catch(console.error);
  }, []);

  if (!data) {
    return <div className="p-8 text-center">加载中...</div>;
  }

  return (
    <div className="min-h-screen p-6 max-w-3xl mx-auto">
      <Button variant="ghost" onClick={() => navigate('/dashboard')}>← 返回</Button>
      <Card className="mt-4">
        <CardHeader>
          <CardTitle>{data.year} 年度提醒报告</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="p-4 rounded-lg bg-blue-50 dark:bg-blue-950">
              <div className="text-2xl font-bold">{data.totalEvents}</div>
              <div className="text-sm text-muted-foreground">事件总数</div>
            </div>
            <div className="p-4 rounded-lg bg-green-50 dark:bg-green-950">
              <div className="text-2xl font-bold">{data.notificationsSuccess}</div>
              <div className="text-sm text-muted-foreground">成功通知</div>
            </div>
            <div className="p-4 rounded-lg bg-amber-50 dark:bg-amber-950">
              <div className="text-2xl font-bold">{data.notificationsSent}</div>
              <div className="text-sm text-muted-foreground">通知总计</div>
            </div>
            <div className="p-4 rounded-lg bg-purple-50 dark:bg-purple-950">
              <div className="text-2xl font-bold">{data.activeChannels}</div>
              <div className="text-sm text-muted-foreground">活跃渠道</div>
            </div>
          </div>
          {data.eventsByType.length > 0 && (
            <div>
              <h3 className="font-medium mb-2">事件类型分布</h3>
              <ul className="space-y-1">
                {data.eventsByType.map((row) => (
                  <li key={row.type} className="flex justify-between text-sm">
                    <span>{row.type}</span>
                    <span>{row.count}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
