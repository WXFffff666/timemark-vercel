import { useEffect, useMemo, useState } from 'react';

import { useNavigate, useSearchParams } from 'react-router-dom';

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

import { Button } from '@/components/ui/button';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

import { api } from '@/lib/api';



interface MonthlyHeatmapItem {

  month: number;

  count: number;

}



interface AnnualReportData {

  year: number;

  totalEvents: number;

  notificationsSent: number;

  notificationsSuccess: number;

  notificationsFailed: number;

  activeChannels: number;

  eventsByType: Array<{ type: string; count: number }>;

  monthlyHeatmap: MonthlyHeatmapItem[];

}



const PIE_COLORS = ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444'];

const MONTH_LABELS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];



function heatColor(count: number, max: number): string {

  if (count <= 0) return '#e2e8f0';

  const ratio = max > 0 ? count / max : 0;

  if (ratio > 0.75) return '#1d4ed8';

  if (ratio > 0.5) return '#3b82f6';

  if (ratio > 0.25) return '#93c5fd';

  return '#bfdbfe';

}



export default function AnnualReport() {

  const navigate = useNavigate();

  const [searchParams, setSearchParams] = useSearchParams();

  const currentYear = new Date().getFullYear();

  const yearParam = parseInt(searchParams.get('year') || String(currentYear), 10);

  const [year, setYear] = useState(Number.isFinite(yearParam) ? yearParam : currentYear);

  const [data, setData] = useState<AnnualReportData | null>(null);

  const [loading, setLoading] = useState(true);



  useEffect(() => {

    setLoading(true);

    api.get<AnnualReportData>(`/features/annual-report?year=${year}`)

      .then(setData)

      .catch(console.error)

      .finally(() => setLoading(false));

  }, [year]);



  const heatmapChartData = useMemo(() => {

    if (!data?.monthlyHeatmap?.length) return [];

    return data.monthlyHeatmap.map((item) => ({

      month: MONTH_LABELS[item.month - 1] || `${item.month}月`,

      count: item.count,

    }));

  }, [data]);



  const maxHeat = useMemo(

    () => Math.max(...(data?.monthlyHeatmap?.map((h) => h.count) ?? [0]), 1),

    [data],

  );



  const handleYearChange = (nextYear: number) => {

    setYear(nextYear);

    setSearchParams({ year: String(nextYear) });

  };



  if (loading || !data) {

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

      <div className="flex flex-wrap gap-2 items-center justify-between">

        <Button variant="ghost" onClick={() => navigate('/dashboard')}>← 返回</Button>

        <div className="flex gap-2 items-center">

          <select

            value={year}

            onChange={(e) => handleYearChange(parseInt(e.target.value, 10))}

            className="h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm"

          >

            {Array.from({ length: 5 }, (_, i) => currentYear - i).map((y) => (

              <option key={y} value={y}>{y} 年</option>

            ))}

          </select>

          <Button variant="outline" onClick={() => window.print()}>导出 PDF</Button>

        </div>

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



          {heatmapChartData.length > 0 && (

            <div>

              <h3 className="font-medium mb-3">月度事件热力（{data.year}）</h3>

              <div className="h-[240px] mb-4">

                <ResponsiveContainer width="100%" height="100%">

                  <BarChart data={heatmapChartData}>

                    <CartesianGrid strokeDasharray="3 3" opacity={0.2} />

                    <XAxis dataKey="month" tick={{ fontSize: 12 }} />

                    <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />

                    <Tooltip />

                    <Bar dataKey="count" name="事件数" radius={[4, 4, 0, 0]}>

                      {heatmapChartData.map((entry, i) => (

                        <Cell key={i} fill={heatColor(entry.count, maxHeat)} />

                      ))}

                    </Bar>

                  </BarChart>

                </ResponsiveContainer>

              </div>

              <div className="grid grid-cols-6 sm:grid-cols-12 gap-1">

                {data.monthlyHeatmap.map((item) => (

                  <div

                    key={item.month}

                    className="aspect-square rounded-md flex flex-col items-center justify-center text-xs"

                    style={{ backgroundColor: heatColor(item.count, maxHeat) }}

                    title={`${item.month}月: ${item.count} 个事件`}

                  >

                    <span className="font-medium text-slate-700 dark:text-slate-200">{item.month}</span>

                    <span className="text-[10px] text-slate-600 dark:text-slate-300">{item.count}</span>

                  </div>

                ))}

              </div>

            </div>

          )}



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

