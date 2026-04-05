import { motion } from 'framer-motion';
import { ShieldCheck, Monitor, Smartphone, Globe, MapPin, ArrowLeft } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useNavigate } from 'react-router-dom';

const containerVariants = { hidden: { opacity: 0 }, visible: { opacity: 1, transition: { staggerChildren: 0.1 } } };
const itemVariants = { hidden: { opacity: 0, y: 15 }, visible: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 300, damping: 24 } } };

export default function LoginHistory() {
  const navigate = useNavigate();
  const logs =[
    { id: 1, ip: '192.168.1.100', location: '内网', device: 'Chrome / Windows', time: '刚刚', status: 'success', icon: Monitor },
    { id: 2, ip: '113.89.23.45', location: '广东深圳', device: 'Safari / iPhone', time: '3小时前', status: 'success', icon: Smartphone },
    { id: 3, ip: '45.33.12.9', location: '美国洛杉矶', device: 'Unknown', time: '昨天 02:30', status: 'blocked', icon: Globe },
  ];

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="min-h-screen pb-24">
      <header className="sticky top-4 z-50 px-4 max-w-4xl mx-auto">
        <div className="glass-panel rounded-full px-6 py-4 flex justify-between items-center ring-1 ring-white/20 dark:ring-white/10">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" className="rounded-full" onClick={() => navigate(-1)}><ArrowLeft size={20} /></Button>
            <div><h1 className="text-xl font-bold text-gray-900 dark:text-white tracking-tight">登录历史</h1></div>
          </div>
          <div className="w-10 h-10 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-500 flex items-center justify-center"><ShieldCheck size={20} /></div>
        </div>
      </header>
      <main className="max-w-4xl mx-auto px-6 py-8 mt-4">
        <motion.div variants={containerVariants} initial="hidden" animate="visible" className="relative">
          <div className="absolute left-8 top-8 bottom-8 w-px bg-gradient-to-b from-primary-500/50 via-gray-300 dark:via-gray-700 to-transparent z-0"></div>
          <div className="space-y-6 relative z-10">
            {logs.map((log) => {
              const Icon = log.icon;
              return (
                <motion.div key={log.id} variants={itemVariants} className="flex gap-6 items-center">
                  <div className={`w-16 h-16 rounded-3xl shrink-0 flex items-center justify-center shadow-lg border border-white/20 dark:border-white/5 backdrop-blur-md ${log.status === 'success' ? 'bg-white/80 dark:bg-gray-800/80 text-primary-500' : 'bg-red-50 dark:bg-red-900/30 text-red-500'}`}><Icon size={28} /></div>
                  <div className="glass-panel rounded-3xl p-5 flex-1 hover:shadow-xl transition-all">
                    <div className="flex justify-between items-start">
                      <div>
                        <div className="flex items-center gap-3">
                          <h3 className="text-lg font-bold text-gray-900 dark:text-white font-mono">{log.ip}</h3>
                          <Badge variant={log.status === 'success' ? 'success' : 'destructive'} className="scale-90">{log.status === 'success' ? '登录成功' : '已拦截'}</Badge>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mt-2 text-sm text-gray-500 dark:text-gray-400">
                          <span className="flex items-center gap-1"><MapPin size={14} /> {log.location}</span>
                          <span className="flex items-center gap-1">设备: {log.device}</span>
                        </div>
                      </div>
                      <div className="text-sm font-medium text-gray-400 whitespace-nowrap">{log.time}</div>
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </div>
        </motion.div>
      </main>
    </motion.div>
  );
}
