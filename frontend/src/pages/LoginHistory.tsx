import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { ShieldCheck, Monitor, Smartphone, Globe, MapPin, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/layout/PageHeader';
import { EmptyState } from '@/components/ui/empty-state';
import { SkeletonCard } from '@/components/ui/skeleton-card';
import { api } from '@/lib/api';

const containerVariants = { hidden: { opacity: 0 }, visible: { opacity: 1, transition: { staggerChildren: 0.1 } } };
const itemVariants = { hidden: { opacity: 0, y: 15 }, visible: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 300, damping: 24 } as const } };

interface LoginLog {
  id: string;
  ip_address: string;
  username?: string;
  user_agent: string;
  device_fingerprint?: string;
  success: boolean;
  failure_reason?: string;
  login_time: string;
  geo?: string;
}

// Helper to get device icon
const getDeviceIcon = (userAgent: string) => {
  const ua = userAgent.toLowerCase();
  if (ua.includes('mobile') || ua.includes('iphone') || ua.includes('android')) {
    return Smartphone;
  }
  if (ua.includes('chrome') || ua.includes('firefox') || ua.includes('safari')) {
    return Monitor;
  }
  return Globe;
};

// Helper to get device name
const getDeviceName = (userAgent: string): string => {
  const ua = userAgent.toLowerCase();
  if (ua.includes('chrome')) return 'Chrome';
  if (ua.includes('firefox')) return 'Firefox';
  if (ua.includes('safari')) return 'Safari';
  if (ua.includes('edge')) return 'Edge';
  if (ua.includes('iphone')) return 'iPhone';
  if (ua.includes('android')) return 'Android';
  return 'Unknown';
};

// Helper to get OS
const getOSName = (userAgent: string): string => {
  const ua = userAgent.toLowerCase();
  if (ua.includes('windows')) return 'Windows';
  if (ua.includes('mac')) return 'macOS';
  if (ua.includes('linux')) return 'Linux';
  if (ua.includes('iphone') || ua.includes('ipad')) return 'iOS';
  if (ua.includes('android')) return 'Android';
  return 'Unknown';
};

export default function LoginHistory() {
  const [logs, setLogs] = useState<LoginLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState(false);
  const [ipFilter, setIpFilter] = useState('');

  useEffect(() => {
    fetchLogs();
  }, []);

  const fetchLogs = async () => {
    setLoading(true);
    try {
      const q = ipFilter ? `?ip=${encodeURIComponent(ipFilter)}` : '';
      const data = await api.get<LoginLog[]>(`/auth/login-history${q}`);
      setLogs(data);
    } catch (error) {
      console.error('Failed to fetch login history:', error);
      setLogs([]);
    } finally {
      setLoading(false);
    }
  };

  const clearLogs = async () => {
    if (!confirm('确定清空所有登录日志？此操作不可恢复。')) return;
    
    setClearing(true);
    try {
      await api.delete('/auth/login-history');
      setLogs([]);
      alert('登录历史已清空');
    } catch (error) {
      console.error('Failed to clear logs:', error);
      alert('清空失败，请稍后重试');
    } finally {
      setClearing(false);
    }
  };

  const formatTime = (timeStr: string) => {
    // 后端返回 ISO 8601 格式（UTC）：2026-04-10T07:11:57.000Z
    // 使用 Date 构造函数自动处理时区转换为本地时间
    const date = new Date(timeStr);
    if (isNaN(date.getTime())) {
      return timeStr;
    }
    
    const now = Date.now();
    const diff = now - date.getTime();
    
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
    if (diff < 172800000) return '昨天';
    
    // 显示完整日期时间（本地时区）
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    const hour = date.getHours().toString().padStart(2, '0');
    const minute = date.getMinutes().toString().padStart(2, '0');
    return `${year}/${month}/${day} ${hour}:${minute}`;
  };

  const getLocation = (log: LoginLog) => {
    if (log.geo) return log.geo;
    const ip = log.ip_address;
    if (!ip) return '未知';
    if (ip.startsWith('192.168') || ip.startsWith('10.') || ip.startsWith('172.')) {
      return '内网';
    }
    if (ip === '127.0.0.1' || ip === '::1') return '本地';
    return '公网';
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="min-h-screen pb-24">
      <PageHeader
        title="登录历史"
        subtitle="查看近期登录记录与设备"
        actions={
          <>
            <input className="text-xs px-2 py-1 rounded-full border bg-transparent w-24" placeholder="筛选IP" value={ipFilter} onChange={(e) => setIpFilter(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && fetchLogs()} />
            <Button variant="ghost" size="sm" className="rounded-full" onClick={() => window.open('/api/auth/login-history/export', '_blank')}>导出</Button>
            <Button variant="ghost" size="sm" className="rounded-full text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30" onClick={clearLogs} disabled={clearing || logs.length === 0}>
              <Trash2 size={16} className="mr-1" />
              清空
            </Button>
          </>
        }
        onRefresh={fetchLogs}
        refreshing={loading}
      />
      <main className="max-w-4xl mx-auto px-6 py-10 mt-2">
        {loading ? (
          <SkeletonCard count={4} />
        ) : logs.length === 0 ? (
          <EmptyState icon={ShieldCheck} title="暂无登录记录" description="您的登录历史将在此处显示" />
        ) : (
          <motion.div variants={containerVariants} initial="hidden" animate="visible" className="relative">
            <div className="absolute left-[2.25rem] top-8 bottom-8 w-px bg-gradient-to-b from-primary-500/40 via-slate-200 dark:via-slate-700 to-transparent z-0"></div>
            <div className="space-y-6 relative z-10">
              {logs.map((log) => {
                const Icon = getDeviceIcon(log.user_agent);
                const deviceName = getDeviceName(log.user_agent);
                const osName = getOSName(log.user_agent);
                
                return (
                  <motion.div key={log.id} variants={itemVariants} className="flex gap-6 items-center">
                    <div className={`w-16 h-16 rounded-[1.5rem] shrink-0 flex items-center justify-center shadow-md border backdrop-blur-md ${log.success ? 'bg-white/90 dark:bg-slate-800/90 text-primary-500 border-white/60 dark:border-white/10' : 'bg-red-50/90 dark:bg-red-900/40 text-red-600 border-red-100 dark:border-red-800/50'}`}>
                      <Icon size={26} />
                    </div>
                    <div className="glass-panel rounded-[2.5rem] p-6 flex-1 hover:shadow-xl transition-all ring-1 ring-black/5 dark:ring-white/10">
                      <div className="flex flex-col sm:flex-row justify-between sm:items-start gap-3">
                        <div>
                          <div className="flex items-center gap-3">
                            <h3 className="text-lg font-bold text-slate-900 dark:text-white font-mono tracking-tight">{log.ip_address}</h3>
                            <Badge variant={log.success ? 'success' : 'destructive'} className="scale-90">
                              {log.success ? '成功' : '失败'}
                            </Badge>
                          </div>
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mt-2 text-sm font-medium text-slate-500 dark:text-slate-400">
                            <span className="flex items-center gap-1.5">
                              <MapPin size={14} /> {getLocation(log)}
                            </span>
                            <span className="flex items-center gap-1.5">
                              {deviceName} / {osName}
                            </span>
                            {!log.success && log.failure_reason && (
                              <span className="text-red-500">{log.failure_reason}</span>
                            )}
                          </div>
                        </div>
                        <div className="text-sm font-bold text-slate-400 whitespace-nowrap bg-slate-100/50 dark:bg-slate-800/50 px-3 py-1 rounded-lg">
                          {formatTime(log.login_time)}
                        </div>
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </motion.div>
        )}
      </main>
    </motion.div>
  );
}