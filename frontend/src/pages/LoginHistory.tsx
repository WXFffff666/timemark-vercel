import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';

interface LoginLog {
  id: string;
  login_time: string;
  ip_address: string;
  user_agent: string;
  status: 'success' | 'failed';
}

export default function LoginHistory() {
  const [logs, setLogs] = useState<LoginLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchLogs = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<LoginLog[]>('/auth/session-history');
      setLogs(data || []);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to fetch login history';
      setError(message);
      console.error('Failed to fetch login history:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs();
  }, []);

  return (
    <div className="container mx-auto p-6 max-w-7xl">
      <div className="mb-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">登录历史</h1>
            <p className="text-sm text-muted-foreground mt-0.5">共 {logs.length} 条记录</p>
          </div>
          <Button onClick={fetchLogs} disabled={loading}>
            {loading ? '加载中...' : '刷新'}
          </Button>
        </div>
      </div>

      <div className="bg-card rounded-xl border">
        {error && (
          <div className="p-4 bg-red-50 border-b border-red-200 text-red-700 text-sm">
            {error}
          </div>
        )}
        {loading ? (
          <div className="p-6 space-y-3">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-14 bg-muted rounded animate-pulse" />
            ))}
          </div>
        ) : logs.length === 0 ? (
          <div className="py-16 text-center">
            <p className="text-muted-foreground text-sm">暂无登录记录</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 border-b">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">时间</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">IP地址</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">设备</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">状态</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {logs.map((log) => (
                  <tr key={log.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3">{new Date(log.login_time).toLocaleString('zh-CN')}</td>
                    <td className="px-4 py-3">{log.ip_address}</td>
                    <td className="px-4 py-3 text-muted-foreground max-w-xs truncate">{log.user_agent}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded text-xs ${
                        log.status === 'success' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                      }`}>
                        {log.status === 'success' ? '成功' : '失败'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
