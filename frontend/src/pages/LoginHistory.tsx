import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ArrowLeft, RefreshCw, Shield, Monitor } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

interface LoginLog {
  id: string;
  login_time: string;
  ip_address: string;
  user_agent: string;
  status: 'success' | 'failed';
}

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.05 }
  }
};

const itemVariants = {
  hidden: { opacity: 0, x: -20 },
  visible: { opacity: 1, x: 0 }
};

export default function LoginHistory() {
  const navigate = useNavigate();
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
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-purple-50 to-pink-50 p-6">
      <div className="container mx-auto max-w-7xl">
        <motion.div
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          className="flex items-center justify-between mb-8"
        >
          <div className="flex items-center gap-4">
            <Button
              variant="ghost"
              onClick={() => navigate('/settings')}
              className="rounded-full hover:bg-white/60"
            >
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div>
              <h1 className="text-3xl font-bold bg-gradient-to-r from-gray-900 to-gray-600 bg-clip-text text-transparent">登录历史</h1>
              <p className="text-sm text-gray-500 mt-1">共 {logs.length} 条记录</p>
            </div>
          </div>
          <Button onClick={fetchLogs} disabled={loading} className="h-10">
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            {loading ? '加载中...' : '刷新'}
          </Button>
        </motion.div>

      <Card className="overflow-hidden">
        {error && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="p-4 bg-red-50 border-b border-red-200 text-red-700 text-sm flex items-center gap-2"
          >
            <Shield className="h-4 w-4" />
            {error}
          </motion.div>
        )}
        {loading ? (
          <div className="p-6 space-y-3">
            {[...Array(6)].map((_, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: i * 0.05 }}
                className="h-14 bg-muted rounded-lg animate-pulse"
              />
            ))}
          </div>
        ) : logs.length === 0 ? (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="py-20 text-center"
          >
            <Shield className="h-12 w-12 mx-auto text-gray-300 mb-3" />
            <p className="text-muted-foreground">暂无登录记录</p>
          </motion.div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gradient-to-r from-gray-50 to-gray-100 border-b">
                <tr>
                  <th className="px-6 py-4 text-left text-xs font-semibold text-gray-600">时间</th>
                  <th className="px-6 py-4 text-left text-xs font-semibold text-gray-600">IP地址</th>
                  <th className="px-6 py-4 text-left text-xs font-semibold text-gray-600">设备</th>
                  <th className="px-6 py-4 text-left text-xs font-semibold text-gray-600">状态</th>
                </tr>
              </thead>
              <motion.tbody
                variants={containerVariants}
                initial="hidden"
                animate="visible"
                className="divide-y"
              >
                {logs.map((log) => (
                  <motion.tr
                    key={log.id}
                    variants={itemVariants}
                    className="hover:bg-blue-50/50 transition-colors"
                  >
                    <td className="px-6 py-4 font-medium">{new Date(log.login_time).toLocaleString('zh-CN')}</td>
                    <td className="px-6 py-4 text-gray-600">{log.ip_address}</td>
                    <td className="px-6 py-4 text-gray-500 max-w-xs truncate flex items-center gap-2">
                      <Monitor className="h-4 w-4 flex-shrink-0" />
                      {log.user_agent}
                    </td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${
                        log.status === 'success' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                      }`}>
                        {log.status === 'success' ? '✓ 成功' : '✗ 失败'}
                      </span>
                    </td>
                  </motion.tr>
                ))}
              </motion.tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
